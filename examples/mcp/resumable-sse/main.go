package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/runtime/mcp"
)

func buildServer() *mcp.Server {
	srv := mcp.NewServer("resumable-sse", "dev")

	_ = srv.Registry().RegisterStreamingTool(mcp.ToolDef{
		Name:        "countdown",
		Description: "Emits progress events then returns a result.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"steps":{"type":"integer","minimum":1}}}`),
	}, func(ctx context.Context, args json.RawMessage, emit func(mcp.SSEEvent)) (*mcp.ToolResult, error) {
		var in struct {
			Steps int `json:"steps"`
		}
		_ = json.Unmarshal(args, &in)
		if in.Steps <= 0 {
			in.Steps = 3
		}

		for i := 1; i <= in.Steps; i++ {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			default:
			}

			emit(mcp.SSEEvent{Data: map[string]any{
				"seq":     i,
				"total":   in.Steps,
				"message": fmt.Sprintf("step %d/%d", i, in.Steps),
			}})
			time.Sleep(30 * time.Millisecond)
		}

		return &mcp.ToolResult{
			Content: []mcp.ContentBlock{{Type: "text", Text: "done"}},
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
