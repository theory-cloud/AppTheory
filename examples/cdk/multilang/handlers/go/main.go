package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/theory-cloud/apptheory/runtime"
)

func buildApp() *apptheory.App {
	tier := apptheory.Tier(os.Getenv("APPTHEORY_TIER"))
	name := os.Getenv("APPTHEORY_DEMO_NAME")
	lang := os.Getenv("APPTHEORY_LANG")

	app := apptheory.New(apptheory.WithTier(tier))

	app.Get("/", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.MustJSON(200, map[string]any{
			"ok":         true,
			"lang":       lang,
			"name":       name,
			"tier":       string(tier),
			"request_id": ctx.RequestID,
			"tenant_id":  ctx.TenantID,
		}), nil
	})

	app.Get("/hello/{name}", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.MustJSON(200, map[string]any{
			"message":    "hello " + ctx.Param("name"),
			"lang":       lang,
			"name":       name,
			"tier":       string(tier),
			"request_id": ctx.RequestID,
			"tenant_id":  ctx.TenantID,
		}), nil
	})

	app.Get("/sse", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		events := make(chan apptheory.SSEEvent)
		go func() {
			defer close(events)
			for i := 1; i <= 3; i++ {
				events <- apptheory.SSEEvent{
					ID:    fmt.Sprintf("%d", i),
					Event: "message",
					Data:  map[string]any{"ok": true, "lang": lang, "name": name, "seq": i},
				}
				time.Sleep(1 * time.Second)
			}
		}()
		return apptheory.SSEStreamResponse(ctx.Context(), 200, events)
	})

	app.WebSocket("$connect", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		ws := ctx.AsWebSocket()
		return apptheory.MustJSON(200, map[string]any{
			"ok":            true,
			"lang":          lang,
			"name":          name,
			"route_key":     ws.RouteKey,
			"connection_id": ws.ConnectionID,
			"request_id":    ws.RequestID,
		}), nil
	})

	app.WebSocket("$disconnect", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		ws := ctx.AsWebSocket()
		return apptheory.MustJSON(200, map[string]any{
			"ok":            true,
			"lang":          lang,
			"name":          name,
			"route_key":     ws.RouteKey,
			"connection_id": ws.ConnectionID,
			"request_id":    ws.RequestID,
		}), nil
	})

	app.WebSocket("$default", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		ws := ctx.AsWebSocket()
		if ws != nil {
			if err := ws.SendJSONMessage(map[string]any{
				"ok":   true,
				"lang": lang,
				"name": name,
			}); err != nil {
				return nil, err
			}
		}
		return apptheory.MustJSON(200, map[string]any{
			"ok":                  true,
			"lang":                lang,
			"name":                name,
			"route_key":           ws.RouteKey,
			"connection_id":       ws.ConnectionID,
			"management_endpoint": ws.ManagementEndpoint,
			"request_id":          ws.RequestID,
		}), nil
	})

	queueName := os.Getenv("APPTHEORY_DEMO_QUEUE_NAME")
	ruleName := os.Getenv("APPTHEORY_DEMO_RULE_NAME")
	tableName := os.Getenv("APPTHEORY_DEMO_TABLE_NAME")

	app.SQS(queueName, func(_ *apptheory.EventContext, _ events.SQSMessage) error {
		return nil
	})
	app.EventBridge(apptheory.EventBridgeRule(ruleName), func(_ *apptheory.EventContext, _ events.EventBridgeEvent) (any, error) {
		return map[string]any{"ok": true, "trigger": "eventbridge", "lang": lang}, nil
	})
	app.DynamoDB(tableName, func(_ *apptheory.EventContext, _ events.DynamoDBEventRecord) error {
		return nil
	})

	return app
}

func main() {
	app := buildApp()
	lambda.Start(func(ctx context.Context, event json.RawMessage) (any, error) {
		return app.HandleLambda(ctx, event)
	})
}
