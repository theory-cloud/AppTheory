package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestHandlerErrorSanitization_ResourcePromptAndCompletion(t *testing.T) {
	for _, verbose := range []bool{false, true} {
		t.Run(map[bool]string{false: "default", true: "verbose"}[verbose], func(t *testing.T) {
			opts := []ServerOption{
				WithCompletionHooks(func(context.Context, CompletionRequest) (*CompletionResult, error) {
					return nil, errors.New("completion secret detail")
				}, nil),
			}
			if verbose {
				opts = append(opts, WithVerboseHandlerErrors(true))
			}
			s := NewServer("test", "dev", opts...)

			if err := s.Resources().RegisterResource(ResourceDef{URI: "file://secret.txt", Name: "secret"}, func(context.Context) ([]ResourceContent, error) {
				return nil, errors.New("resource secret detail")
			}); err != nil {
				t.Fatalf("register resource: %v", err)
			}
			if err := s.Prompts().RegisterPrompt(PromptDef{Name: "secret"}, func(context.Context, json.RawMessage) (*PromptResult, error) {
				return nil, errors.New("prompt secret detail")
			}); err != nil {
				t.Fatalf("register prompt: %v", err)
			}

			sessionID := initializeSession(t, s)
			headers := sessionHeaders(sessionID)
			headers["accept"] = []string{"application/json, text/event-stream"}

			assertSanitized := func(name string, req *Request, original string) {
				t.Helper()
				body := mustMarshal(t, req)
				resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
				if err != nil {
					t.Fatalf("%s handler: %v", name, err)
				}
				rpcResp, err := parseJSONRPCResponse(resp)
				if err != nil {
					t.Fatalf("%s parse: %v", name, err)
				}
				if rpcResp.Error == nil || rpcResp.Error.Code != CodeServerError {
					t.Fatalf("%s expected server error, got %+v", name, rpcResp.Error)
				}
				want := genericHandlerErrorMessage
				if verbose {
					want = original
				}
				if rpcResp.Error.Message != want {
					t.Fatalf("%s message: got %q want %q", name, rpcResp.Error.Message, want)
				}
			}

			assertSanitized("resources/read", &Request{
				JSONRPC: "2.0",
				ID:      1,
				Method:  methodResourcesRead,
				Params:  mustMarshal(t, map[string]any{"uri": "file://secret.txt"}),
			}, "resource secret detail")

			assertSanitized("prompts/get", &Request{
				JSONRPC: "2.0",
				ID:      2,
				Method:  methodPromptsGet,
				Params:  mustMarshal(t, map[string]any{"name": "secret"}),
			}, "prompt secret detail")

			assertSanitized("completion/complete", &Request{
				JSONRPC: "2.0",
				ID:      3,
				Method:  methodCompletionComplete,
				Params: mustMarshal(t, map[string]any{
					"ref":      map[string]any{"type": completionRefPrompt, "name": "secret"},
					"argument": map[string]any{"name": "q", "value": "x"},
				}),
			}, "completion secret detail")
		})
	}
}

func TestHandlerErrorSanitization_TaskTool(t *testing.T) {
	for _, verbose := range []bool{false, true} {
		t.Run(map[bool]string{false: "default", true: "verbose"}[verbose], func(t *testing.T) {
			opts := []ServerOption{
				WithServerIDGenerator(staticIDGenerator{id: "task-secret"}),
				WithTaskRuntime(TaskRuntimeOptions{Store: NewMemoryTaskStore()}),
			}
			if verbose {
				opts = append(opts, WithVerboseHandlerErrors(true))
			}
			s := NewServer("test", "dev", opts...)
			if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
				return nil, errors.New("task secret detail")
			}); err != nil {
				t.Fatalf("register task tool: %v", err)
			}

			createResp := s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(1, "slow"), protocolVersion, "sess-1")
			if createResp.Error != nil {
				t.Fatalf("tools/call task create: %+v", createResp.Error)
			}

			resultResp := s.dispatchForProtocol(context.Background(), taskRequest(2, methodTasksResult, "task-secret"), protocolVersion, "sess-1")
			if resultResp.Error == nil || resultResp.Error.Code != CodeServerError {
				t.Fatalf("tasks/result expected server error, got %+v", resultResp.Error)
			}
			want := genericHandlerErrorMessage
			if verbose {
				want = "task secret detail"
			}
			if resultResp.Error.Message != want {
				t.Fatalf("tasks/result message: got %q want %q", resultResp.Error.Message, want)
			}
		})
	}
}

func TestHandlerErrorSanitization_PreservesStableMessages(t *testing.T) {
	s := NewServer("test", "dev", WithResourceSubscriptionHooks(
		func(context.Context, ResourceSubscription) error { return nil },
		func(context.Context, ResourceSubscription) error { return nil },
	))
	ctx := context.Background()

	if resp := s.toolCallError(ctx, 1, "missing", errors.New("tool not found: missing")); resp.Error == nil ||
		resp.Error.Code != CodeInvalidParams || resp.Error.Message != "tool not found: missing" {
		t.Fatalf("tool not found message changed: %+v", resp.Error)
	}
	if resp := s.toolCallError(ctx, 2, "canceled", context.Canceled); resp.Error == nil ||
		resp.Error.Code != CodeServerError || resp.Error.Message != context.Canceled.Error() {
		t.Fatalf("context canceled message changed: %+v", resp.Error)
	}
	wrappedCanceled := fmt.Errorf("db DSN postgres://user:secret@host/app: %w", context.Canceled)
	if resp := s.toolCallError(ctx, 3, "wrapped-canceled", wrappedCanceled); resp.Error == nil ||
		resp.Error.Code != CodeServerError || resp.Error.Message != context.Canceled.Error() {
		t.Fatalf("wrapped context canceled leaked the handler prefix: %+v", resp.Error)
	}
	if resp := s.taskStoreError(ctx, 4, wrappedCanceled); resp.Error == nil ||
		resp.Error.Code != CodeServerError || resp.Error.Message != context.Canceled.Error() {
		t.Fatalf("task store wrapped context canceled leaked the handler prefix: %+v", resp.Error)
	}

	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	assertMessage := func(name string, req *Request, wantCode int, wantPart string) {
		t.Helper()
		resp, err := invokeHandlerWithMethod(ctx, s, "POST", mustMarshal(t, req), headers)
		if err != nil {
			t.Fatalf("%s handler: %v", name, err)
		}
		rpcResp, err := parseJSONRPCResponse(resp)
		if err != nil {
			t.Fatalf("%s parse: %v", name, err)
		}
		if rpcResp.Error == nil || rpcResp.Error.Code != wantCode || !strings.Contains(rpcResp.Error.Message, wantPart) {
			t.Fatalf("%s expected code %d containing %q, got %+v", name, wantCode, wantPart, rpcResp.Error)
		}
	}

	assertMessage("resource not found", &Request{
		JSONRPC: "2.0",
		ID:      3,
		Method:  methodResourcesRead,
		Params:  mustMarshal(t, map[string]any{"uri": "file://missing.txt"}),
	}, CodeInvalidParams, "resource not found")

	assertMessage("prompt not found", &Request{
		JSONRPC: "2.0",
		ID:      4,
		Method:  methodPromptsGet,
		Params:  mustMarshal(t, map[string]any{"name": "missing"}),
	}, CodeInvalidParams, "prompt not found")

	assertMessage("invalid uri", &Request{
		JSONRPC: "2.0",
		ID:      5,
		Method:  methodResourcesSubscribe,
		Params:  mustMarshal(t, map[string]any{"uri": "not a uri"}),
	}, CodeInvalidParams, "invalid uri")
}
