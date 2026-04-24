package apptheory

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambdacontext"
)

func TestNormalizeEventBridgeWorkloadEnvelope_UsesPortableCorrelationPrecedence(t *testing.T) {
	t.Parallel()

	app := New()
	app.EventBridge(EventBridgePattern("apptheory.test", "thing.changed"), func(ctx *EventContext, event events.EventBridgeEvent) (any, error) {
		envelope, err := RequireEventBridgeWorkloadEnvelope(ctx, event)
		if err != nil {
			return nil, err
		}
		return envelope, nil
	})

	raw := json.RawMessage(`{
		"version":"0",
		"id":"evt-123",
		"detail-type":"thing.changed",
		"source":"apptheory.test",
		"account":"000000000000",
		"time":"2026-04-24T12:00:00Z",
		"region":"us-east-1",
		"resources":["arn:aws:events:us-east-1:000000000000:rule/test"],
		"detail":{"correlation_id":"corr-detail"},
		"headers":{"X-Correlation-ID":["corr-header"]},
		"metadata":{"correlation_id":"corr-metadata"}
	}`)
	ctx := lambdacontext.NewContext(context.Background(), &lambdacontext.LambdaContext{AwsRequestID: "aws-req"})

	out, err := app.HandleLambda(ctx, raw)
	if err != nil {
		t.Fatalf("HandleLambda returned error: %v", err)
	}
	envelope, ok := out.(EventBridgeWorkloadEnvelope)
	if !ok {
		t.Fatalf("expected EventBridgeWorkloadEnvelope, got %T", out)
	}
	if envelope.CorrelationID != "corr-metadata" || envelope.CorrelationSource != eventBridgeCorrelationSourceMetadata {
		t.Fatalf("unexpected correlation: %#v", envelope)
	}
	if envelope.RequestID != "aws-req" || envelope.Time != "2026-04-24T12:00:00Z" {
		t.Fatalf("unexpected request/time fields: %#v", envelope)
	}
}

func TestRequireEventBridgeWorkloadEnvelope_FailsClosedWithoutCorrelation(t *testing.T) {
	t.Parallel()

	_, err := RequireEventBridgeWorkloadEnvelope(&EventContext{}, events.EventBridgeEvent{
		Source:     "apptheory.test",
		DetailType: "thing.changed",
	})
	if err == nil || err.Error() != "apptheory: eventbridge workload envelope invalid" {
		t.Fatalf("expected fail-closed validation error, got %v", err)
	}
}

func TestNormalizeEventBridgeScheduledWorkload_BuildsDeterministicSummary(t *testing.T) {
	t.Parallel()

	app := New(WithClock(fixedClock{now: time.Unix(0, 0).UTC()}))
	app.EventBridge(EventBridgePattern("aws.events", "Scheduled Event"), func(ctx *EventContext, event events.EventBridgeEvent) (any, error) {
		return NormalizeEventBridgeScheduledWorkload(ctx, event), nil
	})

	raw := json.RawMessage(`{
		"version":"0",
		"id":"sched-evt",
		"detail-type":"Scheduled Event",
		"source":"aws.events",
		"time":"2026-04-24T12:00:00Z",
		"detail":{
			"run_id":"run-1",
			"idempotency_key":"schedule/test/1",
			"result":{"status":"ok","processed":3,"failed":1}
		},
		"metadata":{"correlation_id":"corr-schedule"}
	}`)
	base := lambdacontext.NewContext(context.Background(), &lambdacontext.LambdaContext{AwsRequestID: "aws-req"})
	ctx, cancel := context.WithDeadline(base, time.Unix(0, 0).UTC().Add(25000*time.Millisecond))
	defer cancel()

	out, err := app.HandleLambda(ctx, raw)
	if err != nil {
		t.Fatalf("HandleLambda returned error: %v", err)
	}
	summary, ok := out.(EventBridgeScheduledWorkloadSummary)
	if !ok {
		t.Fatalf("expected EventBridgeScheduledWorkloadSummary, got %T", out)
	}
	if summary.RunID != "run-1" || summary.IdempotencyKey != "schedule/test/1" || summary.DeadlineUnixMS != 25000 {
		t.Fatalf("unexpected scheduled identity fields: %#v", summary)
	}
	if summary.Result.Status != "ok" || summary.Result.Processed != 3 || summary.Result.Failed != 1 {
		t.Fatalf("unexpected result summary: %#v", summary.Result)
	}
}
