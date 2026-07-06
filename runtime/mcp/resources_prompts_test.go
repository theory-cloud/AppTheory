package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func mustMarshal(t testing.TB, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal json: %v", err)
	}
	return b
}

func TestResourcesListAndRead_RoundTrip(t *testing.T) {
	s := NewServer("test", "1.0.0")

	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	if err := s.Resources().RegisterResource(ResourceDef{
		URI:         "file://hello.txt",
		Name:        "hello",
		Description: "test",
		MimeType:    "text/plain",
	}, func(_ context.Context) ([]ResourceContent, error) {
		return []ResourceContent{{URI: "file://hello.txt", MimeType: "text/plain", Text: "hello"}}, nil
	}); err != nil {
		t.Fatalf("register resource: %v", err)
	}

	listReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodResourcesList})
	listResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", listReq, headers)
	if err != nil {
		t.Fatalf("invoke resources/list: %v", err)
	}
	rpcList, err := parseJSONRPCResponse(listResp)
	if err != nil {
		t.Fatalf("parse resources/list: %v", err)
	}
	if rpcList.Error != nil {
		t.Fatalf("unexpected error: %+v", rpcList.Error)
	}

	resultBytes := mustMarshal(t, rpcList.Result)
	var listResult struct {
		Resources []ResourceDef `json:"resources"`
	}
	if unmarshalErr := json.Unmarshal(resultBytes, &listResult); unmarshalErr != nil {
		t.Fatalf("unmarshal list result: %v", unmarshalErr)
	}
	if len(listResult.Resources) != 1 || listResult.Resources[0].URI != "file://hello.txt" {
		t.Fatalf("unexpected resources: %+v", listResult.Resources)
	}

	readParams := mustMarshal(t, map[string]any{"uri": "file://hello.txt"})
	readReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 2, Method: methodResourcesRead, Params: readParams})
	readResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", readReq, headers)
	if err != nil {
		t.Fatalf("invoke resources/read: %v", err)
	}
	rpcRead, err := parseJSONRPCResponse(readResp)
	if err != nil {
		t.Fatalf("parse resources/read: %v", err)
	}
	if rpcRead.Error != nil {
		t.Fatalf("unexpected error: %+v", rpcRead.Error)
	}

	readResultBytes := mustMarshal(t, rpcRead.Result)
	var readResult struct {
		Contents []ResourceContent `json:"contents"`
	}
	if unmarshalErr := json.Unmarshal(readResultBytes, &readResult); unmarshalErr != nil {
		t.Fatalf("unmarshal read result: %v", unmarshalErr)
	}
	if len(readResult.Contents) != 1 || readResult.Contents[0].Text != "hello" {
		t.Fatalf("unexpected contents: %+v", readResult.Contents)
	}
}

func TestResourceTemplatesList_RoundTrip(t *testing.T) {
	s := NewServer("test", "1.0.0")
	if err := s.Resources().RegisterResourceTemplate(ResourceTemplateDef{
		URITemplate: "file:///{path}",
		Name:        "project-file",
		Title:       "Project file",
		Description: "Read a project file by path",
		MimeType:    "text/plain",
	}); err != nil {
		t.Fatalf("register resource template: %v", err)
	}

	caps := s.initializeCapabilities(protocolVersion)
	if _, ok := caps["resources"].(map[string]any); !ok {
		t.Fatalf("expected resources capability for template-only server: %+v", caps)
	}

	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodResourcesTemplatesList})
	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
	if err != nil {
		t.Fatalf("invoke resources/templates/list: %v", err)
	}
	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("parse resources/templates/list: %v", err)
	}
	if rpcResp.Error != nil {
		t.Fatalf("unexpected error: %+v", rpcResp.Error)
	}

	resultBytes := mustMarshal(t, rpcResp.Result)
	var out struct {
		ResourceTemplates []ResourceTemplateDef `json:"resourceTemplates"`
	}
	if err := json.Unmarshal(resultBytes, &out); err != nil {
		t.Fatalf("unmarshal template result: %v", err)
	}
	if len(out.ResourceTemplates) != 1 || out.ResourceTemplates[0].URITemplate != "file:///{path}" {
		t.Fatalf("unexpected resource templates: %+v", out.ResourceTemplates)
	}
}

func TestResourceAndPromptRegistryValidation(t *testing.T) {
	resources := NewResourceRegistry()
	if err := resources.RegisterResource(ResourceDef{}, func(context.Context) ([]ResourceContent, error) { return nil, nil }); err == nil {
		t.Fatalf("expected missing resource uri to fail")
	}
	if err := resources.RegisterResource(ResourceDef{URI: "file://x"}, func(context.Context) ([]ResourceContent, error) { return nil, nil }); err == nil {
		t.Fatalf("expected missing resource name to fail")
	}
	if err := resources.RegisterResource(ResourceDef{URI: "file://x", Name: "x"}, nil); err == nil {
		t.Fatalf("expected nil resource handler to fail")
	}
	if err := resources.RegisterResource(ResourceDef{URI: "file://x", Name: "x"}, func(context.Context) ([]ResourceContent, error) {
		return []ResourceContent{{URI: "file://x", Text: "x"}}, nil
	}); err != nil {
		t.Fatalf("register resource: %v", err)
	}
	if err := resources.RegisterResource(ResourceDef{URI: "file://x", Name: "x"}, func(context.Context) ([]ResourceContent, error) { return nil, nil }); err == nil {
		t.Fatalf("expected duplicate resource to fail")
	}
	if err := resources.RegisterResourceTemplate(ResourceTemplateDef{}); err == nil {
		t.Fatalf("expected missing resource template uriTemplate to fail")
	}
	if err := resources.RegisterResourceTemplate(ResourceTemplateDef{URITemplate: "file:///{path}"}); err == nil {
		t.Fatalf("expected missing resource template name to fail")
	}
	if err := resources.RegisterResourceTemplate(ResourceTemplateDef{URITemplate: "file:///{path}", Name: "project-file"}); err != nil {
		t.Fatalf("register resource template: %v", err)
	}
	if err := resources.RegisterResourceTemplate(ResourceTemplateDef{URITemplate: "file:///{path}", Name: "project-file"}); err == nil {
		t.Fatalf("expected duplicate resource template to fail")
	}

	prompts := NewPromptRegistry()
	if err := prompts.RegisterPrompt(PromptDef{}, func(context.Context, json.RawMessage) (*PromptResult, error) { return nil, nil }); err == nil {
		t.Fatalf("expected missing prompt name to fail")
	}
	if err := prompts.RegisterPrompt(PromptDef{Name: "p"}, nil); err == nil {
		t.Fatalf("expected nil prompt handler to fail")
	}
	if err := prompts.RegisterPrompt(PromptDef{Name: "p"}, func(context.Context, json.RawMessage) (*PromptResult, error) {
		return &PromptResult{Messages: []PromptMessage{{Role: "user", Content: ContentBlock{Type: "text", Text: "p"}}}}, nil
	}); err != nil {
		t.Fatalf("register prompt: %v", err)
	}
	if err := prompts.RegisterPrompt(PromptDef{Name: "p"}, func(context.Context, json.RawMessage) (*PromptResult, error) { return nil, nil }); err == nil {
		t.Fatalf("expected duplicate prompt to fail")
	}
}

func TestPromptsListAndGet_RoundTrip(t *testing.T) {
	s := NewServer("test", "1.0.0")

	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	if err := s.Prompts().RegisterPrompt(PromptDef{
		Name:        "greet",
		Description: "test",
	}, func(_ context.Context, _ json.RawMessage) (*PromptResult, error) {
		return &PromptResult{
			Messages: []PromptMessage{
				{Role: "user", Content: ContentBlock{Type: "text", Text: "hello"}},
			},
		}, nil
	}); err != nil {
		t.Fatalf("register prompt: %v", err)
	}

	listReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodPromptsList})
	listResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", listReq, headers)
	if err != nil {
		t.Fatalf("invoke prompts/list: %v", err)
	}
	rpcList, err := parseJSONRPCResponse(listResp)
	if err != nil {
		t.Fatalf("parse prompts/list: %v", err)
	}
	if rpcList.Error != nil {
		t.Fatalf("unexpected error: %+v", rpcList.Error)
	}

	resultBytes := mustMarshal(t, rpcList.Result)
	var listResult struct {
		Prompts []PromptDef `json:"prompts"`
	}
	if unmarshalErr := json.Unmarshal(resultBytes, &listResult); unmarshalErr != nil {
		t.Fatalf("unmarshal list result: %v", unmarshalErr)
	}
	if len(listResult.Prompts) != 1 || listResult.Prompts[0].Name != "greet" {
		t.Fatalf("unexpected prompts: %+v", listResult.Prompts)
	}

	getParams := mustMarshal(t, map[string]any{"name": "greet", "arguments": json.RawMessage(`{}`)})
	getReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 2, Method: methodPromptsGet, Params: getParams})
	getResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", getReq, headers)
	if err != nil {
		t.Fatalf("invoke prompts/get: %v", err)
	}
	rpcGet, err := parseJSONRPCResponse(getResp)
	if err != nil {
		t.Fatalf("parse prompts/get: %v", err)
	}
	if rpcGet.Error != nil {
		t.Fatalf("unexpected error: %+v", rpcGet.Error)
	}

	getResultBytes := mustMarshal(t, rpcGet.Result)
	var out PromptResult
	if unmarshalErr := json.Unmarshal(getResultBytes, &out); unmarshalErr != nil {
		t.Fatalf("unmarshal get result: %v", unmarshalErr)
	}
	if len(out.Messages) != 1 || out.Messages[0].Content.Text != "hello" {
		t.Fatalf("unexpected messages: %+v", out.Messages)
	}
}

func TestCapabilityDisables_RejectResourceAndPromptMethods(t *testing.T) {
	s := NewServer("test", "1.0.0",
		WithCapabilityConfig(CapabilityConfig{
			Tools:       true,
			Resources:   false,
			Prompts:     false,
			Completions: true,
			Tasks:       true,
		}),
		WithResourceSubscriptionHooks(
			func(context.Context, ResourceSubscription) error { return nil },
			func(context.Context, ResourceSubscription) error { return nil },
		),
	)
	if err := s.Resources().RegisterResource(ResourceDef{URI: "file://hello.txt", Name: "hello"}, func(context.Context) ([]ResourceContent, error) {
		return []ResourceContent{{URI: "file://hello.txt", Text: "hello"}}, nil
	}); err != nil {
		t.Fatalf("register resource: %v", err)
	}
	if err := s.Prompts().RegisterPrompt(PromptDef{Name: "greet"}, func(context.Context, json.RawMessage) (*PromptResult, error) {
		return &PromptResult{Messages: []PromptMessage{{Role: "user", Content: ContentBlock{Type: "text", Text: "hello"}}}}, nil
	}); err != nil {
		t.Fatalf("register prompt: %v", err)
	}

	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	tests := []struct {
		name   string
		method string
		params any
	}{
		{name: "resources list", method: methodResourcesList},
		{name: "resources read", method: methodResourcesRead, params: map[string]any{"uri": "file://hello.txt"}},
		{name: "resources templates list", method: methodResourcesTemplatesList},
		{name: "resources subscribe", method: methodResourcesSubscribe, params: map[string]any{"uri": "file://hello.txt"}},
		{name: "resources unsubscribe", method: methodResourcesUnsubscribe, params: map[string]any{"uri": "file://hello.txt"}},
		{name: "prompts list", method: methodPromptsList},
		{name: "prompts get", method: methodPromptsGet, params: map[string]any{"name": "greet"}},
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
			rpcResp, err := parseJSONRPCResponse(resp)
			if err != nil {
				t.Fatalf("parse %s: %v", tt.method, err)
			}
			if rpcResp.Error == nil || rpcResp.Error.Code != CodeMethodNotFound {
				t.Fatalf("expected method-not-found for disabled %s, got %+v", tt.method, rpcResp.Error)
			}
		})
	}
}

func TestResourcesRead_NotFoundIsInvalidParams(t *testing.T) {
	s := NewServer("test", "1.0.0")

	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	readParams := mustMarshal(t, map[string]any{"uri": "file://missing.txt"})
	readReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodResourcesRead, Params: readParams})
	readResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", readReq, headers)
	if err != nil {
		t.Fatalf("invoke resources/read: %v", err)
	}
	rpcRead, err := parseJSONRPCResponse(readResp)
	if err != nil {
		t.Fatalf("parse resources/read: %v", err)
	}
	if rpcRead.Error == nil || rpcRead.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid params error, got: %+v", rpcRead.Error)
	}
}

func TestResourceSubscriptionHooks_RoundTrip(t *testing.T) {
	var subscribed ResourceSubscription
	var unsubscribed ResourceSubscription
	s := NewServer("test", "1.0.0", WithResourceSubscriptionHooks(
		func(_ context.Context, sub ResourceSubscription) error {
			subscribed = sub
			return nil
		},
		func(_ context.Context, sub ResourceSubscription) error {
			unsubscribed = sub
			return nil
		},
	))
	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	if err := s.Resources().RegisterResource(ResourceDef{URI: "file://hello.txt", Name: "hello"}, func(context.Context) ([]ResourceContent, error) {
		return []ResourceContent{{URI: "file://hello.txt", Text: "hello"}}, nil
	}); err != nil {
		t.Fatalf("register resource: %v", err)
	}

	params := mustMarshal(t, map[string]any{"uri": "file://hello.txt"})
	subscribeReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodResourcesSubscribe, Params: params})
	subscribeResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", subscribeReq, headers)
	if err != nil {
		t.Fatalf("invoke resources/subscribe: %v", err)
	}
	rpcSubscribe, err := parseJSONRPCResponse(subscribeResp)
	if err != nil {
		t.Fatalf("parse resources/subscribe: %v", err)
	}
	if rpcSubscribe.Error != nil {
		t.Fatalf("unexpected subscribe error: %+v", rpcSubscribe.Error)
	}
	if subscribed.SessionID != sessionID || subscribed.URI != "file://hello.txt" {
		t.Fatalf("unexpected subscribe hook request: %+v", subscribed)
	}

	unsubscribeReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 2, Method: methodResourcesUnsubscribe, Params: params})
	unsubscribeResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", unsubscribeReq, headers)
	if err != nil {
		t.Fatalf("invoke resources/unsubscribe: %v", err)
	}
	rpcUnsubscribe, err := parseJSONRPCResponse(unsubscribeResp)
	if err != nil {
		t.Fatalf("parse resources/unsubscribe: %v", err)
	}
	if rpcUnsubscribe.Error != nil {
		t.Fatalf("unexpected unsubscribe error: %+v", rpcUnsubscribe.Error)
	}
	if unsubscribed.SessionID != sessionID || unsubscribed.URI != "file://hello.txt" {
		t.Fatalf("unexpected unsubscribe hook request: %+v", unsubscribed)
	}
}

func TestResourceSubscriptionHooks_FailClosedWhenUnconfigured(t *testing.T) {
	tests := []struct {
		name string
		opts []ServerOption
	}{
		{name: "no hooks"},
		{
			name: "partial hooks",
			opts: []ServerOption{WithResourceSubscriptionHooks(
				func(context.Context, ResourceSubscription) error { return nil },
				nil,
			)},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewServer("test", "1.0.0", tt.opts...)
			sessionID := initializeSession(t, s)
			headers := sessionHeaders(sessionID)
			headers["accept"] = []string{"application/json, text/event-stream"}

			params := mustMarshal(t, map[string]any{"uri": "file://hello.txt"})
			req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodResourcesSubscribe, Params: params})
			resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
			if err != nil {
				t.Fatalf("invoke resources/subscribe: %v", err)
			}
			rpcResp, err := parseJSONRPCResponse(resp)
			if err != nil {
				t.Fatalf("parse resources/subscribe: %v", err)
			}
			if rpcResp.Error == nil || rpcResp.Error.Code != CodeMethodNotFound {
				t.Fatalf("expected method-not-found for unconfigured subscribe, got: %+v", rpcResp.Error)
			}
		})
	}
}

func TestResourceSubscriptionHooks_ValidateParamsAndErrors(t *testing.T) {
	t.Run("missing uri", func(t *testing.T) {
		s := NewServer("test", "1.0.0", WithResourceSubscriptionHooks(
			func(context.Context, ResourceSubscription) error { return nil },
			func(context.Context, ResourceSubscription) error { return nil },
		))
		sessionID := initializeSession(t, s)
		headers := sessionHeaders(sessionID)
		headers["accept"] = []string{"application/json, text/event-stream"}

		req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodResourcesSubscribe, Params: json.RawMessage(`{}`)})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
		if err != nil {
			t.Fatalf("invoke resources/subscribe: %v", err)
		}
		rpcResp, err := parseJSONRPCResponse(resp)
		if err != nil {
			t.Fatalf("parse resources/subscribe: %v", err)
		}
		if rpcResp.Error == nil || rpcResp.Error.Code != CodeInvalidParams {
			t.Fatalf("expected invalid params for missing uri, got: %+v", rpcResp.Error)
		}
	})

	t.Run("malformed uri", func(t *testing.T) {
		called := false
		s := NewServer("test", "1.0.0", WithResourceSubscriptionHooks(
			func(context.Context, ResourceSubscription) error {
				called = true
				return nil
			},
			func(context.Context, ResourceSubscription) error { return nil },
		))
		sessionID := initializeSession(t, s)
		headers := sessionHeaders(sessionID)
		headers["accept"] = []string{"application/json, text/event-stream"}

		params := mustMarshal(t, map[string]any{"uri": "relative/path"})
		req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodResourcesSubscribe, Params: params})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
		if err != nil {
			t.Fatalf("invoke resources/subscribe: %v", err)
		}
		rpcResp, err := parseJSONRPCResponse(resp)
		if err != nil {
			t.Fatalf("parse resources/subscribe: %v", err)
		}
		if rpcResp.Error == nil || rpcResp.Error.Code != CodeInvalidParams || !strings.Contains(rpcResp.Error.Message, "invalid uri") {
			t.Fatalf("expected invalid params for malformed uri, got: %+v", rpcResp.Error)
		}
		if called {
			t.Fatalf("subscription hook ran for malformed uri")
		}
	})

	t.Run("unregistered uri", func(t *testing.T) {
		called := false
		s := NewServer("test", "1.0.0", WithResourceSubscriptionHooks(
			func(context.Context, ResourceSubscription) error {
				called = true
				return nil
			},
			func(context.Context, ResourceSubscription) error { return nil },
		))
		sessionID := initializeSession(t, s)
		headers := sessionHeaders(sessionID)
		headers["accept"] = []string{"application/json, text/event-stream"}

		params := mustMarshal(t, map[string]any{"uri": "file://missing.txt"})
		req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodResourcesSubscribe, Params: params})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
		if err != nil {
			t.Fatalf("invoke resources/subscribe: %v", err)
		}
		rpcResp, err := parseJSONRPCResponse(resp)
		if err != nil {
			t.Fatalf("parse resources/subscribe: %v", err)
		}
		if rpcResp.Error == nil || rpcResp.Error.Code != CodeInvalidParams || !strings.Contains(rpcResp.Error.Message, "resource not found") {
			t.Fatalf("expected invalid params for unregistered uri, got: %+v", rpcResp.Error)
		}
		if called {
			t.Fatalf("subscription hook ran for unregistered uri")
		}
	})

	t.Run("hook error", func(t *testing.T) {
		s := NewServer("test", "1.0.0", WithResourceSubscriptionHooks(
			func(context.Context, ResourceSubscription) error { return errors.New("subscribe denied") },
			func(context.Context, ResourceSubscription) error { return nil },
		))
		sessionID := initializeSession(t, s)
		headers := sessionHeaders(sessionID)
		headers["accept"] = []string{"application/json, text/event-stream"}
		if err := s.Resources().RegisterResource(ResourceDef{URI: "file://hello.txt", Name: "hello"}, func(context.Context) ([]ResourceContent, error) {
			return []ResourceContent{{URI: "file://hello.txt", Text: "hello"}}, nil
		}); err != nil {
			t.Fatalf("register resource: %v", err)
		}

		params := mustMarshal(t, map[string]any{"uri": "file://hello.txt"})
		req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodResourcesSubscribe, Params: params})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
		if err != nil {
			t.Fatalf("invoke resources/subscribe: %v", err)
		}
		rpcResp, err := parseJSONRPCResponse(resp)
		if err != nil {
			t.Fatalf("parse resources/subscribe: %v", err)
		}
		if rpcResp.Error == nil || rpcResp.Error.Code != CodeServerError {
			t.Fatalf("expected server error for hook error, got: %+v", rpcResp.Error)
		}
	})
}

func TestPromptsGet_NotFoundIsInvalidParams(t *testing.T) {
	s := NewServer("test", "1.0.0")

	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	getParams := mustMarshal(t, map[string]any{"name": "missing", "arguments": json.RawMessage(`{}`)})
	getReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodPromptsGet, Params: getParams})
	getResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", getReq, headers)
	if err != nil {
		t.Fatalf("invoke prompts/get: %v", err)
	}
	rpcGet, err := parseJSONRPCResponse(getResp)
	if err != nil {
		t.Fatalf("parse prompts/get: %v", err)
	}
	if rpcGet.Error == nil || rpcGet.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid params error, got: %+v", rpcGet.Error)
	}
}
