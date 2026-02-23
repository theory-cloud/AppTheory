package main

import (
	"context"
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
