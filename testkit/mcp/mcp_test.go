package mcp_test

import (
	"context"
	"encoding/json"
	"testing"

	mcpruntime "github.com/theory-cloud/apptheory/runtime/mcp"
	"github.com/theory-cloud/apptheory/testkit"
	mcptestkit "github.com/theory-cloud/apptheory/testkit/mcp"
)

// newSampleServer creates an MCP server with a sample "echo" tool for testing.
func newSampleServer(env *testkit.Env) *mcpruntime.Server {
	server := mcpruntime.NewServer("test-server", "1.0.0",
		mcpruntime.WithSessionStore(mcpruntime.NewMemorySessionStore(mcpruntime.WithClock(env.Clock))),
		mcpruntime.WithServerIDGenerator(env.IDs),
	)

	if err := server.Registry().RegisterTool(
		mcpruntime.ToolDef{
			Name:        "echo",
			Description: "Echoes the input back",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`),
		},
		func(ctx context.Context, args json.RawMessage) (*mcpruntime.ToolResult, error) {
			var params struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(args, &params); err != nil {
				return nil, err
			}
			return &mcpruntime.ToolResult{
				Content: []mcpruntime.ContentBlock{
					{Type: "text", Text: params.Message},
				},
			}, nil
		},
	); err != nil {
		panic(err)
	}

	return server
}

func TestInitialize_CapturesSessionID(t *testing.T) {
	env := testkit.New()
	server := newSampleServer(env)
	client := mcptestkit.NewClient(server, env)

	resp, err := client.Initialize(context.Background())
	if err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}
	if resp.Error != nil {
		t.Fatalf("expected success, got error: %+v", resp.Error)
	}
	if client.SessionID() == "" {
		t.Fatal("expected session ID to be captured after Initialize")
	}
}

func TestInitialize_ReturnsServerInfo(t *testing.T) {
	env := testkit.New()
	server := newSampleServer(env)
	client := mcptestkit.NewClient(server, env)

	resp, err := client.Initialize(context.Background())
	if err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	resultBytes, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatalf("failed to marshal result: %v", err)
	}
	var result map[string]any
	if err := json.Unmarshal(resultBytes, &result); err != nil {
		t.Fatalf("failed to parse result: %v", err)
	}

	serverInfo, ok := result["serverInfo"].(map[string]any)
	if !ok {
		t.Fatal("expected serverInfo in result")
	}
	if serverInfo["name"] != "test-server" {
		t.Fatalf("expected server name 'test-server', got %v", serverInfo["name"])
	}
	if serverInfo["version"] != "1.0.0" {
		t.Fatalf("expected server version '1.0.0', got %v", serverInfo["version"])
	}
}

func TestListTools_ReturnsRegisteredTools(t *testing.T) {
	env := testkit.New()
	server := newSampleServer(env)
	client := mcptestkit.NewClient(server, env)

	// Initialize first to establish session.
	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	tools, err := client.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools failed: %v", err)
	}

	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	if tools[0].Name != "echo" {
		t.Fatalf("expected tool name 'echo', got %q", tools[0].Name)
	}
}

func TestCallTool_InvokesHandlerAndReturnsResult(t *testing.T) {
	env := testkit.New()
	server := newSampleServer(env)
	client := mcptestkit.NewClient(server, env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	result, err := client.CallTool(context.Background(), "echo", map[string]any{
		"message": "hello world",
	})
	if err != nil {
		t.Fatalf("CallTool failed: %v", err)
	}

	if len(result.Content) != 1 {
		t.Fatalf("expected 1 content block, got %d", len(result.Content))
	}
	if result.Content[0].Text != "hello world" {
		t.Fatalf("expected text 'hello world', got %q", result.Content[0].Text)
	}
}

func TestSessionID_ReusedAcrossRequests(t *testing.T) {
	env := testkit.New()
	server := newSampleServer(env)
	client := mcptestkit.NewClient(server, env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}
	firstSessionID := client.SessionID()

	// Subsequent request should reuse the same session ID.
	if _, err := client.ListTools(context.Background()); err != nil {
		t.Fatalf("ListTools failed: %v", err)
	}
	if client.SessionID() != firstSessionID {
		t.Fatalf("expected session ID %q to be reused, got %q", firstSessionID, client.SessionID())
	}
}

func TestAssertToolResult_Success(t *testing.T) {
	resp := &mcpruntime.Response{
		JSONRPC: "2.0",
		ID:      1,
		Result: mcpruntime.ToolResult{
			Content: []mcpruntime.ContentBlock{
				{Type: "text", Text: "expected output"},
			},
		},
	}
	// Should not panic or fail.
	mcptestkit.AssertToolResult(t, resp, "expected output")
}

func TestAssertError_MatchesCode(t *testing.T) {
	resp := &mcpruntime.Response{
		JSONRPC: "2.0",
		ID:      1,
		Error: &mcpruntime.RPCError{
			Code:    mcpruntime.CodeMethodNotFound,
			Message: "Method not found",
		},
	}
	mcptestkit.AssertError(t, resp, mcpruntime.CodeMethodNotFound)
}

func TestAssertHasTools_FindsTools(t *testing.T) {
	tools := []mcpruntime.ToolDef{
		{Name: "alpha"},
		{Name: "beta"},
		{Name: "gamma"},
	}
	mcptestkit.AssertHasTools(t, tools, "alpha", "gamma")
}

func TestRaw_UnknownMethod(t *testing.T) {
	env := testkit.New()
	server := newSampleServer(env)
	client := mcptestkit.NewClient(server, env)

	resp, err := client.Raw(context.Background(), &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      99,
		Method:  "unknown/method",
	})
	if err != nil {
		t.Fatalf("Raw failed: %v", err)
	}
	mcptestkit.AssertError(t, resp, mcpruntime.CodeMethodNotFound)
}

func TestRequestBuilders(t *testing.T) {
	initReq := mcptestkit.InitializeRequest(1)
	if initReq.Method != "initialize" {
		t.Fatalf("expected method 'initialize', got %q", initReq.Method)
	}

	listReq := mcptestkit.ListToolsRequest(2)
	if listReq.Method != "tools/list" {
		t.Fatalf("expected method 'tools/list', got %q", listReq.Method)
	}

	callReq, err := mcptestkit.CallToolRequest(3, "echo", map[string]string{"message": "hi"})
	if err != nil {
		t.Fatalf("CallToolRequest failed: %v", err)
	}
	if callReq.Method != "tools/call" {
		t.Fatalf("expected method 'tools/call', got %q", callReq.Method)
	}
}
