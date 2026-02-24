package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	mcpruntime "github.com/theory-cloud/apptheory/runtime/mcp"
	"github.com/theory-cloud/apptheory/testkit"
)

func TestClient_RawStream_AndResumeStream(t *testing.T) {
	env := testkit.New()
	s := mcpruntime.NewServer("test-server", "dev", mcpruntime.WithServerIDGenerator(env.IDs))

	firstEmitted := make(chan struct{})
	continueTool := make(chan struct{})

	if err := s.Registry().RegisterStreamingTool(
		mcpruntime.ToolDef{
			Name:        "slow_tool",
			Description: "Emits progress then blocks",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(ctx context.Context, _ json.RawMessage, emit func(mcpruntime.SSEEvent)) (*mcpruntime.ToolResult, error) {
			emit(mcpruntime.SSEEvent{Data: map[string]any{"seq": 1}})
			close(firstEmitted)

			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-continueTool:
			}

			emit(mcpruntime.SSEEvent{Data: map[string]any{"seq": 2}})
			return &mcpruntime.ToolResult{Content: []mcpruntime.ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	client := NewClient(s, env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	params := map[string]any{
		"name":      "slow_tool",
		"arguments": json.RawMessage(`{}`),
		"_meta":     map[string]any{"progressToken": "pt-123"},
	}
	paramsBytes, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}

	req := &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "tools/call",
		Params:  paramsBytes,
	}

	stream, err := client.RawStream(context.Background(), req, nil)
	if err != nil {
		t.Fatalf("RawStream: %v", err)
	}

	select {
	case <-firstEmitted:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first progress emission")
	}

	first, err := stream.Next()
	if err != nil {
		t.Fatalf("read first SSE message: %v", err)
	}
	if strings.TrimSpace(first.ID) == "" {
		t.Fatalf("expected SSE id to be set")
	}
	if got := strings.TrimSpace(first.Event); got != "message" {
		t.Fatalf("expected SSE event=message, got %q", got)
	}
	if !strings.Contains(string(first.Data), `"method":"notifications/progress"`) {
		t.Fatalf("expected progress notification in first event, got: %s", string(first.Data))
	}

	// Simulate disconnect.
	stream.Cancel()

	// Allow tool to complete after disconnect.
	close(continueTool)

	resumed, err := client.ResumeStream(context.Background(), first.ID, nil)
	if err != nil {
		t.Fatalf("ResumeStream: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	doneCh := make(chan struct{})
	var rest []SSEMessage
	var readErr error
	go func() {
		defer close(doneCh)
		rest, readErr = resumed.ReadAll()
	}()

	select {
	case <-doneCh:
	case <-ctx.Done():
		t.Fatalf("timed out reading resumed SSE stream")
	}
	if readErr != nil {
		t.Fatalf("read resumed SSE stream: %v", readErr)
	}

	foundFinal := false
	for _, msg := range rest {
		if strings.Contains(string(msg.Data), `"result"`) {
			foundFinal = true
			break
		}
	}
	if !foundFinal {
		t.Fatalf("expected resumed stream to include final result; got %d messages", len(rest))
	}
}
