package mcp

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestCancellationNotification_CancelsBufferedRequest(t *testing.T) {
	s := NewServer("test", "1.0.0")
	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	started := make(chan struct{})
	canceled := make(chan struct{})
	release := make(chan struct{})
	if err := s.Registry().RegisterTool(ToolDef{
		Name:        "slow",
		Description: "waits for cancellation",
		InputSchema: json.RawMessage(`{"type":"object"}`),
	}, func(ctx context.Context, _ json.RawMessage) (*ToolResult, error) {
		close(started)
		select {
		case <-ctx.Done():
			close(canceled)
			return nil, ctx.Err()
		case <-release:
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "done"}}}, nil
		}
	}); err != nil {
		t.Fatalf("register tool: %v", err)
	}
	defer close(release)

	resultCh := make(chan *Response, 1)
	go func() {
		params := mustMarshal(t, toolsCallParams{Name: "slow", Arguments: json.RawMessage(`{}`)})
		body := mustMarshal(t, Request{JSONRPC: "2.0", ID: "req-1", Method: methodToolsCall, Params: params})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
		if err != nil {
			t.Errorf("invoke tools/call: %v", err)
			return
		}
		rpcResp, err := parseJSONRPCResponse(resp)
		if err != nil {
			t.Errorf("parse tools/call: %v", err)
			return
		}
		resultCh <- rpcResp
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("tool did not start")
	}

	cancelReq := mustMarshal(t, Request{
		JSONRPC: "2.0",
		Method:  methodNotificationsCancelled,
		Params:  mustMarshal(t, map[string]any{"requestId": "req-1", "reason": "test"}),
	})
	cancelResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", cancelReq, headers)
	if err != nil {
		t.Fatalf("invoke cancellation notification: %v", err)
	}
	if cancelResp.Status != 202 {
		t.Fatalf("cancellation status: got %d want 202 (body=%s)", cancelResp.Status, string(cancelResp.Body))
	}

	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("tool context was not canceled")
	}
	select {
	case rpcResp := <-resultCh:
		if rpcResp.Error == nil || rpcResp.Error.Code != CodeServerError {
			t.Fatalf("expected canceled tool to return server error, got: %+v", rpcResp.Error)
		}
	case <-time.After(time.Second):
		t.Fatal("tool call did not return after cancellation")
	}
}

func TestCancellationNotification_IgnoresUnknownAndCompletedRequests(t *testing.T) {
	s := NewServer("test", "1.0.0")
	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	pingReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: "done", Method: methodPing})
	pingResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", pingReq, headers)
	if err != nil {
		t.Fatalf("invoke ping: %v", err)
	}
	if pingResp.Status != 200 {
		t.Fatalf("ping status: got %d want 200", pingResp.Status)
	}

	for _, requestID := range []string{"missing", "done"} {
		cancelReq := mustMarshal(t, Request{
			JSONRPC: "2.0",
			Method:  methodNotificationsCancelled,
			Params:  mustMarshal(t, map[string]any{"requestId": requestID}),
		})
		cancelResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", cancelReq, headers)
		if err != nil {
			t.Fatalf("invoke cancellation notification for %q: %v", requestID, err)
		}
		if cancelResp.Status != 202 {
			t.Fatalf("cancellation status for %q: got %d want 202", requestID, cancelResp.Status)
		}
	}
}

func TestRequestIDKey_CanonicalizesJSONIDs(t *testing.T) {
	tracker := newCancellationTracker()
	ctx, finish := tracker.track(context.Background(), "sess-1", float64(1))
	defer finish()

	if !tracker.cancel("sess-1", json.RawMessage(`1.0`)) {
		t.Fatalf("expected numeric JSON-RPC ids to canonicalize")
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("tracked context was not canceled")
	}

	if tracker.cancel("sess-1", json.RawMessage(`null`)) {
		t.Fatalf("expected null request id to be ignored")
	}
}
