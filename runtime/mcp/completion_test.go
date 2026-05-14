package mcp

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestCompletionHooks_RoutePromptAndResource(t *testing.T) {
	hasMore := false
	total := 2
	var promptReq CompletionRequest
	var resourceReq CompletionRequest
	s := NewServer("test", "1.0.0", WithCompletionHooks(
		func(_ context.Context, req CompletionRequest) (*CompletionResult, error) {
			promptReq = req
			return &CompletionResult{Completion: Completion{Values: []string{"go"}, Total: &total, HasMore: &hasMore}}, nil
		},
		func(_ context.Context, req CompletionRequest) (*CompletionResult, error) {
			resourceReq = req
			return &CompletionResult{Completion: Completion{Values: []string{"file://x"}}}, nil
		},
	))
	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	promptParams := mustMarshal(t, map[string]any{
		"ref":      map[string]any{"type": completionRefPrompt, "name": "review"},
		"argument": map[string]any{"name": "language", "value": "g"},
		"context":  map[string]any{"arguments": map[string]string{"mode": "strict"}},
	})
	promptReqBody := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodCompletionComplete, Params: promptParams})
	promptResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", promptReqBody, headers)
	if err != nil {
		t.Fatalf("invoke prompt completion: %v", err)
	}
	rpcPrompt, err := parseJSONRPCResponse(promptResp)
	if err != nil {
		t.Fatalf("parse prompt completion: %v", err)
	}
	if rpcPrompt.Error != nil {
		t.Fatalf("unexpected prompt completion error: %+v", rpcPrompt.Error)
	}
	if promptReq.SessionID != sessionID || promptReq.Ref.Name != "review" || promptReq.Argument.Name != "language" || promptReq.Argument.Value != "g" {
		t.Fatalf("unexpected prompt hook request: %+v", promptReq)
	}
	if promptReq.Context.Arguments["mode"] != "strict" {
		t.Fatalf("unexpected prompt context: %+v", promptReq.Context)
	}

	resourceParams := mustMarshal(t, map[string]any{
		"ref":      map[string]any{"type": completionRefResource, "uri": "file:///{path}"},
		"argument": map[string]any{"name": "path", "value": "x"},
	})
	resourceReqBody := mustMarshal(t, Request{JSONRPC: "2.0", ID: 2, Method: methodCompletionComplete, Params: resourceParams})
	resourceResp, err := invokeHandlerWithMethod(context.Background(), s, "POST", resourceReqBody, headers)
	if err != nil {
		t.Fatalf("invoke resource completion: %v", err)
	}
	rpcResource, err := parseJSONRPCResponse(resourceResp)
	if err != nil {
		t.Fatalf("parse resource completion: %v", err)
	}
	if rpcResource.Error != nil {
		t.Fatalf("unexpected resource completion error: %+v", rpcResource.Error)
	}
	if resourceReq.SessionID != sessionID || resourceReq.Ref.URI != "file:///{path}" || resourceReq.Argument.Name != "path" {
		t.Fatalf("unexpected resource hook request: %+v", resourceReq)
	}
}

func TestCompletionHooks_FailClosedWhenUnconfigured(t *testing.T) {
	s := NewServer("test", "1.0.0")
	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	params := mustMarshal(t, map[string]any{
		"ref":      map[string]any{"type": completionRefPrompt, "name": "review"},
		"argument": map[string]any{"name": "language", "value": "g"},
	})
	req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodCompletionComplete, Params: params})
	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
	if err != nil {
		t.Fatalf("invoke completion/complete: %v", err)
	}
	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("parse completion/complete: %v", err)
	}
	if rpcResp.Error == nil || rpcResp.Error.Code != CodeMethodNotFound {
		t.Fatalf("expected method-not-found for unconfigured completions, got: %+v", rpcResp.Error)
	}
}

func TestCompletionHooks_ValidateParams(t *testing.T) {
	tests := []struct {
		name   string
		params map[string]any
	}{
		{name: "missing ref type", params: map[string]any{
			"ref":      map[string]any{"name": "review"},
			"argument": map[string]any{"name": "language", "value": "g"},
		}},
		{name: "missing prompt name", params: map[string]any{
			"ref":      map[string]any{"type": completionRefPrompt},
			"argument": map[string]any{"name": "language", "value": "g"},
		}},
		{name: "missing resource uri", params: map[string]any{
			"ref":      map[string]any{"type": completionRefResource},
			"argument": map[string]any{"name": "path", "value": "x"},
		}},
		{name: "unknown ref type", params: map[string]any{
			"ref":      map[string]any{"type": "ref/tool", "name": "echo"},
			"argument": map[string]any{"name": "arg", "value": "x"},
		}},
		{name: "missing argument name", params: map[string]any{
			"ref":      map[string]any{"type": completionRefPrompt, "name": "review"},
			"argument": map[string]any{"value": "g"},
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewServer("test", "1.0.0", WithCompletionHooks(
				func(context.Context, CompletionRequest) (*CompletionResult, error) {
					return &CompletionResult{Completion: Completion{Values: []string{}}}, nil
				},
				func(context.Context, CompletionRequest) (*CompletionResult, error) {
					return &CompletionResult{Completion: Completion{Values: []string{}}}, nil
				},
			))
			sessionID := initializeSession(t, s)
			headers := sessionHeaders(sessionID)
			headers["accept"] = []string{"application/json, text/event-stream"}

			req := mustMarshal(t, Request{
				JSONRPC: "2.0",
				ID:      1,
				Method:  methodCompletionComplete,
				Params:  mustMarshal(t, tt.params),
			})
			resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
			if err != nil {
				t.Fatalf("invoke completion/complete: %v", err)
			}
			rpcResp, err := parseJSONRPCResponse(resp)
			if err != nil {
				t.Fatalf("parse completion/complete: %v", err)
			}
			if rpcResp.Error == nil || rpcResp.Error.Code != CodeInvalidParams {
				t.Fatalf("expected invalid params, got: %+v", rpcResp.Error)
			}
		})
	}
}

func TestCompletionHooks_MissingSpecificHookIsInvalidParams(t *testing.T) {
	s := NewServer("test", "1.0.0", WithCompletionHooks(
		func(context.Context, CompletionRequest) (*CompletionResult, error) {
			return &CompletionResult{Completion: Completion{Values: []string{}}}, nil
		},
		nil,
	))
	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	params := mustMarshal(t, map[string]any{
		"ref":      map[string]any{"type": completionRefResource, "uri": "file:///{path}"},
		"argument": map[string]any{"name": "path", "value": "x"},
	})
	req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodCompletionComplete, Params: params})
	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
	if err != nil {
		t.Fatalf("invoke completion/complete: %v", err)
	}
	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("parse completion/complete: %v", err)
	}
	if rpcResp.Error == nil || rpcResp.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid params for missing resource hook, got: %+v", rpcResp.Error)
	}
}

func TestCompletionHooks_HookAndResultErrors(t *testing.T) {
	tests := []struct {
		name string
		hook CompletionHook
	}{
		{
			name: "hook error",
			hook: func(context.Context, CompletionRequest) (*CompletionResult, error) {
				return nil, errors.New("completion denied")
			},
		},
		{
			name: "nil result",
			hook: func(context.Context, CompletionRequest) (*CompletionResult, error) {
				return nil, nil
			},
		},
		{
			name: "nil values",
			hook: func(context.Context, CompletionRequest) (*CompletionResult, error) {
				return &CompletionResult{}, nil
			},
		},
		{
			name: "too many values",
			hook: func(context.Context, CompletionRequest) (*CompletionResult, error) {
				values := make([]string, 101)
				for i := range values {
					values[i] = fmt.Sprintf("value-%d", i)
				}
				return &CompletionResult{Completion: Completion{Values: values}}, nil
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewServer("test", "1.0.0", WithCompletionHooks(tt.hook, nil))
			sessionID := initializeSession(t, s)
			headers := sessionHeaders(sessionID)
			headers["accept"] = []string{"application/json, text/event-stream"}

			params := mustMarshal(t, map[string]any{
				"ref":      map[string]any{"type": completionRefPrompt, "name": "review"},
				"argument": map[string]any{"name": "language", "value": "g"},
			})
			req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodCompletionComplete, Params: params})
			resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
			if err != nil {
				t.Fatalf("invoke completion/complete: %v", err)
			}
			rpcResp, err := parseJSONRPCResponse(resp)
			if err != nil {
				t.Fatalf("parse completion/complete: %v", err)
			}
			if rpcResp.Error == nil || rpcResp.Error.Code != CodeServerError {
				t.Fatalf("expected server error, got: %+v", rpcResp.Error)
			}
		})
	}
}
