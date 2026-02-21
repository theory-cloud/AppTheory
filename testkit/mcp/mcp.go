// Package mcp provides deterministic MCP client simulation and assertion helpers
// for testing MCP tool implementations without deploying infrastructure.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	mcpruntime "github.com/theory-cloud/apptheory/runtime/mcp"
	"github.com/theory-cloud/apptheory/testkit"
)

// Client is a test MCP client that invokes an in-process MCP server.
type Client struct {
	server    *mcpruntime.Server
	env       *testkit.Env
	app       *apptheory.App
	sessionID string
}

func parseResult[T any](method string, result any, out *T) error {
	resultBytes, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %w", err)
	}
	if err := json.Unmarshal(resultBytes, out); err != nil {
		return fmt.Errorf("failed to parse %s result: %w", method, err)
	}
	return nil
}

func (c *Client) rawOK(ctx context.Context, req *mcpruntime.Request) (*mcpruntime.Response, error) {
	resp, err := c.Raw(ctx, req)
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("%s error: code=%d message=%s", req.Method, resp.Error.Code, resp.Error.Message)
	}
	return resp, nil
}

// NewClient creates a test MCP client backed by the given MCP server and
// deterministic test environment.
func NewClient(server *mcpruntime.Server, env *testkit.Env) *Client {
	app := env.App()
	app.Post("/mcp", server.Handler())
	return &Client{
		server: server,
		env:    env,
		app:    app,
	}
}

// SessionID returns the current session ID captured from the last response.
func (c *Client) SessionID() string {
	return c.sessionID
}

// Initialize sends an MCP initialize request and captures the returned session ID
// for use in subsequent requests.
func (c *Client) Initialize(ctx context.Context) (*mcpruntime.Response, error) {
	req := &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "initialize",
	}
	resp, err := c.Raw(ctx, req)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// ListTools sends a tools/list request and returns the parsed tool definitions.
func (c *Client) ListTools(ctx context.Context) ([]mcpruntime.ToolDef, error) {
	req := &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      2,
		Method:  "tools/list",
	}
	resp, err := c.rawOK(ctx, req)
	if err != nil {
		return nil, err
	}
	var result struct {
		Tools []mcpruntime.ToolDef `json:"tools"`
	}
	if err := parseResult(req.Method, resp.Result, &result); err != nil {
		return nil, err
	}
	return result.Tools, nil
}

// ListResources sends a resources/list request and returns the parsed resource definitions.
func (c *Client) ListResources(ctx context.Context) ([]mcpruntime.ResourceDef, error) {
	req := &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      20,
		Method:  "resources/list",
	}
	resp, err := c.rawOK(ctx, req)
	if err != nil {
		return nil, err
	}
	var result struct {
		Resources []mcpruntime.ResourceDef `json:"resources"`
	}
	if err := parseResult(req.Method, resp.Result, &result); err != nil {
		return nil, err
	}
	return result.Resources, nil
}

// ReadResource sends a resources/read request for the given URI and returns the parsed contents.
func (c *Client) ReadResource(ctx context.Context, uri string) ([]mcpruntime.ResourceContent, error) {
	params, err := json.Marshal(map[string]any{"uri": uri})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal params: %w", err)
	}

	req := &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      21,
		Method:  "resources/read",
		Params:  params,
	}
	resp, err := c.Raw(ctx, req)
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("resources/read error: code=%d message=%s", resp.Error.Code, resp.Error.Message)
	}

	resultBytes, err := json.Marshal(resp.Result)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal result: %w", err)
	}
	var result struct {
		Contents []mcpruntime.ResourceContent `json:"contents"`
	}
	if err := json.Unmarshal(resultBytes, &result); err != nil {
		return nil, fmt.Errorf("failed to parse resources/read result: %w", err)
	}
	return result.Contents, nil
}

// ListPrompts sends a prompts/list request and returns the parsed prompt definitions.
func (c *Client) ListPrompts(ctx context.Context) ([]mcpruntime.PromptDef, error) {
	req := &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      30,
		Method:  "prompts/list",
	}
	resp, err := c.rawOK(ctx, req)
	if err != nil {
		return nil, err
	}
	var result struct {
		Prompts []mcpruntime.PromptDef `json:"prompts"`
	}
	if err := parseResult(req.Method, resp.Result, &result); err != nil {
		return nil, err
	}
	return result.Prompts, nil
}

// GetPrompt sends a prompts/get request for the named prompt with the given arguments.
func (c *Client) GetPrompt(ctx context.Context, name string, args any) (*mcpruntime.PromptResult, error) {
	var argsRaw json.RawMessage
	if args != nil {
		b, err := json.Marshal(args)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal args: %w", err)
		}
		argsRaw = json.RawMessage(b)
	}

	params, err := json.Marshal(map[string]any{
		"name":      name,
		"arguments": argsRaw,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal params: %w", err)
	}

	req := &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      31,
		Method:  "prompts/get",
		Params:  params,
	}
	resp, err := c.Raw(ctx, req)
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("prompts/get error: code=%d message=%s", resp.Error.Code, resp.Error.Message)
	}

	resultBytes, err := json.Marshal(resp.Result)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal result: %w", err)
	}
	var out mcpruntime.PromptResult
	if err := json.Unmarshal(resultBytes, &out); err != nil {
		return nil, fmt.Errorf("failed to parse prompts/get result: %w", err)
	}
	return &out, nil
}

// CallTool sends a tools/call request for the named tool with the given arguments.
func (c *Client) CallTool(ctx context.Context, name string, args any) (*mcpruntime.ToolResult, error) {
	argsBytes, err := json.Marshal(args)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal args: %w", err)
	}
	params, err := json.Marshal(map[string]any{
		"name":      name,
		"arguments": json.RawMessage(argsBytes),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal params: %w", err)
	}

	req := &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      3,
		Method:  "tools/call",
		Params:  params,
	}
	resp, err := c.Raw(ctx, req)
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("tools/call error: code=%d message=%s", resp.Error.Code, resp.Error.Message)
	}

	resultBytes, err := json.Marshal(resp.Result)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal result: %w", err)
	}
	var toolResult mcpruntime.ToolResult
	if err := json.Unmarshal(resultBytes, &toolResult); err != nil {
		return nil, fmt.Errorf("failed to parse tool result: %w", err)
	}
	return &toolResult, nil
}

// Raw sends an arbitrary JSON-RPC request to the MCP server and returns the
// parsed JSON-RPC response. It automatically includes the session ID header
// if one has been captured, and captures any new session ID from the response.
func (c *Client) Raw(ctx context.Context, req *mcpruntime.Request) (*mcpruntime.Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	headers := map[string][]string{
		"content-type": {"application/json"},
	}
	if c.sessionID != "" {
		headers["mcp-session-id"] = []string{c.sessionID}
	}

	httpReq := apptheory.Request{
		Method:  "POST",
		Path:    "/mcp",
		Headers: headers,
		Body:    body,
	}

	httpResp := c.env.Invoke(ctx, c.app, httpReq)

	// Capture session ID from response.
	if ids := httpResp.Headers["mcp-session-id"]; len(ids) > 0 && ids[0] != "" {
		c.sessionID = ids[0]
	}

	var rpcResp mcpruntime.Response
	if err := json.Unmarshal(httpResp.Body, &rpcResp); err != nil {
		return nil, fmt.Errorf("failed to parse response (status=%d): %w", httpResp.Status, err)
	}
	return &rpcResp, nil
}

// AssertToolResult asserts that the JSON-RPC response contains a successful tool
// result with a text content block matching the expected text.
func AssertToolResult(t testing.TB, resp *mcpruntime.Response, expectedText string) {
	t.Helper()
	if resp == nil {
		t.Fatal("response is nil")
		return
	}
	if resp.Error != nil {
		t.Fatalf("expected success but got error: code=%d message=%s", resp.Error.Code, resp.Error.Message)
		return
	}

	resultBytes, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatalf("failed to marshal result: %v", err)
	}
	var toolResult mcpruntime.ToolResult
	if err := json.Unmarshal(resultBytes, &toolResult); err != nil {
		t.Fatalf("failed to parse tool result: %v", err)
	}

	for _, block := range toolResult.Content {
		if block.Type == "text" && block.Text == expectedText {
			return
		}
	}
	t.Fatalf("expected text %q not found in tool result content: %+v", expectedText, toolResult.Content)
}

// AssertError asserts that the JSON-RPC response contains an error with the
// expected error code.
func AssertError(t testing.TB, resp *mcpruntime.Response, expectedCode int) {
	t.Helper()
	if resp == nil {
		t.Fatal("response is nil")
		return
	}
	if resp.Error == nil {
		t.Fatalf("expected error with code %d but got success result", expectedCode)
		return
	}
	if resp.Error.Code != expectedCode {
		t.Fatalf("expected error code %d but got %d (message: %s)", expectedCode, resp.Error.Code, resp.Error.Message)
		return
	}
}

// AssertHasTools asserts that the tool list contains tools with all the given names.
func AssertHasTools(t testing.TB, tools []mcpruntime.ToolDef, names ...string) {
	t.Helper()
	have := make(map[string]bool, len(tools))
	for _, tool := range tools {
		have[tool.Name] = true
	}
	for _, name := range names {
		if !have[name] {
			t.Fatalf("expected tool %q not found in tool list (have: %v)", name, toolNames(tools))
		}
	}
}

// toolNames extracts tool names for error messages.
func toolNames(tools []mcpruntime.ToolDef) []string {
	names := make([]string, len(tools))
	for i, t := range tools {
		names[i] = t.Name
	}
	return names
}
