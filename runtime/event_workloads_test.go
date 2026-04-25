package apptheory

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
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

func TestNormalizeDynamoDBStreamRecord_ExcludesRawImagesFromSafeLog(t *testing.T) {
	t.Parallel()

	summary := NormalizeDynamoDBStreamRecord(events.DynamoDBEventRecord{
		AWSRegion:      "us-east-1",
		EventID:        "stream-evt-1",
		EventName:      "MODIFY",
		EventSourceArn: "arn:aws:dynamodb:us-east-1:000000000000:table/ReleaseState/stream/2026-04-24T12:00:00.000",
		Change: events.DynamoDBStreamRecord{
			Keys: map[string]events.DynamoDBAttributeValue{
				"pk": events.NewStringAttribute("release#rel_123"),
			},
			NewImage: map[string]events.DynamoDBAttributeValue{
				"secret": events.NewStringAttribute("do-not-log"),
			},
			OldImage: map[string]events.DynamoDBAttributeValue{
				"secret": events.NewStringAttribute("previous-secret"),
			},
			SequenceNumber: "000000000000000001",
			SizeBytes:      128,
			StreamViewType: "NEW_AND_OLD_IMAGES",
		},
	})

	if summary.TableName != "ReleaseState" || summary.SequenceNumber != "000000000000000001" {
		t.Fatalf("unexpected normalized summary: %#v", summary)
	}
	for _, sentinel := range []string{"release#rel_123", "do-not-log", "previous-secret"} {
		if strings.Contains(summary.SafeLog, sentinel) {
			t.Fatalf("safe log leaked sentinel %q: %q", sentinel, summary.SafeLog)
		}
	}
}

func TestServeEventBridge_RecoversPanicAndRecordsEventObservability(t *testing.T) {
	t.Parallel()

	var logs []LogRecord
	var metrics []MetricRecord
	var spans []SpanRecord
	app := New(WithObservability(ObservabilityHooks{
		Log: func(r LogRecord) {
			logs = append(logs, r)
		},
		Metric: func(r MetricRecord) {
			metrics = append(metrics, r)
		},
		Span: func(r SpanRecord) {
			spans = append(spans, r)
		},
	}))
	app.EventBridge(EventBridgePattern("apptheory.test", "thing.panic"), func(_ *EventContext, _ events.EventBridgeEvent) (any, error) {
		panic("do-not-log")
	})

	ctx := lambdacontext.NewContext(context.Background(), &lambdacontext.LambdaContext{AwsRequestID: "aws-req"})
	out, err := app.ServeEventBridge(ctx, events.EventBridgeEvent{
		ID:         "evt-1",
		Source:     "apptheory.test",
		DetailType: "thing.panic",
	})
	if out != nil || err == nil || err.Error() != eventWorkloadFailedMessage {
		t.Fatalf("expected safe event workload failure, out=%v err=%v", out, err)
	}
	if strings.Contains(err.Error(), "do-not-log") {
		t.Fatalf("safe error leaked panic payload: %v", err)
	}
	if len(logs) != 1 || logs[0].Level != "error" || logs[0].ErrorCode != "app.internal" || logs[0].CorrelationID != "evt-1" {
		t.Fatalf("unexpected event log records: %#v", logs)
	}
	if len(metrics) != 1 || metrics[0].Tags["outcome"] != "error" || metrics[0].Tags["trigger"] != "eventbridge" {
		t.Fatalf("unexpected event metrics: %#v", metrics)
	}
	if len(spans) != 1 || spans[0].Attributes["error.code"] != "app.internal" {
		t.Fatalf("unexpected event spans: %#v", spans)
	}
}

func TestServeDynamoDBStream_RecordsPerRecordObservability(t *testing.T) {
	t.Parallel()

	var logs []LogRecord
	app := New(WithObservability(ObservabilityHooks{
		Log: func(r LogRecord) {
			logs = append(logs, r)
		},
	}))
	app.DynamoDB("ReleaseState", func(_ *EventContext, record events.DynamoDBEventRecord) error {
		if record.EventName == "REMOVE" {
			return errors.New("do-not-log")
		}
		return nil
	})

	out := app.ServeDynamoDBStream(context.Background(), events.DynamoDBEvent{Records: []events.DynamoDBEventRecord{
		{
			EventID:        "stream-1",
			EventName:      "MODIFY",
			EventSourceArn: "arn:aws:dynamodb:us-east-1:000000000000:table/ReleaseState/stream/2026",
			Change:         events.DynamoDBStreamRecord{SequenceNumber: "1", StreamViewType: "NEW_AND_OLD_IMAGES"},
		},
		{
			EventID:        "stream-2",
			EventName:      "REMOVE",
			EventSourceArn: "arn:aws:dynamodb:us-east-1:000000000000:table/ReleaseState/stream/2026",
			Change:         events.DynamoDBStreamRecord{SequenceNumber: "2", StreamViewType: "NEW_AND_OLD_IMAGES"},
		},
	}})
	if len(out.BatchItemFailures) != 1 || out.BatchItemFailures[0].ItemIdentifier != "stream-2" {
		t.Fatalf("unexpected batch failures: %#v", out.BatchItemFailures)
	}
	if len(logs) != 2 {
		t.Fatalf("expected per-record logs, got %#v", logs)
	}
	if logs[0].Level != "info" || logs[0].Trigger != "dynamodb_stream" || logs[0].CorrelationID != "stream-1" {
		t.Fatalf("unexpected success log: %#v", logs[0])
	}
	if logs[1].Level != "error" || logs[1].ErrorCode != "app.internal" || logs[1].EventID != "stream-2" {
		t.Fatalf("unexpected error log: %#v", logs[1])
	}
}
