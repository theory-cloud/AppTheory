package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	mcpruntime "github.com/theory-cloud/apptheory/runtime/mcp"
	"github.com/theory-cloud/apptheory/testkit"
	mcptest "github.com/theory-cloud/apptheory/testkit/mcp"
)

func TestResumableSSEExample(t *testing.T) {
	env := testkit.New()
	client := mcptest.NewClient(buildServer(), env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	params, err := json.Marshal(map[string]any{
		"name":      "countdown",
		"arguments": json.RawMessage(`{"steps":3}`),
		"_meta":     map[string]any{"progressToken": "pt-123"},
	})
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	req := &mcpruntime.Request{JSONRPC: "2.0", ID: 1, Method: "tools/call", Params: params}

	stream, err := client.RawStream(context.Background(), req, nil)
	if err != nil {
		t.Fatalf("RawStream: %v", err)
	}

	first, err := stream.Next()
	if err != nil {
		t.Fatalf("read first event: %v", err)
	}
	if strings.TrimSpace(first.ID) == "" {
		t.Fatalf("expected SSE id to be set")
	}
	if !strings.Contains(string(first.Data), `"method":"notifications/progress"`) {
		t.Fatalf("expected progress notification in first event, got: %s", string(first.Data))
	}

	// Simulate disconnect and resume from Last-Event-ID.
	stream.Cancel()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	resumed, err := client.ResumeStream(ctx, first.ID, nil)
	if err != nil {
		t.Fatalf("ResumeStream: %v", err)
	}
	msgs, err := resumed.ReadAll()
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}

	foundFinal := false
	for _, msg := range msgs {
		if strings.Contains(string(msg.Data), `"result"`) {
			foundFinal = true
			break
		}
	}
	if !foundFinal {
		t.Fatalf("expected final JSON-RPC result in resumed stream; got %d messages", len(msgs))
	}
}
