package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	mcpruntime "github.com/theory-cloud/apptheory/runtime/mcp"
	oauthruntime "github.com/theory-cloud/apptheory/runtime/oauth"
	"github.com/theory-cloud/apptheory/testkit"
)

func TestClaudeRemoteMcp_UnauthorizedChallenge_AndProtectedResourceMetadata(t *testing.T) {
	env := testkit.New()

	mcpServer := mcpruntime.NewServer(
		"ExampleServer",
		"dev",
		mcpruntime.WithServerIDGenerator(env.IDs),
		mcpruntime.WithSessionStore(mcpruntime.NewMemorySessionStore(mcpruntime.WithClock(env.Clock))),
	)

	app := env.App()

	// Public (unauthenticated) RFC9728 metadata endpoint.
	md, err := oauthruntime.NewProtectedResourceMetadata("https://mcp.example.com/mcp", []string{"https://auth.example.com"})
	if err != nil {
		t.Fatalf("NewProtectedResourceMetadata: %v", err)
	}
	app.Get("/.well-known/oauth-protected-resource", oauthruntime.ProtectedResourceMetadataHandler(md))

	// Protect all MCP routes.
	auth := oauthruntime.RequireBearerTokenMiddleware(oauthruntime.RequireBearerTokenOptions{
		ResourceMetadataURL: "https://mcp.example.com/.well-known/oauth-protected-resource",
	})
	protected := auth(mcpServer.Handler())
	app.Post("/mcp", protected)
	app.Get("/mcp", protected)
	app.Delete("/mcp", protected)

	initBody := []byte(`{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "Claude", "version": "unknown" }
  }
}`)

	resp := env.Invoke(context.Background(), app, apptheory.Request{
		Method: "POST",
		Path:   "/mcp",
		Headers: map[string][]string{
			"accept":       {"application/json, text/event-stream"},
			"content-type": {"application/json"},
			"origin":       {"https://claude.ai"},
		},
		Body: initBody,
	})

	if resp.Status != 401 {
		t.Fatalf("expected 401, got %d", resp.Status)
	}
	wa := strings.Join(resp.Headers["www-authenticate"], ",")
	if !strings.Contains(wa, `Bearer`) {
		t.Fatalf("expected www-authenticate to include Bearer, got %q", wa)
	}
	if !strings.Contains(wa, `resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"`) {
		t.Fatalf("expected www-authenticate to include resource_metadata url, got %q", wa)
	}

	var unauthorizedBody map[string]string
	if err := json.Unmarshal(resp.Body, &unauthorizedBody); err != nil {
		t.Fatalf("parse unauthorized body: %v", err)
	}
	if unauthorizedBody["error"] != "unauthorized" {
		t.Fatalf("expected error=unauthorized, got %#v", unauthorizedBody)
	}

	metaResp := env.Invoke(context.Background(), app, apptheory.Request{
		Method: "GET",
		Path:   "/.well-known/oauth-protected-resource",
		Headers: map[string][]string{
			"accept": {"application/json"},
		},
	})
	if metaResp.Status != 200 {
		t.Fatalf("expected 200 from protected resource metadata, got %d", metaResp.Status)
	}

	var meta oauthruntime.ProtectedResourceMetadata
	if err := json.Unmarshal(metaResp.Body, &meta); err != nil {
		t.Fatalf("parse protected resource metadata: %v", err)
	}
	if meta.Resource != "https://mcp.example.com/mcp" {
		t.Fatalf("expected resource=https://mcp.example.com/mcp, got %q", meta.Resource)
	}
	if len(meta.AuthorizationServers) != 1 || meta.AuthorizationServers[0] != "https://auth.example.com" {
		t.Fatalf("expected authorization_servers=[https://auth.example.com], got %#v", meta.AuthorizationServers)
	}
}

func TestClaudeRemoteMcp_Lifecycle_AndStreamingResume_WithBearerAuth(t *testing.T) {
	env := testkit.New()

	mcpServer := mcpruntime.NewServer(
		"ExampleServer",
		"dev",
		mcpruntime.WithServerIDGenerator(env.IDs),
		mcpruntime.WithSessionStore(mcpruntime.NewMemorySessionStore(mcpruntime.WithClock(env.Clock))),
	)

	firstEmitted := make(chan struct{})
	continueTool := make(chan struct{})
	toolDone := make(chan struct{})

	if err := mcpServer.Registry().RegisterStreamingTool(
		mcpruntime.ToolDef{
			Name:        "slow_tool",
			Description: "Emits progress then blocks",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(ctx context.Context, _ json.RawMessage, emit func(mcpruntime.SSEEvent)) (*mcpruntime.ToolResult, error) {
			defer close(toolDone)

			emit(mcpruntime.SSEEvent{Data: map[string]any{"seq": 1, "total": 2, "message": "started"}})
			close(firstEmitted)

			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-continueTool:
			}

			emit(mcpruntime.SSEEvent{Data: map[string]any{"seq": 2, "total": 2, "message": "done"}})
			return &mcpruntime.ToolResult{Content: []mcpruntime.ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	app := env.App()

	md, err := oauthruntime.NewProtectedResourceMetadata("https://mcp.example.com/mcp", []string{"https://auth.example.com"})
	if err != nil {
		t.Fatalf("NewProtectedResourceMetadata: %v", err)
	}
	app.Get("/.well-known/oauth-protected-resource", oauthruntime.ProtectedResourceMetadataHandler(md))

	auth := oauthruntime.RequireBearerTokenMiddleware(oauthruntime.RequireBearerTokenOptions{
		ResourceMetadataURL: "https://mcp.example.com/.well-known/oauth-protected-resource",
	})
	protected := auth(mcpServer.Handler())
	app.Post("/mcp", protected)
	app.Get("/mcp", protected)
	app.Delete("/mcp", protected)

	initBody := []byte(`{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "Claude", "version": "unknown" }
  }
}`)

	initResp := env.Invoke(context.Background(), app, apptheory.Request{
		Method: "POST",
		Path:   "/mcp",
		Headers: map[string][]string{
			"accept":        {"application/json, text/event-stream"},
			"content-type":  {"application/json"},
			"origin":        {"https://claude.ai"},
			"authorization": {"Bearer token-123"},
		},
		Body: initBody,
	})
	if initResp.Status != 200 {
		t.Fatalf("expected 200 from initialize, got %d", initResp.Status)
	}
	sessionID := ""
	if ids := initResp.Headers["mcp-session-id"]; len(ids) > 0 {
		sessionID = strings.TrimSpace(ids[0])
	}
	if sessionID == "" {
		t.Fatalf("expected mcp-session-id header to be set")
	}

	var initRPC mcpruntime.Response
	if err := json.Unmarshal(initResp.Body, &initRPC); err != nil {
		t.Fatalf("parse initialize JSON-RPC response: %v", err)
	}
	var initResult struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	initResultBytes, _ := json.Marshal(initRPC.Result)
	_ = json.Unmarshal(initResultBytes, &initResult)
	if strings.TrimSpace(initResult.ProtocolVersion) != "2025-06-18" {
		t.Fatalf("expected protocolVersion=2025-06-18, got %q", initResult.ProtocolVersion)
	}

	initializedBody := []byte(`{ "jsonrpc":"2.0", "method":"notifications/initialized" }`)
	initializedResp := env.Invoke(context.Background(), app, apptheory.Request{
		Method: "POST",
		Path:   "/mcp",
		Headers: map[string][]string{
			"accept":               {"application/json, text/event-stream"},
			"content-type":         {"application/json"},
			"origin":               {"https://claude.ai"},
			"authorization":        {"Bearer token-123"},
			"mcp-session-id":       {sessionID},
			"mcp-protocol-version": {"2025-06-18"},
		},
		Body: initializedBody,
	})
	if initializedResp.Status != 202 || len(initializedResp.Body) != 0 {
		t.Fatalf("expected 202 with empty body for notifications/initialized, got status=%d body_len=%d", initializedResp.Status, len(initializedResp.Body))
	}

	client := &Client{
		server:    mcpServer,
		env:       env,
		app:       app,
		sessionID: sessionID,
		protocol:  "2025-06-18",
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
		ID:      2,
		Method:  "tools/call",
		Params:  paramsBytes,
	}

	stream, err := client.RawStream(context.Background(), req, map[string][]string{
		"origin":        {"https://claude.ai"},
		"authorization": {"Bearer token-123"},
	})
	if err != nil {
		t.Fatalf("RawStream: %v", err)
	}

	select {
	case <-firstEmitted:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first progress emission")
	}

	firstMsg, err := stream.Next()
	if err != nil {
		t.Fatalf("read first SSE message: %v", err)
	}
	if strings.TrimSpace(firstMsg.ID) == "" {
		t.Fatalf("expected first SSE message to include id")
	}
	if !strings.Contains(string(firstMsg.Data), `"method":"notifications/progress"`) {
		t.Fatalf("expected progress notification in first event, got: %s", string(firstMsg.Data))
	}

	// Simulate disconnect.
	stream.Cancel()

	// Let the tool complete after disconnect.
	close(continueTool)
	select {
	case <-toolDone:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for tool completion")
	}

	resumed, err := client.ResumeStream(context.Background(), firstMsg.ID, map[string][]string{
		"origin":        {"https://claude.ai"},
		"authorization": {"Bearer token-123"},
	})
	if err != nil {
		t.Fatalf("ResumeStream: %v", err)
	}

	readCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	doneCh := make(chan struct{})
	var msgs []SSEMessage
	var readErr error
	go func() {
		defer close(doneCh)
		msgs, readErr = resumed.ReadAll()
	}()

	select {
	case <-doneCh:
	case <-readCtx.Done():
		t.Fatalf("timed out reading resumed SSE stream")
	}
	if readErr != nil {
		t.Fatalf("read resumed SSE stream: %v", readErr)
	}

	foundFinal := false
	for _, msg := range msgs {
		if strings.Contains(string(msg.Data), `"result"`) {
			foundFinal = true
			break
		}
	}
	if !foundFinal {
		t.Fatalf("expected resumed stream to include final result; got %d messages", len(msgs))
	}
}
