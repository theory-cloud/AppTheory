package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/runtime/mcp"
)

type echoArgs struct {
	Message string `json:"message"`
}

func buildServer() *mcp.Server {
	srv := mcp.NewServer("tools-only", "dev")

	_ = srv.Registry().RegisterTool(mcp.ToolDef{
		Name:        "echo",
		Description: "Echo back the provided message.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`),
	}, mcp.WrapTool(mcp.ToolLifecycleOptions[echoArgs]{
		Name:       "echo",
		StrictJSON: true,
		Validate: func(_ context.Context, args echoArgs) error {
			if strings.TrimSpace(args.Message) == "" {
				return errors.New("message is required")
			}
			return nil
		},
	}, func(_ context.Context, in echoArgs) (*mcp.ToolResult, error) {
		return &mcp.ToolResult{
			Content: []mcp.ContentBlock{{Type: "text", Text: in.Message}},
		}, nil
	}))

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
