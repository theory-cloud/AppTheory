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

	if err := server.Resources().RegisterResource(
		mcpruntime.ResourceDef{
			URI:         "file://hello.txt",
			Name:        "hello",
			Description: "Test resource",
			MimeType:    "text/plain",
		},
		func(_ context.Context) ([]mcpruntime.ResourceContent, error) {
			return []mcpruntime.ResourceContent{
				{
					URI:      "file://hello.txt",
					MimeType: "text/plain",
					Text:     "hello world",
				},
			}, nil
		},
	); err != nil {
		panic(err)
	}

	if err := server.Prompts().RegisterPrompt(
		mcpruntime.PromptDef{
			Name:        "greet",
			Description: "Test prompt",
			Arguments: []mcpruntime.PromptArgument{
				{Name: "name", Required: true},
			},
		},
		func(_ context.Context, args json.RawMessage) (*mcpruntime.PromptResult, error) {
			var in struct {
				Name string `json:"name"`
			}
			if len(args) != 0 {
				if err := json.Unmarshal(args, &in); err != nil {
					return nil, err
				}
			}
			if in.Name == "" {
				in.Name = "world"
			}
			return &mcpruntime.PromptResult{
				Description: "Greeting prompt",
				Messages: []mcpruntime.PromptMessage{
					{
						Role:    "user",
						Content: mcpruntime.ContentBlock{Type: "text", Text: "hello " + in.Name},
					},
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

func TestInitialize_AdvertisesResourcesAndPromptsWhenRegistered(t *testing.T) {
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

	caps, ok := result["capabilities"].(map[string]any)
	if !ok {
		t.Fatal("expected capabilities in result")
	}
	if _, ok := caps["tools"]; !ok {
		t.Fatal("expected tools capability")
	}
	if _, ok := caps["resources"]; !ok {
		t.Fatal("expected resources capability when resources are registered")
	}
	if _, ok := caps["prompts"]; !ok {
		t.Fatal("expected prompts capability when prompts are registered")
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

func TestListResources_ReturnsRegisteredResources(t *testing.T) {
	env := testkit.New()
	server := newSampleServer(env)
	client := mcptestkit.NewClient(server, env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	resources, err := client.ListResources(context.Background())
	if err != nil {
		t.Fatalf("ListResources failed: %v", err)
	}

	if len(resources) != 1 {
		t.Fatalf("expected 1 resource, got %d", len(resources))
	}
	if resources[0].URI != "file://hello.txt" {
		t.Fatalf("expected resource uri 'file://hello.txt', got %q", resources[0].URI)
	}
}

func TestReadResource_ReturnsContent(t *testing.T) {
	env := testkit.New()
	server := newSampleServer(env)
	client := mcptestkit.NewClient(server, env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	contents, err := client.ReadResource(context.Background(), "file://hello.txt")
	if err != nil {
		t.Fatalf("ReadResource failed: %v", err)
	}

	if len(contents) != 1 {
		t.Fatalf("expected 1 content item, got %d", len(contents))
	}
	if contents[0].Text != "hello world" {
		t.Fatalf("expected text 'hello world', got %q", contents[0].Text)
	}
}

func TestListPrompts_ReturnsRegisteredPrompts(t *testing.T) {
	env := testkit.New()
	server := newSampleServer(env)
	client := mcptestkit.NewClient(server, env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	prompts, err := client.ListPrompts(context.Background())
	if err != nil {
		t.Fatalf("ListPrompts failed: %v", err)
	}

	if len(prompts) != 1 {
		t.Fatalf("expected 1 prompt, got %d", len(prompts))
	}
	if prompts[0].Name != "greet" {
		t.Fatalf("expected prompt name 'greet', got %q", prompts[0].Name)
	}
}

func TestGetPrompt_ReturnsMessages(t *testing.T) {
	env := testkit.New()
	server := newSampleServer(env)
	client := mcptestkit.NewClient(server, env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	out, err := client.GetPrompt(context.Background(), "greet", map[string]any{"name": "mcp"})
	if err != nil {
		t.Fatalf("GetPrompt failed: %v", err)
	}
	if len(out.Messages) != 1 {
		t.Fatalf("expected 1 prompt message, got %d", len(out.Messages))
	}
	if got := out.Messages[0].Content.Text; got != "hello mcp" {
		t.Fatalf("expected message text 'hello mcp', got %q", got)
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

	resList := mcptestkit.ListResourcesRequest(4)
	if resList.Method != "resources/list" {
		t.Fatalf("expected method 'resources/list', got %q", resList.Method)
	}

	resRead, err := mcptestkit.ReadResourceRequest(5, "file://hello.txt")
	if err != nil {
		t.Fatalf("ReadResourceRequest failed: %v", err)
	}
	if resRead.Method != "resources/read" {
		t.Fatalf("expected method 'resources/read', got %q", resRead.Method)
	}

	promptList := mcptestkit.ListPromptsRequest(6)
	if promptList.Method != "prompts/list" {
		t.Fatalf("expected method 'prompts/list', got %q", promptList.Method)
	}

	promptGet, err := mcptestkit.GetPromptRequest(7, "greet", map[string]any{"name": "hi"})
	if err != nil {
		t.Fatalf("GetPromptRequest failed: %v", err)
	}
	if promptGet.Method != "prompts/get" {
		t.Fatalf("expected method 'prompts/get', got %q", promptGet.Method)
	}
}
