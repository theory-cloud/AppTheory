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

func TestStreamingCancellation_PersistsTerminalResponseAfterContextCancelled(t *testing.T) {
	s := NewServer("test", "1.0.0")
	store := &contextSensitiveStreamStore{}
	s.streamStore = store

	if err := s.Registry().RegisterStreamingTool(ToolDef{
		Name:        "canceled",
		Description: "returns when its context is canceled",
		InputSchema: json.RawMessage(`{"type":"object"}`),
	}, func(ctx context.Context, _ json.RawMessage, _ func(SSEEvent)) (*ToolResult, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	req := &Request{
		JSONRPC: jsonrpcVersion,
		ID:      "stream-req",
		Method:  methodToolsCall,
		Params:  mustMarshal(t, toolsCallParams{Name: "canceled", Arguments: json.RawMessage(`{}`)}),
	}

	finished := false
	s.runStreamingTool(ctx, "sess-1", "stream-1", req, func() { finished = true })

	if !finished {
		t.Fatal("expected cancellation tracker finish callback to run")
	}
	if !store.closed {
		t.Fatal("expected canceled stream to be closed with a non-canceled storage context")
	}
	if len(store.appends) == 0 {
		t.Fatal("expected terminal JSON-RPC response to be appended after cancellation")
	}

	var terminal Response
	if err := json.Unmarshal(store.appends[len(store.appends)-1], &terminal); err != nil {
		t.Fatalf("unmarshal terminal response: %v", err)
	}
	if terminal.Error == nil || terminal.Error.Code != CodeServerError {
		t.Fatalf("expected canceled streaming tool to append server error, got %+v", terminal.Error)
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

type contextSensitiveStreamStore struct {
	appends []json.RawMessage
	closed  bool
}

func (s *contextSensitiveStreamStore) Create(ctx context.Context, _ string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return "stream-1", nil
}

func (s *contextSensitiveStreamStore) Append(ctx context.Context, _, _ string, data json.RawMessage) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.appends = append(s.appends, append(json.RawMessage(nil), data...))
	return "event-1", nil
}

func (s *contextSensitiveStreamStore) Close(ctx context.Context, _, _ string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.closed = true
	return nil
}

func (s *contextSensitiveStreamStore) Subscribe(context.Context, string, string, string) (<-chan StreamEvent, error) {
	ch := make(chan StreamEvent)
	close(ch)
	return ch, nil
}

func (s *contextSensitiveStreamStore) StreamForEvent(context.Context, string, string) (string, error) {
	return "", ErrEventNotFound
}

func (s *contextSensitiveStreamStore) DeleteSession(context.Context, string) error {
	return nil
}
