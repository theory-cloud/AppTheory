package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
)

var (
	snsRecordMu        sync.Mutex
	lastSNSRecord      map[string]any
	streamMu           sync.Mutex
	streamRecords      []map[string]any
	eventBridgeMu      sync.Mutex
	eventBridgeRecords []map[string]any
	wsDisconnectMu     sync.Mutex
	wsDisconnects      []map[string]any
)

const streamRecordHistory = 50

// recordEventBridgeEvent stores the documented rule envelope fields the harness
// asserts for every language.
func recordEventBridgeEvent(kind string, event events.EventBridgeEvent) map[string]any {
	return map[string]any{
		"kind":       kind,
		"id":         event.ID,
		"source":     event.Source,
		"detailType": event.DetailType,
		"resources":  event.Resources,
		"detail":     json.RawMessage(event.Detail),
		"time":       event.Time.UTC().Format(time.RFC3339Nano),
		"region":     event.Region,
		"account":    event.AccountID,
	}
}

func appendEventBridgeRecord(entry map[string]any) {
	eventBridgeMu.Lock()
	defer eventBridgeMu.Unlock()
	eventBridgeRecords = append(eventBridgeRecords, entry)
	if len(eventBridgeRecords) > streamRecordHistory {
		eventBridgeRecords = eventBridgeRecords[len(eventBridgeRecords)-streamRecordHistory:]
	}
}

// recordStreamEvent stores the documented stream record fields the harness
// asserts for every language, including a TTL REMOVE's service userIdentity.
func recordStreamEvent(record events.DynamoDBEventRecord) map[string]any {
	entry := map[string]any{
		"eventID":        record.EventID,
		"eventName":      record.EventName,
		"eventSource":    record.EventSource,
		"eventSourceARN": record.EventSourceArn,
		"awsRegion":      record.AWSRegion,
		"keys":           record.Change.Keys,
		"newImage":       record.Change.NewImage,
		"oldImage":       record.Change.OldImage,
		"sequenceNumber": record.Change.SequenceNumber,
	}
	if record.UserIdentity != nil {
		entry["userIdentity"] = map[string]any{
			"type":        record.UserIdentity.Type,
			"principalId": record.UserIdentity.PrincipalID,
		}
	}
	return entry
}

func appendStreamRecord(entry map[string]any) {
	streamMu.Lock()
	defer streamMu.Unlock()
	streamRecords = append(streamRecords, entry)
	if len(streamRecords) > streamRecordHistory {
		streamRecords = streamRecords[len(streamRecords)-streamRecordHistory:]
	}
}

// recordSNSEvent stores the documented Lambda SNS record fields the harness
// asserts for every language.
func recordSNSEvent(lang string, record events.SNSEventRecord) map[string]any {
	sns := record.SNS
	attributes := make(map[string]any, len(sns.MessageAttributes))
	for name, raw := range sns.MessageAttributes {
		attribute, _ := raw.(map[string]any)
		attributes[name] = map[string]any{"Type": attribute["Type"], "Value": attribute["Value"]}
	}
	entry := map[string]any{
		"lang":                 lang,
		"eventSource":          record.EventSource,
		"eventVersion":         record.EventVersion,
		"eventSubscriptionArn": record.EventSubscriptionArn,
		"type":                 sns.Type,
		"messageId":            sns.MessageID,
		"topicArn":             sns.TopicArn,
		"subject":              sns.Subject,
		"message":              sns.Message,
		"timestamp":            sns.Timestamp.UTC().Format(time.RFC3339Nano),
		"signatureVersion":     sns.SignatureVersion,
		"unsubscribeUrl":       sns.UnsubscribeURL,
		"messageAttributes":    attributes,
	}
	entry["shapeOk"] = sns.Type == "Notification" &&
		sns.MessageID != "" && sns.TopicArn != "" && !sns.Timestamp.IsZero() &&
		sns.SignatureVersion != "" && sns.UnsubscribeURL != ""
	return entry
}

// managementClient builds the API Gateway Management API client. An empty
// endpoint means the SDK resolves it from the function environment, which the
// local runner sets to the @connections endpoint; a non-empty endpoint is the
// one the request context reported.
func managementClient(ctx context.Context, endpoint string) (*apigatewaymanagementapi.Client, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	if endpoint == "" {
		return apigatewaymanagementapi.NewFromConfig(cfg), nil
	}
	return apigatewaymanagementapi.NewFromConfig(cfg, func(options *apigatewaymanagementapi.Options) {
		options.BaseEndpoint = &endpoint
	}), nil
}

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
		// The producer observes the invocation context at both of its blocking
		// points (the send and the delay), so it stops when the invocation that
		// started it ends instead of blocking forever on a channel nobody reads.
		// A producer that ignored the context would be frozen with the execution
		// environment and resume on a later invocation.
		done := ctx.Context().Done()
		go func() {
			defer close(events)
			for i := 1; i <= 3; i++ {
				select {
				case <-done:
					return
				case events <- apptheory.SSEEvent{
					ID:    fmt.Sprintf("%d", i),
					Event: "message",
					Data:  map[string]any{"ok": true, "lang": lang, "name": name, "seq": i},
				}:
				}
				select {
				case <-done:
					return
				case <-time.After(1 * time.Second):
				}
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
		wsDisconnectMu.Lock()
		wsDisconnects = append(wsDisconnects, map[string]any{
			"connection_id": ws.ConnectionID,
			"route_key":     ws.RouteKey,
		})
		wsDisconnectMu.Unlock()
		return apptheory.MustJSON(200, map[string]any{
			"ok":            true,
			"lang":          lang,
			"name":          name,
			"route_key":     ws.RouteKey,
			"connection_id": ws.ConnectionID,
			"request_id":    ws.RequestID,
		}), nil
	})

	app.Get("/ws-disconnects", func(_ *apptheory.Context) (*apptheory.Response, error) {
		wsDisconnectMu.Lock()
		events := append([]map[string]any(nil), wsDisconnects...)
		wsDisconnectMu.Unlock()
		return apptheory.MustJSON(200, map[string]any{"events": events}), nil
	})

	app.WebSocket("chat", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		ws := ctx.AsWebSocket()
		var message struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(ctx.Request.Body, &message)
		return apptheory.MustJSON(200, map[string]any{
			"ok":            true,
			"lang":          lang,
			"name":          name,
			"route_key":     ws.RouteKey,
			"connection_id": ws.ConnectionID,
			"echo":          message.Message,
		}), nil
	})

	app.WebSocket("$default", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		ws := ctx.AsWebSocket()
		var command struct {
			Cmd string `json:"cmd"`
		}
		_ = json.Unmarshal(ctx.Request.Body, &command)
		response := map[string]any{
			"ok":                  true,
			"lang":                lang,
			"name":                name,
			"route_key":           ws.RouteKey,
			"connection_id":       ws.ConnectionID,
			"management_endpoint": ws.ManagementEndpoint,
			"request_id":          ws.RequestID,
		}
		if command.Cmd == "get" {
			// The client is built from the function environment alone: the
			// runner injects the @connections endpoint as the API Gateway
			// Management API endpoint override, so no explicit endpoint is set.
			client, err := managementClient(ctx.Context(), "")
			if err != nil {
				return nil, err
			}
			connection, err := client.GetConnection(ctx.Context(), &apigatewaymanagementapi.GetConnectionInput{
				ConnectionId: &ws.ConnectionID,
			})
			if err != nil {
				return nil, err
			}
			response["connection"] = map[string]any{
				"connected_at":   connection.ConnectedAt.UnixMilli(),
				"last_active_at": connection.LastActiveAt.UnixMilli(),
			}
			return apptheory.MustJSON(200, response), nil
		}
		if ws != nil {
			if err := ws.SendJSONMessage(map[string]any{
				"ok":   true,
				"lang": lang,
				"name": name,
			}); err != nil {
				return nil, err
			}
		}
		return apptheory.MustJSON(200, response), nil
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
		appendEventBridgeRecord(recordEventBridgeEvent("rule", event))
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
		appendEventBridgeRecord(recordEventBridgeEvent("schedule", event))
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
		appendStreamRecord(recordStreamEvent(record))
		if poison, ok := record.Change.NewImage["poison"]; ok && poison.Boolean() {
			return fmt.Errorf("poison record %s", record.Change.SequenceNumber)
		}
		return nil
	})
	app.Get("/stream-records", func(_ *apptheory.Context) (*apptheory.Response, error) {
		streamMu.Lock()
		defer streamMu.Unlock()
		return apptheory.MustJSON(200, map[string]any{"records": append([]map[string]any(nil), streamRecords...)}), nil
	})
	app.Get("/eventbridge-records", func(_ *apptheory.Context) (*apptheory.Response, error) {
		eventBridgeMu.Lock()
		defer eventBridgeMu.Unlock()
		return apptheory.MustJSON(200, map[string]any{"records": append([]map[string]any(nil), eventBridgeRecords...)}), nil
	})

	snsTopicName := os.Getenv("APPTHEORY_DEMO_SNS_NAME")
	app.SNS(snsTopicName, func(_ *apptheory.EventContext, record events.SNSEventRecord) (any, error) {
		entry := recordSNSEvent(lang, record)
		snsRecordMu.Lock()
		lastSNSRecord = entry
		snsRecordMu.Unlock()
		return entry, nil
	})
	app.Get("/sns-record", func(_ *apptheory.Context) (*apptheory.Response, error) {
		snsRecordMu.Lock()
		defer snsRecordMu.Unlock()
		return apptheory.MustJSON(200, map[string]any{"record": lastSNSRecord}), nil
	})

	return app
}

func main() {
	app := buildApp()
	lambda.Start(func(ctx context.Context, event json.RawMessage) (any, error) {
		return app.HandleLambda(ctx, event)
	})
}
