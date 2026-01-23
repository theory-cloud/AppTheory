package apptheory

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
)

func TestEventContext_Basics_NilSafetyAndDeterminism(t *testing.T) {
	t.Parallel()

	var nilCtx *EventContext
	if got := nilCtx.Context(); got == nil {
		t.Fatal("expected nil EventContext.Context() to return a non-nil context")
	}
	if got := nilCtx.Get("k"); got != nil {
		t.Fatalf("expected nil Get() to return nil, got %#v", got)
	}
	nilCtx.Set("k", "v") // should not panic

	fixedNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	evt := &EventContext{
		ctx:   context.Background(),
		clock: testFixedClock{now: fixedNow},
		ids:   fixedIDGenerator("id_1"),
	}
	if got := evt.Now(); !got.Equal(fixedNow) {
		t.Fatalf("expected fixed Now, got %v", got)
	}
	if got := evt.NewID(); got != "id_1" {
		t.Fatalf("expected fixed NewID, got %q", got)
	}

	evt.Set("  ", "ignored")
	if got := evt.Get(" "); got != nil {
		t.Fatalf("expected Get(blank) to return nil, got %#v", got)
	}
	evt.Set("k", "v")
	if got := evt.Get("k"); got != "v" {
		t.Fatalf("expected Get(k)=v, got %#v", got)
	}
}

func TestARNParsingHelpers_CoverEdgeCases(t *testing.T) {
	t.Parallel()

	if got := sqsQueueNameFromARN(""); got != "" {
		t.Fatalf("expected empty sqs queue name, got %q", got)
	}
	if got := sqsQueueNameFromARN("arn:aws:sqs:us-east-1:123:queue1"); got != "queue1" {
		t.Fatalf("unexpected sqs queue name: %q", got)
	}

	if got := kinesisStreamNameFromARN(""); got != "" {
		t.Fatalf("expected empty stream name, got %q", got)
	}
	if got := kinesisStreamNameFromARN("arn:aws:kinesis:us-east-1:123:stream/stream1"); got != "stream1" {
		t.Fatalf("unexpected kinesis stream name: %q", got)
	}
	if got := kinesisStreamNameFromARN("stream1"); got != "stream1" {
		t.Fatalf("unexpected kinesis stream fallback name: %q", got)
	}

	if got := snsTopicNameFromARN(""); got != "" {
		t.Fatalf("expected empty sns topic name, got %q", got)
	}
	if got := snsTopicNameFromARN("arn:aws:sns:us-east-1:123:topic1"); got != "topic1" {
		t.Fatalf("unexpected sns topic name: %q", got)
	}

	if got := eventBridgeRuleNameFromARN(""); got != "" {
		t.Fatalf("expected empty rule name, got %q", got)
	}
	if got := eventBridgeRuleNameFromARN("arn:aws:events:us-east-1:123:rule/my-rule"); got != "my-rule" {
		t.Fatalf("unexpected rule name: %q", got)
	}
	if got := eventBridgeRuleNameFromARN("arn:aws:events:us-east-1:123:rule/my-rule/extra"); got != "my-rule" {
		t.Fatalf("unexpected rule name with suffix: %q", got)
	}
	if got := eventBridgeRuleNameFromARN("rule/my-rule"); got != "my-rule" {
		t.Fatalf("unexpected rule name without arn prefix: %q", got)
	}
	if got := eventBridgeRuleNameFromARN("arn:aws:events:us-east-1:123:rule/"); got != "" {
		t.Fatalf("expected empty rule name for trailing slash, got %q", got)
	}
	if got := eventBridgeRuleNameFromARN("nope"); got != "" {
		t.Fatalf("expected unknown arn to return empty rule name, got %q", got)
	}

	if got := dynamoDBTableNameFromStreamARN(""); got != "" {
		t.Fatalf("expected empty table name, got %q", got)
	}
	if got := dynamoDBTableNameFromStreamARN("arn:aws:dynamodb:us-east-1:123:table/tbl/stream/2020"); got != "tbl" {
		t.Fatalf("unexpected dynamodb table name: %q", got)
	}
	if got := dynamoDBTableNameFromStreamARN("arn:aws:dynamodb:us-east-1:123:table/tbl"); got != "tbl" {
		t.Fatalf("unexpected dynamodb table name without stream: %q", got)
	}
	if got := dynamoDBTableNameFromStreamARN("nope"); got != "" {
		t.Fatalf("expected unknown arn to return empty table name, got %q", got)
	}
}

func TestBatchItemFailures_WithNilHandler_FailsClosed(t *testing.T) {
	t.Parallel()

	type rec struct{ ID string }
	type fail struct {
		ItemIdentifier string `json:"itemIdentifier"`
	}

	out := batchItemFailures([]rec{{ID: "a"}, {ID: ""}}, nil, func(r rec) string { return r.ID }, func(id string) fail {
		return fail{ItemIdentifier: id}
	})
	if len(out) != 1 || out[0].ItemIdentifier != "a" {
		t.Fatalf("unexpected failures: %#v", out)
	}
}

func TestWrapEventRecordHandler_MiddlewareCanBreakTypeCoercion(t *testing.T) {
	t.Parallel()

	app := New()
	app.UseEvents(func(next EventHandler) EventHandler {
		return func(ctx *EventContext, _ any) (any, error) {
			return next(ctx, "wrong-type")
		}
	})

	called := false
	handler := wrapEventRecordHandler(
		app,
		func(_ *EventContext, _ events.SQSMessage) error {
			called = true
			return nil
		},
		func(v any) (events.SQSMessage, bool) {
			msg, ok := v.(events.SQSMessage)
			return msg, ok
		},
		"apptheory: invalid sqs record type",
	)

	err := handler(app.eventContext(context.Background()), events.SQSMessage{MessageId: "1"})
	if err == nil || err.Error() != "apptheory: invalid sqs record type" {
		t.Fatalf("expected invalid type error, got %v", err)
	}
	if called {
		t.Fatal("did not expect handler to be called when coercion fails")
	}

	outHandler := wrapEventRecordHandlerWithOutput(
		app,
		func(_ *EventContext, _ events.SNSEventRecord) (any, error) { return "ok", nil },
		func(v any) (events.SNSEventRecord, bool) {
			rec, ok := v.(events.SNSEventRecord)
			return rec, ok
		},
		"apptheory: invalid sns record type",
	)
	if _, err := outHandler(app.eventContext(context.Background()), events.SNSEventRecord{}); err == nil || err.Error() != "apptheory: invalid sns record type" {
		t.Fatalf("expected invalid type error for output handler, got %v", err)
	}
}

func TestHandleLambdaRecords_AndRequestContext_ErrorPathsAndWebSocketEnablement(t *testing.T) {
	t.Parallel()

	app := New(WithTier(TierP0), WithIDGenerator(fixedIDGenerator("req_test")))
	app.Get("/", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })
	app.SQS("queue1", func(_ *EventContext, _ events.SQSMessage) error { return nil })
	app.WebSocket("$default", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })

	// Records probe ok, but SQS unmarshal fails due to wrong messageId type.
	env := lambdaEnvelope{
		Records: json.RawMessage(`[{"eventSource":"aws:sqs"}]`),
	}
	event := json.RawMessage(`{"Records":[{"eventSource":"aws:sqs","eventSourceARN":"arn:aws:sqs:us-east-1:123:queue1","messageId":{}}]}`)
	if _, ok, err := app.handleLambdaRecords(context.Background(), event, env); !ok || err == nil {
		t.Fatalf("expected handleLambdaRecords to report parse error, got ok=%v err=%v", ok, err)
	}

	// RequestContext probe http present and routeKey present, but inner types invalid.
	requestCtxBadHTTP := json.RawMessage(`{"routeKey":"$default","requestContext":{"http":"bad"}}`)
	var httpEnv lambdaEnvelope
	if err := json.Unmarshal(requestCtxBadHTTP, &httpEnv); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if _, ok, err := app.handleLambdaRequestContext(context.Background(), requestCtxBadHTTP, httpEnv); !ok || err == nil {
		t.Fatalf("expected apigw v2 parse error, got ok=%v err=%v", ok, err)
	}

	// Lambda URL: http present and routeKey absent, but inner types invalid.
	lambdaURLBadHTTP := json.RawMessage(`{"requestContext":{"http":"bad"}}`)
	var urlEnv lambdaEnvelope
	if err := json.Unmarshal(lambdaURLBadHTTP, &urlEnv); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if _, ok, err := app.handleLambdaRequestContext(context.Background(), lambdaURLBadHTTP, urlEnv); !ok || err == nil {
		t.Fatalf("expected lambda url parse error, got ok=%v err=%v", ok, err)
	}

	// WebSocket event: disable websockets -> should fall through and fail as unknown.
	wsBytes, err := json.Marshal(events.APIGatewayWebsocketProxyRequest{
		HTTPMethod: "GET",
		Path:       "/",
		RequestContext: events.APIGatewayWebsocketProxyRequestContext{
			ConnectionID: "c1",
			RouteKey:     "$default",
			RequestID:    "req_1",
		},
	})
	if err != nil {
		t.Fatalf("marshal ws: %v", err)
	}

	// Use an app with websockets disabled.
	appNoWS := New(WithTier(TierP0))
	_, err = appNoWS.HandleLambda(context.Background(), wsBytes)
	if err == nil {
		t.Fatal("expected websocket event to be unrecognized when websockets disabled")
	}

	// With websockets enabled, it should dispatch.
	out, err := app.HandleLambda(context.Background(), wsBytes)
	if err != nil {
		t.Fatalf("HandleLambda(ws) error: %v", err)
	}
	if _, ok := out.(events.APIGatewayProxyResponse); !ok {
		t.Fatalf("expected APIGatewayProxyResponse, got %T", out)
	}

	// ALB request context with empty HTTPMethod should not dispatch, leading to unknown event.
	albEmptyMethod, err := json.Marshal(events.ALBTargetGroupRequest{
		HTTPMethod: "",
		Path:       "/",
		RequestContext: events.ALBTargetGroupRequestContext{
			ELB: events.ELBContext{TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/x/abc"},
		},
	})
	if err != nil {
		t.Fatalf("marshal alb: %v", err)
	}
	_, handleErr := app.HandleLambda(context.Background(), albEmptyMethod)
	if handleErr == nil {
		t.Fatal("expected alb event with empty method to be unrecognized")
	}

	// Proxy request with empty HTTPMethod should not dispatch.
	proxyEmptyMethod, err := json.Marshal(events.APIGatewayProxyRequest{
		HTTPMethod: "",
		Path:       "/",
	})
	if err != nil {
		t.Fatalf("marshal proxy: %v", err)
	}
	_, handleErr = app.HandleLambda(context.Background(), proxyEmptyMethod)
	if handleErr == nil {
		t.Fatal("expected proxy event with empty method to be unrecognized")
	}

	// ConnectionID present, but websocket unmarshal fails due to requestContext type mismatch.
	wsBad := json.RawMessage(`{"requestContext":{"connectionId":"c1","routeKey":"$default","requestId":"req_1","domainName":"example.com","stage":"dev"},"headers":{}}`)
	var wsEnv lambdaEnvelope
	if unmarshalErr := json.Unmarshal(wsBad, &wsEnv); unmarshalErr != nil {
		t.Fatalf("unmarshal envelope: %v", unmarshalErr)
	}
	if _, ok, ctxErr := app.handleLambdaRequestContext(context.Background(), wsBad, wsEnv); !ok || ctxErr != nil {
		// For a valid websocket event, this should dispatch. This input lacks required fields for AWS
		// structs but should still unmarshal; guard against regressions.
		t.Fatalf("expected websocket dispatch attempt, got ok=%v err=%v", ok, ctxErr)
	}

	// EventBridge unmarshal failure: invalid resources field type.
	ebEnv := lambdaEnvelope{DetailType: ptr("t")}
	ebBad := json.RawMessage(`{"resources":"nope"}`)
	if _, ok, bridgeErr := app.handleLambdaEventBridge(context.Background(), ebBad, ebEnv); !ok || bridgeErr == nil {
		t.Fatalf("expected eventbridge parse error, got ok=%v err=%v", ok, bridgeErr)
	}

	// EventBridge: support detailType alias for dispatch and selector matching.
	app.EventBridge(EventBridgePattern("src", "dt"), func(_ *EventContext, _ events.EventBridgeEvent) (any, error) {
		return "ok", nil
	})
	ebAlias := json.RawMessage(`{"detailType":"dt","source":"src","resources":[]}`)
	var ebAliasEnv lambdaEnvelope
	if unmarshalErr := json.Unmarshal(ebAlias, &ebAliasEnv); unmarshalErr != nil {
		t.Fatalf("unmarshal eventbridge alias env: %v", unmarshalErr)
	}
	outAny, ok, bridgeErr := app.handleLambdaEventBridge(context.Background(), ebAlias, ebAliasEnv)
	if bridgeErr != nil || !ok || outAny == nil {
		t.Fatalf("expected eventbridge alias dispatch, got out=%v ok=%v err=%v", outAny, ok, bridgeErr)
	}
	outStr, ok := outAny.(string)
	if !ok {
		t.Fatalf("expected string handler output, got %T", outAny)
	}
	if got := strings.TrimSpace(outStr); got != "ok" {
		t.Fatalf("expected handler output %q, got %q", "ok", got)
	}

	// Default: ensure unknown record source does not claim handling.
	env = lambdaEnvelope{Records: json.RawMessage(`[{"eventSource":"aws:unknown"}]`)}
	outAny, ok, err = app.handleLambdaRecords(context.Background(), json.RawMessage(`{"Records":[{"eventSource":"aws:unknown"}]}`), env)
	if err != nil || ok || outAny != nil {
		t.Fatalf("expected unknown source to return (nil,false,nil), got out=%v ok=%v err=%v", outAny, ok, err)
	}

	// Defensive: nil app should fail.
	if _, err := (*App)(nil).HandleLambda(context.Background(), json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected nil app to error")
	}

	// Defensive: empty event should fail.
	if _, err := app.HandleLambda(context.Background(), json.RawMessage(`  `)); err == nil {
		t.Fatal("expected empty event to error")
	}
}

func ptr[T any](v T) *T { return &v }

func TestServeSNS_ReturnsHandlerError(t *testing.T) {
	t.Parallel()

	app := New()
	app.SNS("topic1", func(_ *EventContext, _ events.SNSEventRecord) (any, error) {
		return nil, errors.New("boom")
	})

	_, err := app.ServeSNS(context.Background(), events.SNSEvent{
		Records: []events.SNSEventRecord{
			{SNS: events.SNSEntity{TopicArn: "arn:aws:sns:us-east-1:123:topic1"}},
		},
	})
	if err == nil {
		t.Fatal("expected handler error to be returned")
	}
}
