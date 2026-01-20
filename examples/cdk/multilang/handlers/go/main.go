package main

import (
	"context"
	"encoding/json"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/theory-cloud/apptheory"
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

	app.Get("/sse", func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.SSEResponse(200, apptheory.SSEEvent{
			ID:    "1",
			Event: "message",
			Data:  map[string]any{"ok": true, "lang": lang, "name": name},
		})
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
