package main

import (
	"context"
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
