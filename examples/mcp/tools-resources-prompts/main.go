package main

import (
	"context"
	"encoding/json"

	"github.com/aws/aws-lambda-go/lambda"
	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/runtime/mcp"
)

func buildServer() *mcp.Server {
	srv := mcp.NewServer("tools-resources-prompts", "dev")

	_ = srv.Registry().RegisterTool(mcp.ToolDef{
		Name:        "echo",
		Description: "Echo back the provided message.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`),
	}, func(_ context.Context, args json.RawMessage) (*mcp.ToolResult, error) {
		var in struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(args, &in); err != nil {
			return nil, err
		}
		return &mcp.ToolResult{
			Content: []mcp.ContentBlock{{Type: "text", Text: in.Message}},
		}, nil
	})

	_ = srv.Resources().RegisterResource(mcp.ResourceDef{
		URI:      "file://hello.txt",
		Name:     "hello",
		MimeType: "text/plain",
	}, func(_ context.Context) ([]mcp.ResourceContent, error) {
		return []mcp.ResourceContent{{
			URI:      "file://hello.txt",
			MimeType: "text/plain",
			Text:     "hello world",
		}}, nil
	})

	_ = srv.Prompts().RegisterPrompt(mcp.PromptDef{
		Name:        "greet",
		Description: "Return a greeting message.",
		Arguments: []mcp.PromptArgument{
			{Name: "name", Required: true},
		},
	}, func(_ context.Context, args json.RawMessage) (*mcp.PromptResult, error) {
		var in struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(args, &in)
		return &mcp.PromptResult{
			Messages: []mcp.PromptMessage{{
				Role:    "user",
				Content: mcp.ContentBlock{Type: "text", Text: "hello " + in.Name},
			}},
		}, nil
	})

	return srv
}

func buildApp() *apptheory.App {
	app := apptheory.New()
	h := buildServer().Handler()
	app.Post("/mcp", h)
	app.Get("/mcp", h)
	app.Delete("/mcp", h)
	return app
}

func main() {
	app := buildApp()
	lambda.Start(func(ctx context.Context, event json.RawMessage) (any, error) {
		return app.HandleLambda(ctx, event)
	})
}
