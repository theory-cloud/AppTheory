package mcp

import (
	"context"
	"io"
	"strings"
	"testing"
)

// TestInitialSessionListener_DefaultsToEnabled pins the default posture: without
// the option the initial GET /mcp listener keeps its existing keepalive shape.
func TestInitialSessionListener_DefaultsToEnabled(t *testing.T) {
	t.Parallel()

	s := NewServer("test", "dev")
	if !s.initialSessionListenerEnabled {
		t.Fatal("expected the initial session listener to be enabled by default")
	}

	sessionID := initializeSession(t, s)
	resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, sseSessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke GET: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.Status, resp.Body)
	}
	if resp.BodyReader == nil {
		t.Fatal("expected the default listener to stream a body")
	}
	body, err := io.ReadAll(resp.BodyReader)
	if err != nil {
		t.Fatalf("read listener body: %v", err)
	}
	if !strings.Contains(string(body), ": keepalive") {
		t.Fatalf("expected keepalive comment, got %q", string(body))
	}
}

// TestInitialSessionListener_EnabledOptionKeepsListener pins the explicit
// enabled=true form to the default behavior.
func TestInitialSessionListener_EnabledOptionKeepsListener(t *testing.T) {
	t.Parallel()

	s := NewServer("test", "dev", WithInitialSessionListenerEnabled(true))
	sessionID := initializeSession(t, s)

	resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, sseSessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke GET: %v", err)
	}
	if resp.Status != 200 || resp.BodyReader == nil {
		t.Fatalf("status = %d bodyReader = %v, want 200 with a body", resp.Status, resp.BodyReader != nil)
	}
	if closer, ok := resp.BodyReader.(io.Closer); ok {
		if err := closer.Close(); err != nil {
			t.Fatalf("close listener body: %v", err)
		}
	}
}

// TestGET_NoLastEventID_InitialSessionListenerDisabled_Returns405 pins the
// opt-out posture: a session-valid, protocol-valid GET without Last-Event-ID
// answers 405 with the transport Allow set instead of opening a listener.
func TestGET_NoLastEventID_InitialSessionListenerDisabled_Returns405(t *testing.T) {
	t.Parallel()

	s := NewServer("test", "dev", WithInitialSessionListenerEnabled(false))
	sessionID := initializeSession(t, s)

	resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, sseSessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke GET: %v", err)
	}
	if resp.Status != 405 {
		t.Fatalf("status = %d, want 405 (body: %s)", resp.Status, resp.Body)
	}
	if got := resp.Headers["allow"]; len(got) != 1 || got[0] != "DELETE, GET, POST" {
		t.Fatalf("allow = %v, want [DELETE, GET, POST]", got)
	}
	if got := resp.Headers["content-type"]; len(got) != 1 || got[0] != "application/json" {
		t.Fatalf("content-type = %v, want [application/json]", got)
	}
	if string(resp.Body) != `{"error":"method not allowed"}` {
		t.Fatalf("body = %q, want method-not-allowed envelope", string(resp.Body))
	}
	if resp.BodyReader != nil {
		t.Fatal("disabled posture must not open a listener body")
	}

	// The session stays usable for POST after the declined common stream.
	body := []byte(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	listResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, sessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke tools/list: %v", err)
	}
	if listResp.Status != 200 {
		t.Fatalf("tools/list status = %d, want 200 (body: %s)", listResp.Status, listResp.Body)
	}
}

// TestGET_NoLastEventID_InitialSessionListenerDisabled_Precedence pins the
// validation order: origin, session, and protocol failures keep their existing
// statuses and are never turned into the 405.
func TestGET_NoLastEventID_InitialSessionListenerDisabled_Precedence(t *testing.T) {
	t.Parallel()

	s := NewServer("test", "dev", WithInitialSessionListenerEnabled(false))
	sessionID := initializeSession(t, s)

	withHeader := func(key, value string) map[string][]string {
		headers := sseSessionHeaders(sessionID)
		headers[key] = []string{value}
		return headers
	}

	badOrigin := withHeader("origin", "https://evil.example")

	tests := []struct {
		name    string
		headers map[string][]string
		status  int
		body    string
	}{
		{
			name:    "bad origin stays 403",
			headers: badOrigin,
			status:  403,
			body:    `{"error":"forbidden"}`,
		},
		{
			name: "missing session stays 400",
			headers: map[string][]string{
				"accept":               {"text/event-stream"},
				"mcp-protocol-version": {protocolVersion},
			},
			status: 400,
			body:   `{"error":"missing Mcp-Session-Id"}`,
		},
		{
			name: "unknown session stays 404",
			headers: map[string][]string{
				"accept":               {"text/event-stream"},
				"mcp-session-id":       {"missing"},
				"mcp-protocol-version": {protocolVersion},
			},
			status: 404,
			body:   `{"error":"session not found"}`,
		},
		{
			name:    "unsupported protocol version stays 400",
			headers: withHeader("mcp-protocol-version", "1999-01-01"),
			status:  400,
			body:    `{"error":"unsupported MCP-Protocol-Version"}`,
		},
		{
			name:    "protocol mismatch stays 400",
			headers: withHeader("mcp-protocol-version", protocolVersionPrior),
			status:  400,
			body:    `{"error":"MCP-Protocol-Version mismatch"}`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, tc.headers)
			if err != nil {
				t.Fatalf("invoke GET: %v", err)
			}
			if resp.Status != tc.status {
				t.Fatalf("status = %d, want %d (body: %s)", resp.Status, tc.status, resp.Body)
			}
			if string(resp.Body) != tc.body {
				t.Fatalf("body = %q, want %q", string(resp.Body), tc.body)
			}
		})
	}
}

// TestGET_LastEventID_InitialSessionListenerDisabled_Replays pins that replay is
// unaffected by the declined common stream.
func TestGET_LastEventID_InitialSessionListenerDisabled_Replays(t *testing.T) {
	t.Parallel()

	store := NewMemoryStreamStore()
	s := NewServer("test", "dev", WithStreamStore(store), WithInitialSessionListenerEnabled(false))
	sessionID := initializeSession(t, s)

	ctx := context.Background()
	streamID, err := store.Create(ctx, sessionID)
	if err != nil {
		t.Fatalf("create stream: %v", err)
	}
	firstID, err := store.Append(ctx, sessionID, streamID, []byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`))
	if err != nil {
		t.Fatalf("append event: %v", err)
	}
	if _, err = store.Append(ctx, sessionID, streamID, []byte(`{"jsonrpc":"2.0","method":"notifications/progress","params":{"seq":2}}`)); err != nil {
		t.Fatalf("append second event: %v", err)
	}
	if err = store.Close(ctx, sessionID, streamID); err != nil {
		t.Fatalf("close stream: %v", err)
	}

	headers := sseSessionHeaders(sessionID)
	headers["last-event-id"] = []string{firstID}

	resp, err := invokeHandlerWithMethod(ctx, s, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke replay GET: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("replay status = %d, want 200 (body: %s)", resp.Status, resp.Body)
	}
	if resp.BodyReader == nil {
		t.Fatal("expected replay body reader")
	}
	body, err := io.ReadAll(resp.BodyReader)
	if err != nil {
		t.Fatalf("read replay body: %v", err)
	}
	if !strings.Contains(string(body), "notifications/progress") {
		t.Fatalf("expected replayed progress event, got:\n%s", string(body))
	}
}

// TestGET_InitialSessionListenerDisabled_StatelessShapeKeepsPostOnly pins that
// the 2026-07-28 stateless rejection still precedes session validation.
func TestGET_InitialSessionListenerDisabled_StatelessShapeKeepsPostOnly(t *testing.T) {
	t.Parallel()

	s := NewServer("test", "dev", WithInitialSessionListenerEnabled(false))

	resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, map[string][]string{
		"accept":               {"text/event-stream"},
		"mcp-protocol-version": {ProtocolVersion20260728},
	})
	if err != nil {
		t.Fatalf("invoke GET: %v", err)
	}
	if resp.Status != 405 {
		t.Fatalf("status = %d, want 405 (body: %s)", resp.Status, resp.Body)
	}
	if got := resp.Headers["allow"]; len(got) != 1 || got[0] != "POST" {
		t.Fatalf("allow = %v, want [POST]", got)
	}
}
