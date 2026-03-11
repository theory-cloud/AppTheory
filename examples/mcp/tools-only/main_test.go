package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/theory-cloud/apptheory/testkit"
	mcptest "github.com/theory-cloud/apptheory/testkit/mcp"
)

func TestToolsOnlyExample(t *testing.T) {
	env := testkit.New()
	client := mcptest.NewClient(buildServer(), env)

	if _, err := client.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	tools, err := client.ListTools(context.Background())
	if err != nil {
		t.Fatalf("tools/list: %v", err)
	}
	mcptest.AssertHasTools(t, tools, "echo")

	out, err := client.CallTool(context.Background(), "echo", map[string]any{"message": "hi"})
	if err != nil {
		t.Fatalf("tools/call: %v", err)
	}
	if len(out.Content) == 0 || out.Content[0].Text != "hi" {
		t.Fatalf("unexpected tool result: %+v", out)
	}
}

func TestToolsOnlyBuildApp(t *testing.T) {
	env := testkit.New()
	app := buildApp()
	if app == nil {
		t.Fatal("expected app")
	}

	event := testkit.APIGatewayV2Request("POST", "/mcp", testkit.HTTPEventOptions{
		Headers: map[string]string{"content-type": "application/json"},
		Body:    []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`),
	})
	resp := env.InvokeAPIGatewayV2(context.Background(), app, event)
	if resp.StatusCode != 200 {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
	if resp.Headers["mcp-session-id"] == "" {
		t.Fatalf("expected mcp-session-id header, got %#v", resp.Headers)
	}

	var body map[string]any
	if err := json.Unmarshal([]byte(resp.Body), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if body["jsonrpc"] != "2.0" {
		t.Fatalf("unexpected body: %#v", body)
	}
}
