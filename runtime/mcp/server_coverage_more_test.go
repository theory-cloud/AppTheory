package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

type configurableStreamStore struct {
	create         func(ctx context.Context, sessionID string) (string, error)
	append         func(ctx context.Context, sessionID, streamID string, data json.RawMessage) (string, error)
	close          func(ctx context.Context, sessionID, streamID string) error
	subscribe      func(ctx context.Context, sessionID, streamID, afterEventID string) (<-chan StreamEvent, error)
	streamForEvent func(ctx context.Context, sessionID, eventID string) (string, error)
	deleteSession  func(ctx context.Context, sessionID string) error
}

func (s configurableStreamStore) Create(ctx context.Context, sessionID string) (string, error) {
	if s.create != nil {
		return s.create(ctx, sessionID)
	}
	return "", errors.New("not implemented")
}

func (s configurableStreamStore) Append(ctx context.Context, sessionID, streamID string, data json.RawMessage) (string, error) {
	if s.append != nil {
		return s.append(ctx, sessionID, streamID, data)
	}
	return "", errors.New("not implemented")
}

func (s configurableStreamStore) Close(ctx context.Context, sessionID, streamID string) error {
	if s.close != nil {
		return s.close(ctx, sessionID, streamID)
	}
	return errors.New("not implemented")
}

func (s configurableStreamStore) Subscribe(ctx context.Context, sessionID, streamID, afterEventID string) (<-chan StreamEvent, error) {
	if s.subscribe != nil {
		return s.subscribe(ctx, sessionID, streamID, afterEventID)
	}
	return nil, errors.New("not implemented")
}

func (s configurableStreamStore) StreamForEvent(ctx context.Context, sessionID, eventID string) (string, error) {
	if s.streamForEvent != nil {
		return s.streamForEvent(ctx, sessionID, eventID)
	}
	return "", errors.New("not implemented")
}

func (s configurableStreamStore) DeleteSession(ctx context.Context, sessionID string) error {
	if s.deleteSession != nil {
		return s.deleteSession(ctx, sessionID)
	}
	return nil
}

func TestBatchParseErrorResponse_ReturnsJSONRPCParseError(t *testing.T) {
	s := NewServer("test", "dev")

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", []byte("["), nil)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("status: got %d want %d", resp.Status, 200)
	}

	rpcResp, parseErr := parseJSONRPCResponse(resp)
	if parseErr != nil {
		t.Fatalf("parse: %v", parseErr)
	}
	if rpcResp.Error == nil || rpcResp.Error.Code != CodeParseError {
		t.Fatalf("expected parse error response, got: %+v", rpcResp.Error)
	}
}

func TestHandleBatch_ProtocolVersionRestriction_Returns400(t *testing.T) {
	s := NewServer("test", "dev")

	body := []byte(`[{"jsonrpc":"2.0","id":1,"method":"initialize"}]`)
	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, map[string][]string{
		"mcp-protocol-version": {protocolVersion},
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 400 {
		t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 400, string(resp.Body))
	}
}

func TestLoadBatchSession_SessionNotFound_Returns404(t *testing.T) {
	s := NewServer("test", "dev")

	body := []byte(`[{"jsonrpc":"2.0","id":1,"method":"` + methodToolsList + `"}]`)
	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, map[string][]string{
		"mcp-session-id": {"missing"},
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 404 {
		t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 404, string(resp.Body))
	}
}

func TestNegotiateInitializeProtocolVersion_InvalidParamsAndUnsupported(t *testing.T) {
	s := NewServer("test", "dev")

	_, errResp := s.negotiateInitializeProtocolVersion(&Request{ID: 1, Params: json.RawMessage("{")})
	if errResp == nil || errResp.Error == nil || errResp.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid params error response, got: %+v", errResp)
	}

	pv, errResp := s.negotiateInitializeProtocolVersion(&Request{ID: 1, Params: json.RawMessage(`{"protocolVersion":"not-supported"}`)})
	if errResp != nil || pv != protocolVersion {
		t.Fatalf("expected unsupported protocol to negotiate to latest, got pv=%q err=%+v", pv, errResp)
	}
}

func TestRequireSession_Errors(t *testing.T) {
	s := NewServer("test", "dev")
	ctx := context.Background()

	_, _, resp := s.requireSession(ctx, map[string][]string{})
	if resp == nil || resp.Status != 400 {
		t.Fatalf("expected missing session id to return 400")
	}

	s.sessionStore = stubSessionStore{
		get: func(context.Context, string) (*Session, error) {
			return nil, ErrSessionNotFound
		},
	}
	_, _, resp = s.requireSession(ctx, map[string][]string{"mcp-session-id": {"missing"}})
	if resp == nil || resp.Status != 404 {
		t.Fatalf("expected session not found to return 404")
	}

	s.sessionStore = stubSessionStore{
		get: func(context.Context, string) (*Session, error) {
			return nil, errors.New("boom")
		},
	}
	_, _, resp = s.requireSession(ctx, map[string][]string{"mcp-session-id": {"any"}})
	if resp == nil || resp.Status != 500 {
		t.Fatalf("expected store error to return 500")
	}

	s.sessionStore = stubSessionStore{
		get: func(context.Context, string) (*Session, error) {
			return &Session{ID: "s1", ExpiresAt: time.Now().Add(time.Minute)}, nil
		},
		put: func(context.Context, *Session) error {
			return errors.New("put failed")
		},
	}
	_, _, resp = s.requireSession(ctx, map[string][]string{"mcp-session-id": {"s1"}})
	if resp == nil || resp.Status != 500 {
		t.Fatalf("expected refresh put error to return 500")
	}
}

func TestHandleGET_EventNotFound_AndStoreErrors(t *testing.T) {
	s := NewServer("test", "dev")
	sessionID := initializeSession(t, s)

	headers := sessionHeaders(sessionID)
	headers["last-event-id"] = []string{"9999"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 404 {
		t.Fatalf("status: got %d want %d", resp.Status, 404)
	}

	s.streamStore = configurableStreamStore{
		streamForEvent: func(context.Context, string, string) (string, error) {
			return "", errors.New("stream store boom")
		},
	}
	resp, err = invokeHandlerWithMethod(context.Background(), s, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 500 {
		t.Fatalf("status: got %d want %d", resp.Status, 500)
	}

	s.streamStore = configurableStreamStore{
		streamForEvent: func(context.Context, string, string) (string, error) {
			return "stream-1", nil
		},
		subscribe: func(context.Context, string, string, string) (<-chan StreamEvent, error) {
			return nil, ErrStreamNotFound
		},
	}
	resp, err = invokeHandlerWithMethod(context.Background(), s, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 404 {
		t.Fatalf("status: got %d want %d", resp.Status, 404)
	}
}

func TestToolCallError_MapsNotFoundAndTimeout(t *testing.T) {
	s := NewServer("test", "dev")

	r := s.toolCallError(context.Background(), 1, "t", errors.New("tool not found: t"))
	if r.Error == nil || r.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid params for tool not found, got: %+v", r.Error)
	}

	timeoutCtx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	r = s.toolCallError(timeoutCtx, 1, "t", context.DeadlineExceeded)
	if r.Error == nil || r.Error.Code != CodeServerError {
		t.Fatalf("expected server error for timeout, got: %+v", r.Error)
	}

	r = s.toolCallError(context.Background(), 1, "t", errors.New("boom"))
	if r.Error == nil || r.Error.Code != CodeServerError {
		t.Fatalf("expected server error for generic error, got: %+v", r.Error)
	}
}

func TestHandleToolsCallStream_StreamingNotSupported_AndStreamStoreErrors(t *testing.T) {
	sessionID := "sess-1"

	// A server with streaming disabled should return an internal JSON-RPC error.
	s := NewServer("test", "dev", WithStreamStore(nil))
	// Create a session directly so we can call tools/call without initialize.
	s.sessionStore = NewMemorySessionStore()
	requirePut(t, s.sessionStore, &Session{ID: sessionID, ExpiresAt: time.Now().Add(time.Minute), Data: map[string]string{"protocolVersion": protocolVersion}})

	params := mustMarshal(t, map[string]any{"name": "any", "arguments": json.RawMessage(`{}`)})
	body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsCall, Params: params})

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("status: got %d want %d", resp.Status, 200)
	}
	rpcResp, parseErr := parseJSONRPCResponse(resp)
	if parseErr != nil {
		t.Fatalf("parse: %v", parseErr)
	}
	if rpcResp.Error == nil || rpcResp.Error.Code != CodeInternalError {
		t.Fatalf("expected internal error, got: %+v", rpcResp.Error)
	}

	// Create error should map to internalServerError (500).
	s2 := NewServer("test", "dev")
	s2.sessionStore = NewMemorySessionStore()
	requirePut(t, s2.sessionStore, &Session{ID: sessionID, ExpiresAt: time.Now().Add(time.Minute), Data: map[string]string{"protocolVersion": protocolVersion}})
	s2.streamStore = configurableStreamStore{
		create: func(context.Context, string) (string, error) { return "", errors.New("create failed") },
	}
	resp, err = invokeHandlerWithMethod(context.Background(), s2, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 500 {
		t.Fatalf("status: got %d want %d", resp.Status, 500)
	}

	// Subscribe error should map to internalServerError (500).
	s3 := NewServer("test", "dev")
	s3.sessionStore = NewMemorySessionStore()
	requirePut(t, s3.sessionStore, &Session{ID: sessionID, ExpiresAt: time.Now().Add(time.Minute), Data: map[string]string{"protocolVersion": protocolVersion}})
	s3.streamStore = configurableStreamStore{
		create: func(context.Context, string) (string, error) { return "stream-1", nil },
		subscribe: func(context.Context, string, string, string) (<-chan StreamEvent, error) {
			return nil, errors.New("subscribe failed")
		},
	}
	resp, err = invokeHandlerWithMethod(context.Background(), s3, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 500 {
		t.Fatalf("status: got %d want %d", resp.Status, 500)
	}
}

func TestRunStreamingTool_InvalidParamsAndMissingName_AppendErrorResponse(t *testing.T) {
	s := NewServer("test", "dev")
	s.streamStore = NewMemoryStreamStore()

	const sessionID = "sess-1"
	streamID, err := s.streamStore.Create(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("create stream: %v", err)
	}

	s.runStreamingTool(context.Background(), sessionID, streamID, &Request{
		JSONRPC: "2.0",
		ID:      1,
		Method:  methodToolsCall,
		Params:  json.RawMessage("{"),
	})

	ch, err := s.streamStore.Subscribe(context.Background(), sessionID, streamID, "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	ev := <-ch
	if len(ev.Data) == 0 || !json.Valid(ev.Data) {
		t.Fatalf("expected JSON-RPC response data, got: %q", string(ev.Data))
	}

	streamID2, err := s.streamStore.Create(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("create stream2: %v", err)
	}
	s.runStreamingTool(context.Background(), sessionID, streamID2, &Request{
		JSONRPC: "2.0",
		ID:      2,
		Method:  methodToolsCall,
		Params:  mustMarshal(t, map[string]any{"name": ""}),
	})
	ch2, err := s.streamStore.Subscribe(context.Background(), sessionID, streamID2, "")
	if err != nil {
		t.Fatalf("subscribe2: %v", err)
	}
	ev2 := <-ch2
	if len(ev2.Data) == 0 || !json.Valid(ev2.Data) {
		t.Fatalf("expected JSON-RPC response data, got: %q", string(ev2.Data))
	}
}

func TestRunBatchRequests_EdgeCases(t *testing.T) {
	s := NewServer("test", "dev", WithServerIDGenerator(staticIDGenerator{id: "sess-1"}))

	t.Run("missing session yields error response", func(t *testing.T) {
		_, responses := s.runBatchRequests(context.Background(), []*Request{
			{JSONRPC: "2.0", ID: 1, Method: methodToolsList},
		}, "", nil)
		if len(responses) != 1 || responses[0].Error == nil || responses[0].Error.Code != CodeInvalidRequest {
			t.Fatalf("expected invalid request error for missing session, got: %+v", responses)
		}
	})

	t.Run("initialize invalid params yields JSON-RPC error", func(t *testing.T) {
		_, responses := s.runBatchRequests(context.Background(), []*Request{
			{JSONRPC: "2.0", ID: 1, Method: methodInitialize, Params: json.RawMessage("{")},
		}, "", nil)
		if len(responses) != 1 || responses[0].Error == nil || responses[0].Error.Code != CodeInvalidParams {
			t.Fatalf("expected invalid params error for initialize, got: %+v", responses)
		}
	})

	t.Run("initialize notification creates session without response", func(t *testing.T) {
		created, responses := s.runBatchRequests(context.Background(), []*Request{
			{JSONRPC: "2.0", ID: nil, Method: methodInitialize},
			{JSONRPC: "2.0", ID: 2, Method: methodToolsList},
		}, "", nil)
		if created == "" {
			t.Fatalf("expected initialize notification to create a session id")
		}
		if len(responses) != 1 || responses[0].ID == nil {
			t.Fatalf("expected only tools/list response, got: %+v", responses)
		}
	})

	t.Run("session load errors become internal error response", func(t *testing.T) {
		s2 := NewServer("test", "dev", WithSessionStore(stubSessionStore{
			get: func(context.Context, string) (*Session, error) {
				return nil, errors.New("boom")
			},
		}))
		_, responses := s2.runBatchRequests(context.Background(), []*Request{
			{JSONRPC: "2.0", ID: 1, Method: methodToolsList},
		}, "sess-1", nil)
		if len(responses) != 1 || responses[0].Error == nil || responses[0].Error.Code != CodeInternalError {
			t.Fatalf("expected internal error response, got: %+v", responses)
		}
	})
}

func TestFloatFromAny_CoversAllSupportedTypes(t *testing.T) {
	cases := []struct {
		v    any
		want float64
		ok   bool
	}{
		{v: float64(1.5), want: 1.5, ok: true},
		{v: float32(2.5), want: 2.5, ok: true},
		{v: int(3), want: 3, ok: true},
		{v: int64(4), want: 4, ok: true},
		{v: int32(5), want: 5, ok: true},
		{v: json.Number("6.5"), want: 6.5, ok: true},
		{v: "nope", want: 0, ok: false},
	}
	for _, tc := range cases {
		got, ok := floatFromAny(tc.v)
		if ok != tc.ok {
			t.Fatalf("floatFromAny(%T): ok=%v want %v", tc.v, ok, tc.ok)
		}
		if tc.ok && got != tc.want {
			t.Fatalf("floatFromAny(%T): got %v want %v", tc.v, got, tc.want)
		}
	}
}

func requirePut(t *testing.T, store SessionStore, sess *Session) {
	t.Helper()
	if err := store.Put(context.Background(), sess); err != nil {
		t.Fatalf("put session: %v", err)
	}
}
