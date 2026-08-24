package mcp

import (
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v4/runtime"
)

// toolContextPrincipalKey is the context key the test hook pipes middleware
// values into, standing in for an app's own principal key.
type toolContextPrincipalKey struct{}

// principalPipingHook returns the hook shape this feature exists for: it reads
// a request-scoped value stored by middleware on the *apptheory.Context and
// makes it visible on the stdlib context handed to method handlers.
func principalPipingHook(c *apptheory.Context, ctx context.Context) context.Context {
	principal, ok := c.Get("principal").(string)
	if !ok || principal == "" {
		return ctx
	}
	return context.WithValue(ctx, toolContextPrincipalKey{}, principal)
}

// authMiddleware stores a caller identity on the request context, as an app's
// authentication middleware would before delegating to the MCP handler.
func authMiddleware(principal string, next apptheory.Handler) apptheory.Handler {
	return func(c *apptheory.Context) (*apptheory.Response, error) {
		c.Set("principal", principal)
		return next(c)
	}
}

// invokeWithMiddleware routes a raw request through a middleware wrapper before
// the server handler, mirroring invokeHandlerWithMethod.
func invokeWithMiddleware(ctx context.Context, s *Server, wrap func(apptheory.Handler) apptheory.Handler, method string, body []byte, headers map[string][]string) (*apptheory.Response, error) {
	handler := wrap(s.Handler())
	app := apptheory.New()
	app.Post("/mcp", handler)
	app.Get("/mcp", handler)
	app.Delete("/mcp", handler)

	if headers == nil {
		headers = map[string][]string{}
	}
	if method == "POST" {
		if _, ok := headers["content-type"]; !ok {
			headers["content-type"] = []string{"application/json"}
		}
		if _, ok := headers["accept"]; !ok {
			headers["accept"] = []string{"application/json, text/event-stream"}
		}
	}

	req := apptheory.Request{
		Method:  method,
		Path:    "/mcp",
		Headers: headers,
		Body:    body,
	}

	resp := app.Serve(ctx, req)
	return &resp, nil
}

func toolCallRequestBody(t *testing.T, name string) []byte {
	t.Helper()
	params := toolsCallParams{Name: name, Arguments: json.RawMessage(`{}`)}
	return mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsCall, Params: mustMarshal(t, params)})
}

// TestToolContextHook_BufferedCallSeesMiddlewarePrincipal proves the buffered
// tools/call path pipes a middleware-set principal into the tool handler
// without reflection.
func TestToolContextHook_BufferedCallSeesMiddlewarePrincipal(t *testing.T) {
	s := NewServer("test-server", "1.0.0", WithToolContextHook(principalPipingHook))
	sessionID := initializeSession(t, s)

	principalSeen := make(chan string, 1)
	if err := s.registry.RegisterTool(
		ToolDef{Name: "whoami", InputSchema: json.RawMessage(`{"type":"object"}`)},
		func(ctx context.Context, _ json.RawMessage) (*ToolResult, error) {
			principal, ok := ctx.Value(toolContextPrincipalKey{}).(string)
			if !ok {
				principal = ""
			}
			principalSeen <- principal
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: principal}}}, nil
		},
	); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	body := toolCallRequestBody(t, "whoami")
	resp, err := invokeWithMiddleware(context.Background(), s, func(next apptheory.Handler) apptheory.Handler {
		return authMiddleware("user-123", next)
	}, "POST", body, sessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}

	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if rpcResp.Error != nil {
		t.Fatalf("unexpected error response: %+v", rpcResp.Error)
	}

	select {
	case got := <-principalSeen:
		if got != "user-123" {
			t.Fatalf("tool saw principal %q, want %q", got, "user-123")
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("tool handler never ran")
	}
}

// TestToolContextHook_StreamingCallSeesMiddlewarePrincipal proves the streaming
// tools/call path (handleToolsCallStream → runStreamingTool) pipes the same
// middleware-set principal into the streaming tool handler.
func TestToolContextHook_StreamingCallSeesMiddlewarePrincipal(t *testing.T) {
	s := NewServer("test-server", "1.0.0", WithToolContextHook(principalPipingHook))
	sessionID := initializeSession(t, s)

	principalSeen := make(chan string, 1)
	if err := s.registry.RegisterStreamingTool(
		ToolDef{Name: "whoami_stream", InputSchema: json.RawMessage(`{"type":"object"}`)},
		func(ctx context.Context, _ json.RawMessage, _ func(SSEEvent)) (*ToolResult, error) {
			principal, ok := ctx.Value(toolContextPrincipalKey{}).(string)
			if !ok {
				principal = ""
			}
			principalSeen <- principal
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: principal}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	resp, err := invokeWithMiddleware(context.Background(), s, func(next apptheory.Handler) apptheory.Handler {
		return authMiddleware("user-456", next)
	}, "POST", toolCallRequestBody(t, "whoami_stream"), headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}

	select {
	case got := <-principalSeen:
		if got != "user-456" {
			t.Fatalf("streaming tool saw principal %q, want %q", got, "user-456")
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("streaming tool handler never ran")
	}

	// Drain the SSE stream so the out-of-band tool run closes out cleanly.
	if resp.BodyReader != nil {
		drainSSE(t, resp.BodyReader)
	}
}

func drainSSE(t *testing.T, r io.Reader) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, r)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("drain SSE stream: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out draining SSE stream")
	}
}

// TestToolContextHook_NotSupplied_LeavesContextUnchanged proves the feature is
// opt-in: middleware values are invisible to tool handlers unless the option is
// supplied, so default behavior is unchanged.
func TestToolContextHook_NotSupplied_LeavesContextUnchanged(t *testing.T) {
	s := NewServer("test-server", "1.0.0") // no WithToolContextHook
	sessionID := initializeSession(t, s)

	var saw any
	if err := s.registry.RegisterTool(
		ToolDef{Name: "peek", InputSchema: json.RawMessage(`{"type":"object"}`)},
		func(ctx context.Context, _ json.RawMessage) (*ToolResult, error) {
			saw = ctx.Value(toolContextPrincipalKey{})
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	body := toolCallRequestBody(t, "peek")
	resp, err := invokeWithMiddleware(context.Background(), s, func(next apptheory.Handler) apptheory.Handler {
		return authMiddleware("user-123", next)
	}, "POST", body, sessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}

	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if rpcResp.Error != nil {
		t.Fatalf("unexpected error response: %+v", rpcResp.Error)
	}
	if saw != nil {
		t.Fatalf("expected no piped value without WithToolContextHook, got %v", saw)
	}
}

// TestToolContextHook_ToolPanicStillRecovered proves installing the hook does
// not weaken the existing panic recovery in the buffered tool-call path.
func TestToolContextHook_ToolPanicStillRecovered(t *testing.T) {
	s := NewServer("test-server", "1.0.0", WithToolContextHook(principalPipingHook))
	sessionID := initializeSession(t, s)

	if err := s.registry.RegisterTool(
		ToolDef{Name: "boom", InputSchema: json.RawMessage(`{"type":"object"}`)},
		func(context.Context, json.RawMessage) (*ToolResult, error) {
			panic("boom")
		},
	); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	body := toolCallRequestBody(t, "boom")
	resp, err := invokeWithMiddleware(context.Background(), s, func(next apptheory.Handler) apptheory.Handler {
		return next
	}, "POST", body, sessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}

	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if rpcResp.Error == nil || rpcResp.Error.Code != CodeInternalError {
		t.Fatalf("expected internal error after tool panic, got %+v", rpcResp.Error)
	}
}

// TestToolContextHook_NilResultKeepsOriginalContext proves the defensive guard
// that a hook returning nil leaves the original request context in place.
func TestToolContextHook_NilResultKeepsOriginalContext(t *testing.T) {
	s := NewServer("test-server", "1.0.0", WithToolContextHook(func(*apptheory.Context, context.Context) context.Context {
		return nil
	}))
	sessionID := initializeSession(t, s)

	markerValue := "preserved"
	var saw any
	if err := s.registry.RegisterTool(
		ToolDef{Name: "peek_marker", InputSchema: json.RawMessage(`{"type":"object"}`)},
		func(ctx context.Context, _ json.RawMessage) (*ToolResult, error) {
			saw = ctx.Value(toolContextPrincipalKey{})
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	ctx := context.WithValue(context.Background(), toolContextPrincipalKey{}, markerValue)
	resp, err := invokeWithMiddleware(ctx, s, func(next apptheory.Handler) apptheory.Handler {
		return next
	}, "POST", toolCallRequestBody(t, "peek_marker"), sessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}

	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if rpcResp.Error != nil {
		t.Fatalf("unexpected error response: %+v", rpcResp.Error)
	}
	if saw != markerValue {
		t.Fatalf("expected original context value %q to survive nil hook result, got %v", markerValue, saw)
	}
}
