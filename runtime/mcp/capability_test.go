package mcp

import (
	"context"
	"encoding/json"
	"testing"
)

func initializeCapabilityMap(t *testing.T, s *Server) map[string]any {
	t.Helper()
	resp := s.handleInitialize(&Request{JSONRPC: "2.0", ID: 1, Method: methodInitialize}, protocolVersion)
	result, ok := resp.Result.(map[string]any)
	if !ok {
		t.Fatalf("expected initialize result object, got %T", resp.Result)
	}
	caps, ok := result["capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("expected capabilities object, got %T", result["capabilities"])
	}
	return caps
}

func TestInitializeCapabilities_FailClosedByRegisteredSurface(t *testing.T) {
	s := NewServer("test", "dev")

	caps := initializeCapabilityMap(t, s)
	for _, name := range []string{"tools", "resources", "prompts", "logging", "completions", "tasks"} {
		if _, ok := caps[name]; ok {
			t.Fatalf("expected empty server not to advertise %q capability: %+v", name, caps)
		}
	}

	if err := s.Registry().RegisterTool(ToolDef{
		Name:        "echo",
		Description: "Echoes input",
		InputSchema: json.RawMessage(`{"type":"object"}`),
	}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register tool: %v", err)
	}
	if err := s.Resources().RegisterResource(ResourceDef{URI: "file://x", Name: "x"}, func(context.Context) ([]ResourceContent, error) {
		return []ResourceContent{{URI: "file://x", Text: "x"}}, nil
	}); err != nil {
		t.Fatalf("register resource: %v", err)
	}
	if err := s.Prompts().RegisterPrompt(PromptDef{Name: "p"}, func(context.Context, json.RawMessage) (*PromptResult, error) {
		return &PromptResult{Messages: []PromptMessage{{Role: "user", Content: ContentBlock{Type: "text", Text: "p"}}}}, nil
	}); err != nil {
		t.Fatalf("register prompt: %v", err)
	}

	caps = initializeCapabilityMap(t, s)
	for _, name := range []string{"tools", "resources", "prompts"} {
		if _, ok := caps[name]; !ok {
			t.Fatalf("expected %q capability for registered surface: %+v", name, caps)
		}
	}
	for _, name := range []string{"logging", "completions", "tasks"} {
		if _, ok := caps[name]; ok {
			t.Fatalf("did not expect unsupported %q capability: %+v", name, caps)
		}
	}
	assertNoUnsupportedSubCapabilities(t, "tools", caps["tools"])
	assertNoUnsupportedSubCapabilities(t, "resources", caps["resources"])
	assertNoUnsupportedSubCapabilities(t, "prompts", caps["prompts"])
}

func TestInitializeCapabilities_ExplicitConfigCanDisableSurface(t *testing.T) {
	s := NewServer("test", "dev", WithCapabilityConfig(CapabilityConfig{
		Tools:     true,
		Resources: false,
		Prompts:   false,
	}))

	if err := s.Registry().RegisterTool(ToolDef{
		Name:        "echo",
		Description: "Echoes input",
		InputSchema: json.RawMessage(`{"type":"object"}`),
	}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register tool: %v", err)
	}
	if err := s.Resources().RegisterResource(ResourceDef{URI: "file://x", Name: "x"}, func(context.Context) ([]ResourceContent, error) {
		return []ResourceContent{{URI: "file://x", Text: "x"}}, nil
	}); err != nil {
		t.Fatalf("register resource: %v", err)
	}
	if err := s.Prompts().RegisterPrompt(PromptDef{Name: "p"}, func(context.Context, json.RawMessage) (*PromptResult, error) {
		return &PromptResult{Messages: []PromptMessage{{Role: "user", Content: ContentBlock{Type: "text", Text: "p"}}}}, nil
	}); err != nil {
		t.Fatalf("register prompt: %v", err)
	}

	caps := initializeCapabilityMap(t, s)
	if _, ok := caps["tools"]; !ok {
		t.Fatalf("expected tools capability when enabled and registered: %+v", caps)
	}
	for _, name := range []string{"resources", "prompts"} {
		if _, ok := caps[name]; ok {
			t.Fatalf("expected explicitly disabled %q capability to be omitted: %+v", name, caps)
		}
	}
}

func TestCapabilityDisables_RejectToolMethods(t *testing.T) {
	s := NewServer("test", "dev", WithCapabilityConfig(CapabilityConfig{
		Tools:       false,
		Resources:   true,
		Prompts:     true,
		Completions: true,
		Tasks:       true,
	}))

	toolCalled := false
	if err := s.Registry().RegisterTool(ToolDef{
		Name:        "secret_tool",
		Description: "Should not run when tools are disabled",
		InputSchema: json.RawMessage(`{"type":"object"}`),
	}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		toolCalled = true
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "SECRET_TOOL_EXECUTED"}}}, nil
	}); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	streamCalled := false
	if err := s.Registry().RegisterStreamingTool(ToolDef{
		Name:        "secret_stream",
		Description: "Should not stream when tools are disabled",
		InputSchema: json.RawMessage(`{"type":"object"}`),
	}, func(context.Context, json.RawMessage, func(SSEEvent)) (*ToolResult, error) {
		streamCalled = true
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "SECRET_STREAM_EXECUTED"}}}, nil
	}); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	caps := initializeCapabilityMap(t, s)
	if _, ok := caps["tools"]; ok {
		t.Fatalf("expected disabled tools capability to be omitted: %+v", caps)
	}

	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	tests := []struct {
		name   string
		method string
		params any
	}{
		{name: "tools list", method: methodToolsList},
		{name: "tools call", method: methodToolsCall, params: map[string]any{"name": "secret_tool", "arguments": map[string]any{}}},
		{name: "tools call stream", method: methodToolsCall, params: map[string]any{"name": "secret_stream", "arguments": map[string]any{}}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var params json.RawMessage
			if tt.params != nil {
				params = mustMarshal(t, tt.params)
			}
			req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: tt.method, Params: params})
			resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
			if err != nil {
				t.Fatalf("invoke %s: %v", tt.method, err)
			}
			if resp.BodyReader != nil {
				t.Fatalf("expected disabled %s to use JSON error path, got BodyReader", tt.method)
			}
			rpcResp, err := parseJSONRPCResponse(resp)
			if err != nil {
				t.Fatalf("parse %s: %v", tt.method, err)
			}
			if rpcResp.Error == nil || rpcResp.Error.Code != CodeMethodNotFound {
				t.Fatalf("expected method-not-found for disabled %s, got %+v", tt.method, rpcResp.Error)
			}
		})
	}

	if toolCalled {
		t.Fatalf("disabled tools/call executed registered tool")
	}
	if streamCalled {
		t.Fatalf("disabled streaming tools/call executed registered streaming tool")
	}
}

func TestInitializeCapabilities_OmitsResourceSubscribeUntilOutboundNotificationsExist(t *testing.T) {
	s := NewServer("test", "dev", WithResourceSubscriptionHooks(
		func(context.Context, ResourceSubscription) error { return nil },
		func(context.Context, ResourceSubscription) error { return nil },
	))
	if err := s.Resources().RegisterResource(ResourceDef{URI: "file://x", Name: "x"}, func(context.Context) ([]ResourceContent, error) {
		return []ResourceContent{{URI: "file://x", Text: "x"}}, nil
	}); err != nil {
		t.Fatalf("register resource: %v", err)
	}

	caps := initializeCapabilityMap(t, s)
	resources, ok := caps["resources"].(map[string]any)
	if !ok {
		t.Fatalf("expected resources capability object: %+v", caps)
	}
	if _, ok := resources["subscribe"]; ok {
		t.Fatalf("did not expect resources.subscribe without outbound notification contract: %+v", resources)
	}
	if _, ok := resources["listChanged"]; ok {
		t.Fatalf("did not expect resources.listChanged overclaim: %+v", resources)
	}
}

func TestInitializeCapabilities_OmitsLoggingUntilOutboundNotificationsExist(t *testing.T) {
	s := NewServer("test", "dev", WithLoggingLevelHook(func(context.Context, LoggingLevelRequest) error { return nil }))

	caps := initializeCapabilityMap(t, s)
	if _, ok := caps["logging"]; ok {
		t.Fatalf("did not expect logging without outbound notification contract: %+v", caps)
	}
}

func TestInitializeCapabilities_AdvertisesCompletionsOnlyWithHook(t *testing.T) {
	s := NewServer("test", "dev", WithCompletionHooks(
		func(context.Context, CompletionRequest) (*CompletionResult, error) {
			return &CompletionResult{Completion: Completion{Values: []string{}}}, nil
		},
		nil,
	))

	caps := initializeCapabilityMap(t, s)
	completions, ok := caps["completions"].(map[string]any)
	if !ok {
		t.Fatalf("expected completions capability object: %+v", caps)
	}
	if len(completions) != 0 {
		t.Fatalf("expected empty completions capability object: %+v", completions)
	}
}

func TestInitializeCapabilities_ExplicitConfigCanDisableCompletions(t *testing.T) {
	s := NewServer("test", "dev",
		WithCapabilityConfig(CapabilityConfig{
			Tools:       true,
			Resources:   true,
			Prompts:     true,
			Completions: false,
		}),
		WithCompletionHooks(
			func(context.Context, CompletionRequest) (*CompletionResult, error) {
				return &CompletionResult{Completion: Completion{Values: []string{}}}, nil
			},
			nil,
		),
	)

	caps := initializeCapabilityMap(t, s)
	if _, ok := caps["completions"]; ok {
		t.Fatalf("expected explicitly disabled completions capability to be omitted: %+v", caps)
	}
}

func assertNoUnsupportedSubCapabilities(t *testing.T, name string, raw any) {
	t.Helper()
	obj, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("expected %s capability object, got %T", name, raw)
	}
	for _, sub := range []string{"listChanged", "subscribe"} {
		if _, ok := obj[sub]; ok {
			t.Fatalf("did not expect %s.%s overclaim: %+v", name, sub, obj)
		}
	}
}
