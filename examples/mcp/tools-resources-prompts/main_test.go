package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/theory-cloud/apptheory/testkit"
	mcptest "github.com/theory-cloud/apptheory/testkit/mcp"
)

func TestToolsResourcesPromptsExample(t *testing.T) {
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

	resources, err := client.ListResources(context.Background())
	if err != nil {
		t.Fatalf("resources/list: %v", err)
	}
	if len(resources) != 1 || resources[0].URI != "file://hello.txt" {
		t.Fatalf("unexpected resources: %+v", resources)
	}

	contents, err := client.ReadResource(context.Background(), "file://hello.txt")
	if err != nil {
		t.Fatalf("resources/read: %v", err)
	}
	if len(contents) != 1 || contents[0].Text != "hello world" {
		t.Fatalf("unexpected resource contents: %+v", contents)
	}

	prompts, err := client.ListPrompts(context.Background())
	if err != nil {
		t.Fatalf("prompts/list: %v", err)
	}
	if len(prompts) != 1 || prompts[0].Name != "greet" {
		t.Fatalf("unexpected prompts: %+v", prompts)
	}

	result, err := client.GetPrompt(context.Background(), "greet", map[string]any{"name": "aron"})
	if err != nil {
		t.Fatalf("prompts/get: %v", err)
	}
	if len(result.Messages) != 1 || result.Messages[0].Content.Text != "hello aron" {
		t.Fatalf("unexpected prompt result: %+v", result)
	}
}

func TestToolsResourcesPromptsBuildApp(t *testing.T) {
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

	var body map[string]any
	if err := json.Unmarshal([]byte(resp.Body), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if body["jsonrpc"] != "2.0" {
		t.Fatalf("unexpected body: %#v", body)
	}
}
