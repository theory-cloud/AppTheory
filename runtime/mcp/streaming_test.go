package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

func readSSEFrame(r *bufio.Reader) (string, error) {
	var b strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return b.String(), err
		}
		b.WriteString(line)
		if line == "\n" {
			return b.String(), nil
		}
	}
}

func TestToolsCallStreaming_StreamsProgressIncrementally(t *testing.T) {
	s := NewServer("test-server", "1.0.0")

	firstEmitted := make(chan struct{})
	continueTool := make(chan struct{})

	if err := s.registry.RegisterStreamingTool(
		ToolDef{
			Name:        "slow_tool",
			Description: "Emits progress then blocks",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(ctx context.Context, _ json.RawMessage, emit func(SSEEvent)) (*ToolResult, error) {
			emit(SSEEvent{Data: map[string]any{"seq": 1}})
			close(firstEmitted)

			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-continueTool:
			}

			emit(SSEEvent{Data: map[string]any{"seq": 2}})
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	params, err := json.Marshal(toolsCallParams{
		Name:      "slow_tool",
		Arguments: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}

	body, err := json.Marshal(Request{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "tools/call",
		Params:  params,
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	headers := map[string][]string{
		"content-type": {"application/json"},
		"accept":       {"text/event-stream"},
	}

	resp, err := invokeHandler(s, body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}

	if ids := resp.Headers["mcp-session-id"]; len(ids) == 0 || ids[0] == "" {
		t.Fatalf("expected mcp-session-id header to be set")
	}

	if resp.BodyReader == nil {
		t.Fatalf("expected streaming response BodyReader to be set")
	}

	reader := bufio.NewReader(resp.BodyReader)

	select {
	case <-firstEmitted:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first progress emission")
	}

	firstFrameCh := make(chan string, 1)
	firstFrameErrCh := make(chan error, 1)
	go func() {
		frame, err := readSSEFrame(reader)
		if err != nil {
			firstFrameErrCh <- err
			return
		}
		firstFrameCh <- frame
	}()

	var firstFrame string
	select {
	case firstFrame = <-firstFrameCh:
	case err := <-firstFrameErrCh:
		t.Fatalf("read first SSE frame: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first SSE frame")
	}

	if !strings.Contains(firstFrame, "event: progress\n") {
		t.Fatalf("expected first frame to be progress event, got:\n%s", firstFrame)
	}
	if !strings.Contains(firstFrame, `"seq":1`) {
		t.Fatalf("expected first frame to contain seq=1, got:\n%s", firstFrame)
	}

	close(continueTool)

	restCh := make(chan []byte, 1)
	restErrCh := make(chan error, 1)
	go func() {
		b, err := io.ReadAll(reader)
		if err != nil {
			restErrCh <- err
			return
		}
		restCh <- b
	}()

	var rest []byte
	select {
	case rest = <-restCh:
	case err := <-restErrCh:
		t.Fatalf("read rest of SSE stream: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out reading rest of SSE stream")
	}

	all := firstFrame + string(rest)
	if !strings.Contains(all, `"seq":2`) {
		t.Fatalf("expected SSE stream to contain seq=2 progress event, got:\n%s", all)
	}
	if !strings.Contains(all, "event: message\n") {
		t.Fatalf("expected SSE stream to contain final message event, got:\n%s", all)
	}
	if !strings.Contains(all, `"result"`) {
		t.Fatalf("expected final message to contain JSON-RPC result, got:\n%s", all)
	}
}
