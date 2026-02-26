package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

type staticIDGenerator struct {
	id string
}

func (g staticIDGenerator) NewID() string { return g.id }

type stubSessionStore struct {
	get    func(ctx context.Context, id string) (*Session, error)
	put    func(ctx context.Context, session *Session) error
	delete func(ctx context.Context, id string) error
}

func (s stubSessionStore) Get(ctx context.Context, id string) (*Session, error) {
	if s.get != nil {
		return s.get(ctx, id)
	}
	return nil, ErrSessionNotFound
}

func (s stubSessionStore) Put(ctx context.Context, session *Session) error {
	if s.put != nil {
		return s.put(ctx, session)
	}
	return nil
}

func (s stubSessionStore) Delete(ctx context.Context, id string) error {
	if s.delete != nil {
		return s.delete(ctx, id)
	}
	return nil
}

type stubStreamStore struct {
	deleteSession func(ctx context.Context, sessionID string) error
}

func (s stubStreamStore) Create(context.Context, string) (string, error) {
	return "", errors.New("not implemented")
}
func (s stubStreamStore) Append(context.Context, string, string, json.RawMessage) (string, error) {
	return "", errors.New("not implemented")
}
func (s stubStreamStore) Close(context.Context, string, string) error {
	return errors.New("not implemented")
}
func (s stubStreamStore) Subscribe(context.Context, string, string, string) (<-chan StreamEvent, error) {
	return nil, errors.New("not implemented")
}
func (s stubStreamStore) StreamForEvent(context.Context, string, string) (string, error) {
	return "", errors.New("not implemented")
}
func (s stubStreamStore) DeleteSession(ctx context.Context, sessionID string) error {
	if s.deleteSession != nil {
		return s.deleteSession(ctx, sessionID)
	}
	return nil
}

func TestNewServer_AppliesOptionsAndExposesRegistries(t *testing.T) {
	sessionStore := NewMemorySessionStore()
	streamStore := NewMemoryStreamStore()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idGen := staticIDGenerator{id: "static-id"}
	originValidator := func(origin string) bool { return origin == "https://ok.example" }

	s := NewServer("name", "version",
		nil, // ensure nil options are ignored
		WithSessionStore(sessionStore),
		WithStreamStore(streamStore),
		WithServerIDGenerator(idGen),
		WithLogger(logger),
		WithOriginValidator(originValidator),
	)

	if s.sessionStore != sessionStore {
		t.Fatalf("expected sessionStore to be set via option")
	}
	if s.streamStore != streamStore {
		t.Fatalf("expected streamStore to be set via option")
	}
	if s.idGen != idGen {
		t.Fatalf("expected idGen to be set via option")
	}
	if s.logger != logger {
		t.Fatalf("expected logger to be set via option")
	}
	if s.originValidator == nil || !s.originValidator("https://ok.example") {
		t.Fatalf("expected origin validator to be set via option")
	}

	if s.Registry() == nil {
		t.Fatalf("expected Registry() to return non-nil registry")
	}
	if s.Resources() == nil {
		t.Fatalf("expected Resources() to return non-nil registry")
	}
	if s.Prompts() == nil {
		t.Fatalf("expected Prompts() to return non-nil registry")
	}
}

func TestHandler_UnknownHTTPMethod_Returns405(t *testing.T) {
	s := NewServer("test", "dev")
	h := s.Handler()

	resp, err := h(&apptheory.Context{
		Request: apptheory.Request{Method: "PUT"},
	})
	if err != nil {
		t.Fatalf("handler returned error: %v", err)
	}
	if resp.Status != 405 {
		t.Fatalf("status: got %d want %d", resp.Status, 405)
	}
	if got := string(resp.Body); got != `{"error":"method not allowed"}` {
		t.Fatalf("body: got %s", got)
	}
}

func TestPOST_AcceptsJSONRPCResponses_Returns202(t *testing.T) {
	s := NewServer("test", "dev")
	sessionID := initializeSession(t, s)

	body := mustMarshal(t, Response{JSONRPC: "2.0", ID: 1, Result: map[string]any{"ok": true}})
	headers := sessionHeaders(sessionID)

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 202 {
		t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 202, string(resp.Body))
	}
}

func TestPOST_InvalidJSONRPCResponse_Returns400(t *testing.T) {
	s := NewServer("test", "dev")
	sessionID := initializeSession(t, s)

	// Missing id => invalid JSON-RPC response.
	body := []byte(`{"jsonrpc":"2.0","result":{"ok":true}}`)
	headers := sessionHeaders(sessionID)

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 400 {
		t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 400, string(resp.Body))
	}
}

func TestDELETE_MissingSessionID_Returns400(t *testing.T) {
	s := NewServer("test", "dev")
	resp, err := invokeHandlerWithMethod(context.Background(), s, "DELETE", nil, map[string][]string{})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 400 {
		t.Fatalf("status: got %d want %d", resp.Status, 400)
	}
}

func TestDELETE_SessionNotFound_Returns404(t *testing.T) {
	s := NewServer("test", "dev")
	resp, err := invokeHandlerWithMethod(context.Background(), s, "DELETE", nil, map[string][]string{
		"mcp-session-id": {"missing"},
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 404 {
		t.Fatalf("status: got %d want %d", resp.Status, 404)
	}
}

func TestDELETE_SessionStoreError_Returns500(t *testing.T) {
	s := NewServer("test", "dev", WithSessionStore(stubSessionStore{
		get: func(context.Context, string) (*Session, error) {
			return nil, errors.New("boom")
		},
	}))

	resp, err := invokeHandlerWithMethod(context.Background(), s, "DELETE", nil, map[string][]string{
		"mcp-session-id": {"any"},
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 500 {
		t.Fatalf("status: got %d want %d", resp.Status, 500)
	}
}

func TestDELETE_DeleteError_Returns500(t *testing.T) {
	const sessionID = "sess-1"
	s := NewServer("test", "dev", WithSessionStore(stubSessionStore{
		get: func(context.Context, string) (*Session, error) {
			return &Session{ID: sessionID, ExpiresAt: time.Now().Add(time.Minute)}, nil
		},
		delete: func(context.Context, string) error {
			return errors.New("delete failed")
		},
	}))

	resp, err := invokeHandlerWithMethod(context.Background(), s, "DELETE", nil, map[string][]string{
		"mcp-session-id": {sessionID},
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 500 {
		t.Fatalf("status: got %d want %d", resp.Status, 500)
	}
}

func TestDELETE_DeletesSession_AndStreamDeleteErrorsAreIgnored(t *testing.T) {
	s := NewServer("test", "dev")
	sessionID := initializeSession(t, s)

	s.streamStore = stubStreamStore{
		deleteSession: func(context.Context, string) error {
			return errors.New("stream delete failed")
		},
	}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "DELETE", nil, map[string][]string{
		"mcp-session-id": {sessionID},
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 202 {
		t.Fatalf("status: got %d want %d", resp.Status, 202)
	}
}

func TestValidateOrigin_FailClosedWhenOriginPresent(t *testing.T) {
	s := NewServer("test", "dev", WithOriginValidator(nil))
	resp := s.validateOrigin(map[string][]string{
		"origin": {"https://evil.example"},
	})
	if resp == nil || resp.Status != 403 {
		t.Fatalf("expected origin validation to fail closed with 403")
	}
}

func TestRequireProtocolVersion_RejectsUnsupportedAndMismatch(t *testing.T) {
	s := NewServer("test", "dev")

	if resp := s.requireProtocolVersion(map[string][]string{
		"mcp-protocol-version": {"not-a-real-version"},
	}, nil); resp == nil || resp.Status != 400 {
		t.Fatalf("expected unsupported protocol version to return 400")
	}

	sess := &Session{Data: map[string]string{"protocolVersion": protocolVersion}}
	if resp := s.requireProtocolVersion(map[string][]string{
		"mcp-protocol-version": {protocolVersionLegacy},
	}, sess); resp == nil || resp.Status != 400 {
		t.Fatalf("expected negotiated protocol mismatch to return 400")
	}
}

func TestHandleNotification_Initialized_PersistsSessionFlag(t *testing.T) {
	s := NewServer("test", "dev")
	sessionID := initializeSession(t, s)

	req := mustMarshal(t, Request{JSONRPC: "2.0", Method: methodNotificationsInitialized})
	headers := sessionHeaders(sessionID)

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 202 {
		t.Fatalf("status: got %d want %d", resp.Status, 202)
	}

	sess, err := s.sessionStore.Get(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if sess.Data == nil || sess.Data["initialized"] != sessionInitializedValue {
		t.Fatalf("expected session initialized flag to be persisted, got: %+v", sess.Data)
	}
}

func TestHandleNotification_NilSession_DoesNotPanic(t *testing.T) {
	s := NewServer("test", "dev")
	s.handleNotification(context.Background(), nil, &Request{Method: methodNotificationsInitialized})
}

func TestSessionTTL_EnvOverride_AndFallbacks(t *testing.T) {
	t.Setenv(envSessionTTLMinutes, "5")
	if got := sessionTTL(); got != 5*time.Minute {
		t.Fatalf("sessionTTL: got %v want %v", got, 5*time.Minute)
	}

	t.Setenv(envSessionTTLMinutes, "-1")
	if got := sessionTTL(); got != time.Duration(defaultSessionTTLMinutes)*time.Minute {
		t.Fatalf("sessionTTL: expected default fallback, got %v", got)
	}
}

func TestInitialize_SessionStorePutError_ReturnsJSONRPCErrorResponse(t *testing.T) {
	s := NewServer("test", "dev",
		WithSessionStore(stubSessionStore{
			put: func(context.Context, *Session) error {
				return errors.New("put failed")
			},
		}),
		WithServerIDGenerator(staticIDGenerator{id: "sess-1"}),
	)

	body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodInitialize})
	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, map[string][]string{
		"content-type": {"application/json"},
		"accept":       {"application/json"},
	})
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
		t.Fatalf("expected internal error JSON-RPC response, got: %+v", rpcResp.Error)
	}
}

func TestProgressAndFloatHelpers(t *testing.T) {
	progress, total, message := progressFromSSEEvent(SSEEvent{Data: nil}, 7)
	if progress != 7 || total != nil || message != "" {
		t.Fatalf("nil data: got progress=%v total=%v message=%q", progress, total, message)
	}

	progress, total, message = progressFromSSEEvent(SSEEvent{Data: "hello"}, 7)
	if progress != 7 || total != nil || message != "hello" {
		t.Fatalf("string data: got progress=%v total=%v message=%q", progress, total, message)
	}

	progress, total, message = progressFromSSEEvent(SSEEvent{Data: map[string]any{"progress": json.Number("3"), "total": 10, "message": "m"}}, 7)
	if progress != 3 || total != 10 || message != "m" {
		t.Fatalf("map data: got progress=%v total=%v message=%q", progress, total, message)
	}

	if _, ok := floatFromAny(json.Number("not-a-number")); ok {
		t.Fatalf("expected json.Number parse failure to return ok=false")
	}

	if got := mustMarshalJSON(func() {}); got != nil {
		t.Fatalf("expected mustMarshalJSON to return nil for unmarshalable values")
	}
}

func TestAppendStreamResponse_NilResponse_ReturnsError(t *testing.T) {
	s := NewServer("test", "dev")
	s.streamStore = NewMemoryStreamStore()

	if _, err := s.streamStore.Create(context.Background(), "sess"); err != nil {
		t.Fatalf("create stream: %v", err)
	}
	// appendStreamResponse should fail when MarshalResponse receives nil.
	if err := s.appendStreamResponse(context.Background(), "sess", "stream", nil); err == nil {
		t.Fatalf("expected error for nil response")
	}
}

func TestMarshalSingleResponse_ReturnsErrorForUnmarshalableResponse(t *testing.T) {
	s := NewServer("test", "dev")

	_, err := s.marshalSingleResponse(&Response{
		JSONRPC: "2.0",
		ID:      1,
		Result:  func() {},
	}, "", false)
	if err == nil {
		t.Fatalf("expected marshalSingleResponse to error when response is not JSON-marshalable")
	}
}

func TestJSONRPCErrorResponse_FallsBackWhenMarshalFails(t *testing.T) {
	// Force MarshalResponse to fail by providing an unsupported ID type.
	resp := jsonRPCErrorResponse(make(chan int), CodeInternalError, "boom")
	if resp == nil || resp.Status != 200 {
		t.Fatalf("expected jsonRPCErrorResponse to return HTTP 200 response")
	}
	if got := string(resp.Body); got != `{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"internal error"}}` {
		t.Fatalf("unexpected fallback body: %s", got)
	}
}

func TestGET_NoLastEventID_ReturnsEmptySSE(t *testing.T) {
	s := NewServer("test", "dev")
	sessionID := initializeSession(t, s)

	resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, sessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("status: got %d want %d", resp.Status, 200)
	}
	if got := firstHeader(resp.Headers, "content-type"); got != "text/event-stream" {
		t.Fatalf("content-type: got %q want %q", got, "text/event-stream")
	}
	if len(resp.Body) != 0 {
		t.Fatalf("expected empty SSE body, got: %q", string(resp.Body))
	}
}
