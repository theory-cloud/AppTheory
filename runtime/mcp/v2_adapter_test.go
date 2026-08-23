package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/v4/runtime"
)

// serveV2WithMCPApp drives the MCP handler through the HTTP API v2 adapter
// (ServeAPIGatewayV2), mirroring an AppTheoryMcpServer deployment.
func serveV2WithMCPApp(t *testing.T, s *Server, method, path string, headers map[string]string, body string, ctx context.Context) events.APIGatewayV2HTTPResponse {
	t.Helper()
	app := apptheory.New()
	handler := s.Handler()
	app.Post("/mcp", handler)
	app.Get("/mcp", handler)
	app.Delete("/mcp", handler)

	event := events.APIGatewayV2HTTPRequest{
		RawPath: path,
		Headers: headers,
		Body:    body,
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{Method: method, Path: path},
		},
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return app.ServeAPIGatewayV2(ctx, event)
}

func v2SingleHeaders(headers map[string][]string) map[string]string {
	out := map[string]string{}
	for key, values := range headers {
		if len(values) > 0 {
			out[key] = values[0]
		}
	}
	return out
}

func initializeSessionViaV2(t *testing.T, s *Server) string {
	t.Helper()
	out := serveV2WithMCPApp(t, s, "POST", "/mcp", map[string]string{
		"content-type": "application/json",
		"accept":       "application/json, text/event-stream",
	}, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":null}`, nil)
	if out.StatusCode != 200 {
		t.Fatalf("initialize via v2: status %d body %s", out.StatusCode, out.Body)
	}
	sid := out.Headers["mcp-session-id"]
	if sid == "" {
		t.Fatalf("expected mcp-session-id header on initialize response, got %#v", out.Headers)
	}
	return sid
}

// TestServeAPIGatewayV2_GETMCP_ListenerDeliversKeepalive pins the GET /mcp
// session-listener shape (no Last-Event-ID) through the HTTP API v2 adapter:
// the designed short-lived keepalive SSE response must be delivered as a body,
// never silently dropped into an empty 200.
func TestServeAPIGatewayV2_GETMCP_ListenerDeliversKeepalive(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSessionViaV2(t, s)

	out := serveV2WithMCPApp(t, s, "GET", "/mcp", v2SingleHeaders(sseSessionHeaders(sessionID)), "", nil)

	if out.StatusCode != 200 {
		t.Fatalf("listener status: got %d, want 200 (body: %q)", out.StatusCode, out.Body)
	}
	if ct := out.Headers["content-type"]; !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("expected text/event-stream content type, got %q", ct)
	}
	if out.Body == "" {
		t.Fatal("GET /mcp listener returned an empty body: the v2 adapter silently dropped the BodyReader")
	}
	if !strings.Contains(out.Body, ": keepalive") {
		t.Fatalf("expected keepalive comment in listener body, got %q", out.Body)
	}
}

// TestServeAPIGatewayV2_GETMCP_ResumeReplayDelivered pins the GET /mcp
// Last-Event-ID resume shape through the HTTP API v2 adapter: a terminated
// stream replay must be delivered as a body, never silently dropped into an
// empty 200.
func TestServeAPIGatewayV2_GETMCP_ResumeReplayDelivered(t *testing.T) {
	store := NewMemoryStreamStore()
	s := NewServer("test-server", "1.0.0", WithStreamStore(store))
	sessionID := initializeSessionViaV2(t, s)

	ctx := context.Background()
	streamID, err := store.Create(ctx, sessionID)
	if err != nil {
		t.Fatalf("create stream: %v", err)
	}
	firstID, err := store.Append(ctx, sessionID, streamID, json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`))
	if err != nil {
		t.Fatalf("append first event: %v", err)
	}
	if _, err := store.Append(ctx, sessionID, streamID, json.RawMessage(`{"jsonrpc":"2.0","method":"notifications/progress","params":{"seq":2}}`)); err != nil {
		t.Fatalf("append second event: %v", err)
	}
	if err := store.Close(ctx, sessionID, streamID); err != nil {
		t.Fatalf("close stream: %v", err)
	}

	headers := v2SingleHeaders(sseSessionHeaders(sessionID))
	headers["last-event-id"] = firstID

	out := serveV2WithMCPApp(t, s, "GET", "/mcp", headers, "", nil)

	if out.StatusCode != 200 {
		t.Fatalf("resume status: got %d, want 200 (body: %q)", out.StatusCode, out.Body)
	}
	if out.Body == "" {
		t.Fatal("GET /mcp Last-Event-ID resume returned an empty body: the v2 adapter silently dropped the BodyReader")
	}
	if !strings.Contains(out.Body, "notifications/progress") {
		t.Fatalf("expected replayed progress event in resume body, got %q", out.Body)
	}
}

// TestServeAPIGatewayV2_GETMCP_LiveResumeFailsClosed pins the fail-closed
// behavior for a live (non-terminating) Last-Event-ID resume through the HTTP
// API v2 adapter: the client must receive an explicit error, not a silent
// empty 200 that triggers an EOF reconnect loop.
func TestServeAPIGatewayV2_GETMCP_LiveResumeFailsClosed(t *testing.T) {
	store := NewMemoryStreamStore()
	s := NewServer("test-server", "1.0.0", WithStreamStore(store))
	sessionID := initializeSessionViaV2(t, s)

	streamID, err := store.Create(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("create stream: %v", err)
	}
	eventID, err := store.Append(context.Background(), sessionID, streamID, json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`))
	if err != nil {
		t.Fatalf("append event: %v", err)
	}
	// Deliberately leave the stream open so the replay subscription stays live.

	headers := v2SingleHeaders(sseSessionHeaders(sessionID))
	headers["last-event-id"] = eventID

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	start := time.Now()
	out := serveV2WithMCPApp(t, s, "GET", "/mcp", headers, "", ctx)
	elapsed := time.Since(start)

	if elapsed > 2*time.Second {
		t.Fatalf("live resume did not fail closed promptly (elapsed %s)", elapsed)
	}
	if out.StatusCode != 500 {
		t.Fatalf("expected fail-closed status 500 for live resume, got %d (body: %q)", out.StatusCode, out.Body)
	}
	if !strings.Contains(out.Body, "streaming response body cannot be delivered") {
		t.Fatalf("expected documented streaming error message, got %q", out.Body)
	}
}
