package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func envOr(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

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
	scheduleRuleName := envOr("APPTHEORY_DEMO_SCHEDULE_RULE_NAME", os.Getenv("APPTHEORY_DEMO_RULE_NAME"))
	eventSource := envOr("APPTHEORY_DEMO_EVENT_SOURCE", "apptheory.example")
	eventDetailType := envOr("APPTHEORY_DEMO_EVENT_DETAIL_TYPE", "example.item.changed")
	tableName := os.Getenv("APPTHEORY_DEMO_TABLE_NAME")

	app.SQS(queueName, func(_ *apptheory.EventContext, _ events.SQSMessage) error {
		return nil
	})
	app.EventBridge(apptheory.EventBridgePattern(eventSource, eventDetailType), func(ctx *apptheory.EventContext, event events.EventBridgeEvent) (any, error) {
		envelope := apptheory.NormalizeEventBridgeWorkloadEnvelope(ctx, event)
		return map[string]any{
			"ok":             true,
			"trigger":        "eventbridge",
			"kind":           "rule",
			"lang":           lang,
			"correlation_id": envelope.CorrelationID,
			"source":         envelope.Source,
			"detail_type":    envelope.DetailType,
		}, nil
	})
	app.EventBridge(apptheory.EventBridgeRule(scheduleRuleName), func(ctx *apptheory.EventContext, event events.EventBridgeEvent) (any, error) {
		summary := apptheory.NormalizeEventBridgeScheduledWorkload(ctx, event)
		return map[string]any{
			"ok":             true,
			"trigger":        "eventbridge",
			"kind":           "schedule",
			"lang":           lang,
			"correlation_id": summary.CorrelationID,
			"run_id":         summary.RunID,
			"scheduled_time": summary.ScheduledTime,
		}, nil
	})
	app.DynamoDB(tableName, func(_ *apptheory.EventContext, record events.DynamoDBEventRecord) error {
		summary := apptheory.NormalizeDynamoDBStreamRecord(record)
		_ = summary.SafeLog
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
