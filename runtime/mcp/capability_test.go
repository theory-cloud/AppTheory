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

func TestInitializeCapabilities_AdvertisesResourceSubscribeOnlyWithHooks(t *testing.T) {
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
	if resources["subscribe"] != true {
		t.Fatalf("expected resources.subscribe capability with hooks: %+v", resources)
	}
	if _, ok := resources["listChanged"]; ok {
		t.Fatalf("did not expect resources.listChanged overclaim: %+v", resources)
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
