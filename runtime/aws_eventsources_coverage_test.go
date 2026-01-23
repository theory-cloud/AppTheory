package apptheory

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambdacontext"
)

func TestEventContext_Get_TrimsKeysAndReturnsValue(t *testing.T) {
	t.Parallel()

	ctx := &EventContext{}
	ctx.Set(" k ", "v")
	if got := ctx.Get("k"); got != "v" {
		t.Fatalf("expected stored value, got %#v", got)
	}
	if got := ctx.Get("   "); got != nil {
		t.Fatalf("expected empty key to return nil, got %#v", got)
	}
}

func TestApp_EventContext_UsesLambdaContextAwsRequestID(t *testing.T) {
	t.Parallel()

	app := New(WithIDGenerator(fixedIDGenerator("fallback")))
	lc := &lambdacontext.LambdaContext{AwsRequestID: "  req_123  "}
	ctx := lambdacontext.NewContext(context.Background(), lc)

	evt := app.eventContext(ctx)
	if evt.RequestID != "req_123" {
		t.Fatalf("expected request id from LambdaContext, got %q", evt.RequestID)
	}
}

func TestApp_EventSourceRegistrations_KinesisSNSDynamoDB_InvalidInputs(t *testing.T) {
	t.Parallel()

	var nilApp *App
	if got := nilApp.Kinesis("s", func(*EventContext, events.KinesisEventRecord) error { return nil }); got != nil {
		t.Fatal("expected nil app to remain nil")
	}
	if got := nilApp.SNS("t", func(*EventContext, events.SNSEventRecord) (any, error) { return nil, nil }); got != nil {
		t.Fatal("expected nil app to remain nil")
	}
	if got := nilApp.DynamoDB("d", func(*EventContext, events.DynamoDBEventRecord) error { return nil }); got != nil {
		t.Fatal("expected nil app to remain nil")
	}

	app := New()
	kBefore := len(app.kinesisRoutes)
	snsBefore := len(app.snsRoutes)
	ddbBefore := len(app.dynamoDBRoutes)

	app.Kinesis("  ", func(*EventContext, events.KinesisEventRecord) error { return nil })
	app.Kinesis("stream", nil)
	app.SNS("  ", func(*EventContext, events.SNSEventRecord) (any, error) { return nil, nil })
	app.SNS("topic", nil)
	app.DynamoDB("  ", func(*EventContext, events.DynamoDBEventRecord) error { return nil })
	app.DynamoDB("table", nil)

	if len(app.kinesisRoutes) != kBefore {
		t.Fatalf("expected kinesis routes unchanged, got %d", len(app.kinesisRoutes))
	}
	if len(app.snsRoutes) != snsBefore {
		t.Fatalf("expected sns routes unchanged, got %d", len(app.snsRoutes))
	}
	if len(app.dynamoDBRoutes) != ddbBefore {
		t.Fatalf("expected dynamodb routes unchanged, got %d", len(app.dynamoDBRoutes))
	}
}

func TestKinesisStreamNameFromARN_UsesSuffixWhenNoSlash(t *testing.T) {
	t.Parallel()

	if got := kinesisStreamNameFromARN("arn:aws:kinesis:us-east-1:123:stream1"); got != "stream1" {
		t.Fatalf("expected stream1, got %q", got)
	}
}

func TestSNSAndDynamoDBHandlerSelection_ContinueAndBreakPaths(t *testing.T) {
	t.Parallel()

	app := New()

	app.SNS("topic1", func(_ *EventContext, _ events.SNSEventRecord) (any, error) { return "ok", nil })
	if handler := app.snsHandlerForEvent(events.SNSEvent{
		Records: []events.SNSEventRecord{
			{SNS: events.SNSEntity{TopicArn: "  "}},
			{SNS: events.SNSEntity{TopicArn: "arn:aws:sns:us-east-1:123:topic1"}},
		},
	}); handler == nil {
		t.Fatal("expected sns handler to be selected (continue path)")
	}
	if handler := app.snsHandlerForEvent(events.SNSEvent{
		Records: []events.SNSEventRecord{
			{SNS: events.SNSEntity{TopicArn: "arn:aws:sns:us-east-1:123:other"}},
			{SNS: events.SNSEntity{TopicArn: "arn:aws:sns:us-east-1:123:topic1"}},
		},
	}); handler != nil {
		t.Fatal("expected no sns handler due to early break")
	}

	app.DynamoDB("table1", func(_ *EventContext, _ events.DynamoDBEventRecord) error { return nil })
	if handler := app.dynamoDBHandlerForEvent(events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			{EventSourceArn: "  "},
			{EventSourceArn: "arn:aws:dynamodb:us-east-1:123:table/table1/stream/2020-01-01T00:00:00.000"},
		},
	}); handler == nil {
		t.Fatal("expected dynamodb handler to be selected (continue path)")
	}
	if handler := app.dynamoDBHandlerForEvent(events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			{EventSourceArn: "arn:aws:dynamodb:us-east-1:123:table/other/stream/2020-01-01T00:00:00.000"},
			{EventSourceArn: "arn:aws:dynamodb:us-east-1:123:table/table1/stream/2020-01-01T00:00:00.000"},
		},
	}); handler != nil {
		t.Fatal("expected no dynamodb handler due to early break")
	}
}

func TestDynamoDBTableNameFromStreamARN_ParsesTableNameWithoutStreamSegment(t *testing.T) {
	t.Parallel()

	arn := "arn:aws:dynamodb:us-east-1:123:table/table1/index/idx"
	if got := dynamoDBTableNameFromStreamARN(arn); got != "table1" {
		t.Fatalf("expected table1, got %q", got)
	}
}

func TestServeEventBridge_EventMiddleware_TypeAssertionFailure(t *testing.T) {
	t.Parallel()

	app := New()
	app.UseEvents(func(next EventHandler) EventHandler {
		return func(ctx *EventContext, _ any) (any, error) {
			return next(ctx, "not an eventbridge event")
		}
	})
	app.EventBridge(EventBridgePattern("src", "dt"), func(_ *EventContext, _ events.EventBridgeEvent) (any, error) {
		return "ok", nil
	})

	_, err := app.ServeEventBridge(context.Background(), events.EventBridgeEvent{Source: "src", DetailType: "dt"})
	if err == nil || !strings.Contains(err.Error(), "invalid eventbridge event type") {
		t.Fatalf("expected invalid type error, got %v", err)
	}
}

func TestHandleLambdaRecords_ParseErrors_ForKinesisDynamoDBAndSNS(t *testing.T) {
	t.Parallel()

	app := New()

	// Kinesis parse error.
	kinEnv := lambdaEnvelope{Records: json.RawMessage(`[{"eventSource":"aws:kinesis"}]`)}
	kinEvent := json.RawMessage(`{"Records":[{"eventSource":"aws:kinesis","eventSourceARN":"arn:aws:kinesis:us-east-1:123:stream/stream1","eventID":{}}]}`)
	_, ok, err := app.handleLambdaRecords(context.Background(), kinEvent, kinEnv)
	if !ok || err == nil || !strings.Contains(err.Error(), "parse kinesis event") {
		t.Fatalf("expected kinesis parse error, got ok=%v err=%v", ok, err)
	}

	// DynamoDB parse error.
	ddbEnv := lambdaEnvelope{Records: json.RawMessage(`[{"eventSource":"aws:dynamodb"}]`)}
	ddbEvent := json.RawMessage(`{"Records":[{"eventSource":"aws:dynamodb","eventSourceARN":"arn:aws:dynamodb:us-east-1:123:table/table1/stream/2020-01-01T00:00:00.000","eventID":{}}]}`)
	_, ok, err = app.handleLambdaRecords(context.Background(), ddbEvent, ddbEnv)
	if !ok || err == nil || !strings.Contains(err.Error(), "parse dynamodb stream event") {
		t.Fatalf("expected dynamodb parse error, got ok=%v err=%v", ok, err)
	}

	// SNS parse error.
	snsEnv := lambdaEnvelope{Records: json.RawMessage(`[{"EventSource":"aws:sns"}]`)}
	snsEvent := json.RawMessage(`{"Records":[{"EventSource":"aws:sns","Sns":"bad"}]}`)
	_, ok, err = app.handleLambdaRecords(context.Background(), snsEvent, snsEnv)
	if !ok || err == nil || !strings.Contains(err.Error(), "parse sns event") {
		t.Fatalf("expected sns parse error, got ok=%v err=%v", ok, err)
	}
}

func TestHandleLambdaRecords_SNS_UnrecognizedTopicReturnsError(t *testing.T) {
	t.Parallel()

	app := New()
	sns := events.SNSEvent{
		Records: []events.SNSEventRecord{
			{
				EventSource: "aws:sns",
				SNS:         events.SNSEntity{TopicArn: "arn:aws:sns:us-east-1:123:unknown"},
			},
		},
	}
	raw, err := json.Marshal(sns)
	if err != nil {
		t.Fatalf("marshal sns: %v", err)
	}
	var env lambdaEnvelope
	if unmarshalErr := json.Unmarshal(raw, &env); unmarshalErr != nil {
		t.Fatalf("unmarshal envelope: %v", unmarshalErr)
	}

	out, ok, err := app.handleLambdaRecords(context.Background(), raw, env)
	if !ok || err == nil || !strings.Contains(err.Error(), "unrecognized sns topic") {
		t.Fatalf("expected unrecognized topic error, got out=%v ok=%v err=%v", out, ok, err)
	}
}
