package apptheory

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
)

func TestEventContext_DefaultBranches_ContextNowNewIDAndGet(t *testing.T) {
	t.Parallel()

	type ctxKey struct{}
	ctx := context.WithValue(context.Background(), ctxKey{}, "v")
	evt := &EventContext{ctx: ctx}
	if got := evt.Context(); got == nil {
		t.Fatal("expected non-nil context")
	}
	if got := evt.Now(); got.IsZero() {
		t.Fatal("expected Now() to return a non-zero time when clock is nil")
	}
	if got := evt.NewID(); got == "" {
		t.Fatal("expected NewID() to return a non-empty id when ids is nil")
	}
	if got := evt.Get("missing"); got != nil {
		t.Fatalf("expected missing key to return nil, got %#v", got)
	}
}

func TestApp_EventSourceRegistrations_InvalidInputsDoNotAddRoutes(t *testing.T) {
	t.Parallel()

	var nilApp *App
	if got := nilApp.SQS("q", func(*EventContext, events.SQSMessage) error { return nil }); got != nil {
		t.Fatal("expected nil app to remain nil")
	}

	app := New()
	sqsBefore := len(app.sqsRoutes)
	app.SQS("  ", func(*EventContext, events.SQSMessage) error { return nil })
	app.SQS("q", nil)
	if len(app.sqsRoutes) != sqsBefore {
		t.Fatalf("expected sqs routes to be unchanged, got %d", len(app.sqsRoutes))
	}

	ebBefore := len(app.eventBridgeRoutes)
	app.EventBridge(EventBridgeSelector{}, func(*EventContext, events.EventBridgeEvent) (any, error) { return nil, nil })
	app.EventBridge(EventBridgeSelector{RuleName: "r"}, nil)
	if len(app.eventBridgeRoutes) != ebBefore {
		t.Fatalf("expected eventbridge routes to be unchanged, got %d", len(app.eventBridgeRoutes))
	}
}

func TestSQSAndKinesisHandlerSelection_ContinueAndBreakPaths(t *testing.T) {
	t.Parallel()

	app := New()
	saw := false
	app.SQS("queue1", func(_ *EventContext, _ events.SQSMessage) error { saw = true; return nil })

	// First record has no ARN, second record matches => continue path.
	handler := app.sqsHandlerForEvent(events.SQSEvent{
		Records: []events.SQSMessage{
			{EventSourceARN: "  "},
			{EventSourceARN: "arn:aws:sqs:us-east-1:123:queue1"},
		},
	})
	if handler == nil {
		t.Fatal("expected handler for second record")
	}
	if err := handler(app.eventContext(context.Background()), events.SQSMessage{}); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if !saw {
		t.Fatal("expected handler to be invoked")
	}

	// First record has a non-empty ARN but doesn't match => break path (no handler).
	handler = app.sqsHandlerForEvent(events.SQSEvent{
		Records: []events.SQSMessage{
			{EventSourceARN: "arn:aws:sqs:us-east-1:123:other"},
			{EventSourceARN: "arn:aws:sqs:us-east-1:123:queue1"},
		},
	})
	if handler != nil {
		t.Fatal("expected no handler due to early break")
	}

	// Kinesis selection break/continue paths.
	app.Kinesis("stream1", func(_ *EventContext, _ events.KinesisEventRecord) error { return nil })
	kHandler := app.kinesisHandlerForEvent(events.KinesisEvent{
		Records: []events.KinesisEventRecord{
			{EventSourceArn: " "},
			{EventSourceArn: "arn:aws:kinesis:us-east-1:123:stream/stream1"},
		},
	})
	if kHandler == nil {
		t.Fatal("expected kinesis handler for second record")
	}
	if app.kinesisHandlerForEvent(events.KinesisEvent{Records: []events.KinesisEventRecord{{EventSourceArn: "arn:aws:kinesis:us-east-1:123:stream/other"}}}) != nil {
		t.Fatal("expected no kinesis handler for non-matching stream")
	}
}

func TestEventBridgeHandlerSelection_RuleNameThenPattern(t *testing.T) {
	t.Parallel()

	app := New()
	app.EventBridge(EventBridgeRule("rule1"), func(_ *EventContext, _ events.EventBridgeEvent) (any, error) { return "rule", nil })
	app.EventBridge(EventBridgePattern("src", "dt"), func(_ *EventContext, _ events.EventBridgeEvent) (any, error) { return "pattern", nil })

	handler := app.eventBridgeHandlerForEvent(events.EventBridgeEvent{
		Resources:  []string{"arn:aws:events:us-east-1:123:rule/rule1"},
		Source:     "other",
		DetailType: "other",
	})
	if handler == nil {
		t.Fatal("expected rule handler")
	}

	handler = app.eventBridgeHandlerForEvent(events.EventBridgeEvent{
		Resources:  []string{"arn:aws:events:us-east-1:123:rule/other"},
		Source:     "src",
		DetailType: "dt",
	})
	if handler == nil {
		t.Fatal("expected pattern handler")
	}
}

func TestHandleLambda_ProbeAndEnvelopeBranches(t *testing.T) {
	t.Parallel()

	app := New(WithTier(TierP0))

	// Invalid records probe JSON should not claim handling.
	outAny, ok, err := app.handleLambdaRecords(context.Background(), json.RawMessage(`{}`), lambdaEnvelope{
		Records: json.RawMessage(`not-json`),
	})
	if err != nil || ok || outAny != nil {
		t.Fatalf("expected (nil,false,nil) for invalid records probe, got out=%v ok=%v err=%v", outAny, ok, err)
	}

	// Empty probe list.
	outAny, ok, err = app.handleLambdaRecords(context.Background(), json.RawMessage(`{}`), lambdaEnvelope{
		Records: json.RawMessage(`[]`),
	})
	if err != nil || ok || outAny != nil {
		t.Fatalf("expected (nil,false,nil) for empty records probe, got out=%v ok=%v err=%v", outAny, ok, err)
	}

	// EventBridge: nil DetailType should not claim handling.
	outAny, ok, err = app.handleLambdaEventBridge(context.Background(), json.RawMessage(`{}`), lambdaEnvelope{})
	if err != nil || ok || outAny != nil {
		t.Fatalf("expected (nil,false,nil) for missing detail-type, got out=%v ok=%v err=%v", outAny, ok, err)
	}

	// RequestContext unmarshal failure should not claim handling.
	outAny, ok, err = app.handleLambdaRequestContext(context.Background(), json.RawMessage(`{}`), lambdaEnvelope{
		RequestContext: json.RawMessage(`"bad"`),
	})
	if err != nil || ok || outAny != nil {
		t.Fatalf("expected (nil,false,nil) for invalid requestContext probe, got out=%v ok=%v err=%v", outAny, ok, err)
	}

	// ALB request context with non-empty method should dispatch.
	alb, err := json.Marshal(events.ALBTargetGroupRequest{
		HTTPMethod: "GET",
		Path:       "/",
		RequestContext: events.ALBTargetGroupRequestContext{
			ELB: events.ELBContext{TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/x/abc"},
		},
	})
	if err != nil {
		t.Fatalf("marshal alb: %v", err)
	}

	var env lambdaEnvelope
	if unmarshalErr := json.Unmarshal(alb, &env); unmarshalErr != nil {
		t.Fatalf("unmarshal alb env: %v", unmarshalErr)
	}

	app.Get("/", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })
	outAny, ok, err = app.handleLambdaRequestContext(context.Background(), alb, env)
	if err != nil || !ok || outAny == nil {
		t.Fatalf("expected alb to dispatch, got out=%v ok=%v err=%v", outAny, ok, err)
	}
	if _, ok := outAny.(events.ALBTargetGroupResponse); !ok {
		t.Fatalf("expected ALBTargetGroupResponse, got %T", outAny)
	}

	_ = time.Now() // silence potential flake paranoia for time-based helpers
}
