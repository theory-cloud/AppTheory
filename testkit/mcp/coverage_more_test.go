package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	mcpruntime "github.com/theory-cloud/apptheory/runtime/mcp"
	"github.com/theory-cloud/apptheory/testkit"
)

func TestHelperFunctionsAndErrorBranches(t *testing.T) {
	t.Run("toolNames", func(t *testing.T) {
		names := toolNames([]mcpruntime.ToolDef{{Name: "a"}, {Name: "b"}})
		if len(names) != 2 || names[0] != "a" || names[1] != "b" {
			t.Fatalf("unexpected tool names: %v", names)
		}
	})

	t.Run("parseResult marshal error", func(t *testing.T) {
		var out struct{}
		if err := parseResult("x", make(chan int), &out); err == nil {
			t.Fatalf("expected parseResult to error when result is not JSON-marshalable")
		}
	})

	t.Run("rawOK returns error for JSON-RPC error responses", func(t *testing.T) {
		env := testkit.New()
		server := mcpruntime.NewServer("test", "dev")
		client := NewClient(server, env)

		if _, err := client.Initialize(context.Background()); err != nil {
			t.Fatalf("initialize: %v", err)
		}

		_, err := client.rawOK(context.Background(), &mcpruntime.Request{
			JSONRPC: "2.0",
			ID:      1,
			Method:  "unknown/method",
		})
		if err == nil {
			t.Fatalf("expected rawOK to return an error")
		}
	})

	t.Run("Raw returns marshal error for unserializable request", func(t *testing.T) {
		env := testkit.New()
		server := mcpruntime.NewServer("test", "dev")
		client := NewClient(server, env)

		_, err := client.Raw(context.Background(), &mcpruntime.Request{
			JSONRPC: "2.0",
			ID:      make(chan int),
			Method:  "initialize",
		})
		if err == nil {
			t.Fatalf("expected Raw to return a marshal error")
		}
	})

	t.Run("Raw notification returns placeholder response", func(t *testing.T) {
		env := testkit.New()
		server := mcpruntime.NewServer("test", "dev")
		client := NewClient(server, env)

		if _, err := client.Initialize(context.Background()); err != nil {
			t.Fatalf("initialize: %v", err)
		}

		resp, err := client.Raw(context.Background(), &mcpruntime.Request{
			JSONRPC: "2.0",
			Method:  "notifications/cancel" + "led",
		})
		if err != nil {
			t.Fatalf("Raw notification: %v", err)
		}
		if resp.ID != nil {
			t.Fatalf("expected placeholder response id to be nil, got %v", resp.ID)
		}
	})

	t.Run("parseResult unmarshal error", func(t *testing.T) {
		var out struct {
			Tools []mcpruntime.ToolDef `json:"tools"`
		}
		if err := parseResult("tools/list", "not an object", &out); err == nil {
			t.Fatalf("expected parseResult to error when JSON shape mismatches")
		}
	})
}

func TestStreamHelpers_ErrorPaths(t *testing.T) {
	// Cancel should be nil-safe.
	var nilStream *Stream
	nilStream.Cancel()

	stream := &Stream{}
	stream.Cancel()

	if _, err := stream.Next(); err == nil {
		t.Fatalf("expected Next to error on nil reader")
	}
	if _, err := stream.ReadAll(); err == nil {
		t.Fatalf("expected ReadAll to error on nil reader")
	}

	if _, err := ReadSSEMessage(nil); err == nil {
		t.Fatalf("expected ReadSSEMessage to error on nil reader")
	}
}

func TestRawStream_AndResumeStream_ErrorBranches(t *testing.T) {
	env := testkit.New()
	server := mcpruntime.NewServer("test", "dev", mcpruntime.WithServerIDGenerator(env.IDs))
	client := NewClient(server, env)

	// Initialize establishes a session header.
	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	// RawStream requires a streaming response; initialize is always JSON (non-streaming).
	_, err := client.RawStream(context.Background(), &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "initialize",
	}, nil)
	if err == nil {
		t.Fatalf("expected RawStream(initialize) to error due to missing BodyReader")
	}

	// ResumeStream should error if the requested Last-Event-ID is unknown (non-streaming 404).
	_, err = client.ResumeStream(context.Background(), "9999", nil)
	if err == nil {
		t.Fatalf("expected ResumeStream to error for unknown event id")
	}
}

func TestStream_Response_ReturnsHTTPMetadata(t *testing.T) {
	env := testkit.New()
	server := mcpruntime.NewServer("test", "dev", mcpruntime.WithServerIDGenerator(env.IDs))

	if err := server.Registry().RegisterStreamingTool(
		mcpruntime.ToolDef{
			Name:        "fast",
			Description: "returns immediately",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(context.Context, json.RawMessage, func(mcpruntime.SSEEvent)) (*mcpruntime.ToolResult, error) {
			return &mcpruntime.ToolResult{Content: []mcpruntime.ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	client := NewClient(server, env)
	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	params := map[string]any{"name": "fast", "arguments": json.RawMessage(`{}`)}
	paramsBytes, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}

	s, err := client.RawStream(context.Background(), &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "tools/call",
		Params:  paramsBytes,
	}, nil)
	if err != nil {
		t.Fatalf("RawStream: %v", err)
	}
	resp := s.Response()
	if resp.Status != 200 {
		t.Fatalf("status: got %d want %d", resp.Status, 200)
	}

	// Read the stream to completion to avoid leaking goroutines.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, err := s.ReadAll()
		if err != nil {
			t.Errorf("ReadAll: %v", err)
		}
	}()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatalf("timed out reading SSE stream")
	}
}

func TestClientMethods_ReturnErrors_ForMissingRegistrations(t *testing.T) {
	env := testkit.New()
	server := mcpruntime.NewServer("test", "dev")
	client := NewClient(server, env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	if _, err := client.ReadResource(context.Background(), "file://missing"); err == nil {
		t.Fatalf("expected ReadResource to error when resource is not registered")
	}
	if _, err := client.GetPrompt(context.Background(), "missing", nil); err == nil {
		t.Fatalf("expected GetPrompt to error when prompt is not registered")
	}
	if _, err := client.CallTool(context.Background(), "missing", map[string]any{}); err == nil {
		t.Fatalf("expected CallTool to error when tool is not registered")
	}
}

func TestClient_SuccessPaths_ListAndInvoke(t *testing.T) {
	env := testkit.New()
	server := mcpruntime.NewServer("test", "dev", mcpruntime.WithServerIDGenerator(env.IDs))

	if err := server.Registry().RegisterTool(
		mcpruntime.ToolDef{
			Name:        "echo",
			Description: "returns ok",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(context.Context, json.RawMessage) (*mcpruntime.ToolResult, error) {
			return &mcpruntime.ToolResult{
				Content: []mcpruntime.ContentBlock{{Type: "text", Text: "ok"}},
			}, nil
		},
	); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	if err := server.Resources().RegisterResource(
		mcpruntime.ResourceDef{URI: "file://x", Name: "x", MimeType: "text/plain"},
		func(context.Context) ([]mcpruntime.ResourceContent, error) {
			return []mcpruntime.ResourceContent{{URI: "file://x", MimeType: "text/plain", Text: "hello"}}, nil
		},
	); err != nil {
		t.Fatalf("register resource: %v", err)
	}

	if err := server.Prompts().RegisterPrompt(
		mcpruntime.PromptDef{Name: "p"},
		func(context.Context, json.RawMessage) (*mcpruntime.PromptResult, error) {
			return &mcpruntime.PromptResult{
				Messages: []mcpruntime.PromptMessage{
					{Role: "user", Content: mcpruntime.ContentBlock{Type: "text", Text: "hi"}},
				},
			}, nil
		},
	); err != nil {
		t.Fatalf("register prompt: %v", err)
	}

	client := NewClient(server, env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if client.SessionID() == "" {
		t.Fatalf("expected session id to be captured")
	}

	tools, err := client.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	AssertHasTools(t, tools, "echo")

	resources, err := client.ListResources(context.Background())
	if err != nil {
		t.Fatalf("ListResources: %v", err)
	}
	if len(resources) != 1 || resources[0].URI != "file://x" {
		t.Fatalf("unexpected resources: %#v", resources)
	}

	contents, err := client.ReadResource(context.Background(), "file://x")
	if err != nil {
		t.Fatalf("ReadResource: %v", err)
	}
	if len(contents) != 1 || contents[0].Text != "hello" {
		t.Fatalf("unexpected contents: %#v", contents)
	}

	prompts, err := client.ListPrompts(context.Background())
	if err != nil {
		t.Fatalf("ListPrompts: %v", err)
	}
	if len(prompts) != 1 || prompts[0].Name != "p" {
		t.Fatalf("unexpected prompts: %#v", prompts)
	}

	prompt, err := client.GetPrompt(context.Background(), "p", nil)
	if err != nil {
		t.Fatalf("GetPrompt: %v", err)
	}
	if len(prompt.Messages) != 1 || prompt.Messages[0].Content.Text != "hi" {
		t.Fatalf("unexpected prompt result: %#v", prompt)
	}

	result, err := client.CallTool(context.Background(), "echo", map[string]any{"x": 1})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if len(result.Content) != 1 || result.Content[0].Text != "ok" {
		t.Fatalf("unexpected tool result: %#v", result)
	}
}

func TestAssertHelpers_SuccessPaths(t *testing.T) {
	AssertToolResult(t, &mcpruntime.Response{
		JSONRPC: "2.0",
		ID:      1,
		Result:  mcpruntime.ToolResult{Content: []mcpruntime.ContentBlock{{Type: "text", Text: "ok"}}},
	}, "ok")

	AssertError(t, &mcpruntime.Response{
		JSONRPC: "2.0",
		ID:      1,
		Error:   &mcpruntime.RPCError{Code: -32600, Message: "bad"},
	}, -32600)
}

func TestClientMethods_ErrorWhenNotInitialized(t *testing.T) {
	env := testkit.New()
	server := mcpruntime.NewServer("test", "dev")
	client := NewClient(server, env)

	if _, err := client.ListTools(context.Background()); err == nil {
		t.Fatalf("expected ListTools to error when client is not initialized")
	}
	if _, err := client.ListResources(context.Background()); err == nil {
		t.Fatalf("expected ListResources to error when client is not initialized")
	}
	if _, err := client.ReadResource(context.Background(), "file://x"); err == nil {
		t.Fatalf("expected ReadResource to error when client is not initialized")
	}
	if _, err := client.ListPrompts(context.Background()); err == nil {
		t.Fatalf("expected ListPrompts to error when client is not initialized")
	}
	if _, err := client.GetPrompt(context.Background(), "p", nil); err == nil {
		t.Fatalf("expected GetPrompt to error when client is not initialized")
	}
	if _, err := client.CallTool(context.Background(), "t", map[string]any{}); err == nil {
		t.Fatalf("expected CallTool to error when client is not initialized")
	}
}

func TestClientMethods_MarshalErrors(t *testing.T) {
	env := testkit.New()
	server := mcpruntime.NewServer("test", "dev")
	client := NewClient(server, env)

	if _, err := client.GetPrompt(context.Background(), "p", make(chan int)); err == nil {
		t.Fatalf("expected GetPrompt to error when args are not JSON-marshalable")
	}
	if _, err := client.CallTool(context.Background(), "t", make(chan int)); err == nil {
		t.Fatalf("expected CallTool to error when args are not JSON-marshalable")
	}
}

func TestRaw_NilContext_AndInvalidJSONResponse(t *testing.T) {
	env := testkit.New()
	app := env.App()
	app.Post("/mcp", func(*apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"application/json"},
			},
			Body: []byte("{"),
		}, nil
	})
	client := &Client{env: env, app: app}

	//nolint:staticcheck // testing nil context handling
	_, err := client.Raw(nil, &mcpruntime.Request{JSONRPC: "2.0", ID: 1, Method: "any"})
	if err == nil {
		t.Fatalf("expected Raw to error for invalid JSON response")
	}
}

type capturingTB struct {
	testing.TB
	fatalCalled bool
	msg         string
}

func (t *capturingTB) Fatal(args ...any) {
	t.fatalCalled = true
	t.msg = fmt.Sprint(args...)
}

func (t *capturingTB) Fatalf(format string, args ...any) {
	t.fatalCalled = true
	t.msg = fmt.Sprintf(format, args...)
}

func TestAssertHelpers_FailurePaths(t *testing.T) {
	t.Run("AssertToolResult nil response", func(t *testing.T) {
		ct := &capturingTB{TB: t}
		AssertToolResult(ct, nil, "ok")
		if !ct.fatalCalled {
			t.Fatalf("expected Fatal to be called")
		}
	})

	t.Run("AssertToolResult error response", func(t *testing.T) {
		ct := &capturingTB{TB: t}
		AssertToolResult(ct, &mcpruntime.Response{
			JSONRPC: "2.0",
			ID:      1,
			Error:   &mcpruntime.RPCError{Code: -1, Message: "boom"},
		}, "ok")
		if !ct.fatalCalled {
			t.Fatalf("expected Fatalf to be called")
		}
	})

	t.Run("AssertToolResult marshal/unmarshal errors and missing content", func(t *testing.T) {
		ct := &capturingTB{TB: t}
		AssertToolResult(ct, &mcpruntime.Response{JSONRPC: "2.0", ID: 1, Result: make(chan int)}, "ok")
		if !ct.fatalCalled {
			t.Fatalf("expected marshal failure to call Fatalf")
		}

		ct = &capturingTB{TB: t}
		AssertToolResult(ct, &mcpruntime.Response{JSONRPC: "2.0", ID: 1, Result: "not-an-object"}, "ok")
		if !ct.fatalCalled {
			t.Fatalf("expected unmarshal failure to call Fatalf")
		}

		ct = &capturingTB{TB: t}
		AssertToolResult(ct, &mcpruntime.Response{
			JSONRPC: "2.0",
			ID:      1,
			Result:  mcpruntime.ToolResult{Content: []mcpruntime.ContentBlock{{Type: "text", Text: "nope"}}},
		}, "ok")
		if !ct.fatalCalled {
			t.Fatalf("expected missing content to call Fatalf")
		}
	})

	t.Run("AssertError nil response", func(t *testing.T) {
		ct := &capturingTB{TB: t}
		AssertError(ct, nil, -32600)
		if !ct.fatalCalled {
			t.Fatalf("expected Fatal to be called")
		}
	})

	t.Run("AssertError expected error but got success", func(t *testing.T) {
		ct := &capturingTB{TB: t}
		AssertError(ct, &mcpruntime.Response{JSONRPC: "2.0", ID: 1, Result: map[string]any{"ok": true}}, -32600)
		if !ct.fatalCalled {
			t.Fatalf("expected Fatalf to be called")
		}
	})

	t.Run("AssertError mismatch code", func(t *testing.T) {
		ct := &capturingTB{TB: t}
		AssertError(ct, &mcpruntime.Response{
			JSONRPC: "2.0",
			ID:      1,
			Error:   &mcpruntime.RPCError{Code: -1, Message: "boom"},
		}, -32600)
		if !ct.fatalCalled {
			t.Fatalf("expected mismatch to call Fatalf")
		}
	})
}
