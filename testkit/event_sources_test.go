package testkit

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func TestSQSEvent_Defaults(t *testing.T) {
	out := SQSEvent(SQSEventOptions{
		QueueARN: "arn:aws:sqs:us-east-1:123:queue1",
		Records: []SQSMessageOptions{
			{MessageID: "", Body: "a"},
			{MessageID: "id2", Body: "b", EventSourceARN: "arn:aws:sqs:us-east-1:123:override"},
		},
	})
	if len(out.Records) != 2 {
		t.Fatalf("expected 2 records, got %d", len(out.Records))
	}
	if out.Records[0].MessageId == "" || out.Records[0].EventSource != "aws:sqs" {
		t.Fatalf("unexpected first record: %#v", out.Records[0])
	}
	if out.Records[0].EventSourceARN != "arn:aws:sqs:us-east-1:123:queue1" {
		t.Fatalf("unexpected default arn: %q", out.Records[0].EventSourceARN)
	}
	if out.Records[1].MessageId != "id2" || out.Records[1].EventSourceARN != "arn:aws:sqs:us-east-1:123:override" {
		t.Fatalf("unexpected second record: %#v", out.Records[1])
	}
}

func TestEventBridgeEvent_DefaultsAndDetail(t *testing.T) {
	out := EventBridgeEvent(EventBridgeEventOptions{
		Detail: map[string]any{"ok": true},
	})
	if out.ID == "" || out.Source == "" || out.DetailType == "" || out.Region == "" || out.AccountID == "" {
		t.Fatalf("expected defaults, got %#v", out)
	}
	if string(out.Detail) == "null" {
		t.Fatalf("expected detail to be marshaled, got %s", string(out.Detail))
	}

	// Unmarshal failure yields null detail.
	out = EventBridgeEvent(EventBridgeEventOptions{
		Detail: make(chan int),
	})
	if string(out.Detail) != "null" {
		t.Fatalf("expected null detail, got %s", string(out.Detail))
	}
}

func TestDynamoDBStreamEvent_Defaults(t *testing.T) {
	out := DynamoDBStreamEvent(DynamoDBStreamEventOptions{
		StreamARN: "arn:aws:dynamodb:us-east-1:123:table/t/stream/x",
		Records:   []DynamoDBStreamRecordOptions{{}},
	})
	if len(out.Records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(out.Records))
	}
	rec := out.Records[0]
	if rec.EventID == "" || rec.EventName != "MODIFY" || rec.EventSource != "aws:dynamodb" || rec.EventSourceArn == "" {
		t.Fatalf("unexpected record: %#v", rec)
	}
}

func TestKinesisEvent_DefaultsAndDataCopy(t *testing.T) {
	data := []byte("hi")
	out := KinesisEvent(KinesisEventOptions{
		StreamARN: "arn:aws:kinesis:us-east-1:123:stream/s",
		Records: []KinesisRecordOptions{
			{Data: data},
		},
	})
	if len(out.Records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(out.Records))
	}
	rec := out.Records[0]
	data[0] = 'X'
	if string(rec.Kinesis.Data) != "hi" {
		t.Fatalf("expected data copy, got %q", string(rec.Kinesis.Data))
	}
}

func TestSNSEvent_Defaults(t *testing.T) {
	out := SNSEvent(SNSEventOptions{
		TopicARN: "arn:aws:sns:us-east-1:123:topic1",
		Records: []SNSRecordOptions{
			{Subject: "  hello  ", Message: "m"},
		},
	})
	if len(out.Records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(out.Records))
	}
	rec := out.Records[0]
	if rec.EventSource != "aws:sns" || rec.SNS.TopicArn != "arn:aws:sns:us-east-1:123:topic1" || rec.SNS.Subject != "hello" {
		t.Fatalf("unexpected sns record: %#v", rec)
	}
	if !rec.SNS.Timestamp.Equal(time.Unix(0, 0).UTC()) {
		t.Fatalf("unexpected sns timestamp: %v", rec.SNS.Timestamp)
	}
}

func TestStepFunctionsTaskTokenEvent(t *testing.T) {
	out := StepFunctionsTaskTokenEvent(StepFunctionsTaskTokenEventOptions{
		TaskToken: " tok ",
		Payload:   map[string]any{"taskToken": "ignored", "x": 1},
	})
	if out["taskToken"] != "tok" {
		t.Fatalf("unexpected taskToken: %v", out["taskToken"])
	}
	if out["x"] != 1 {
		t.Fatalf("unexpected payload passthrough: %v", out)
	}
}

func TestEnv_InvokeEventSources(t *testing.T) {
	env := New()
	app := env.App(apptheory.WithTier(apptheory.TierP0))
	app.SQS("queue1", func(_ *apptheory.EventContext, _ events.SQSMessage) error { return nil })
	app.EventBridge(apptheory.EventBridgePattern("src", "type"), func(_ *apptheory.EventContext, _ events.EventBridgeEvent) (any, error) {
		return map[string]any{"ok": true}, nil
	})

	sqs := SQSEvent(SQSEventOptions{
		QueueARN: "arn:aws:sqs:us-east-1:123:queue1",
		Records:  []SQSMessageOptions{{}},
	})
	resp := env.InvokeSQS(context.Background(), app, sqs)
	if len(resp.BatchItemFailures) != 0 {
		t.Fatalf("unexpected sqs failures: %#v", resp.BatchItemFailures)
	}

	out, err := env.InvokeEventBridge(context.Background(), app, EventBridgeEvent(EventBridgeEventOptions{
		Source:     "src",
		DetailType: "type",
		Detail:     map[string]any{"x": "y"},
	}))
	if err != nil {
		t.Fatalf("InvokeEventBridge returned error: %v", err)
	}
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal output: %v", err)
	}
	if string(b) == "null" {
		t.Fatalf("unexpected eventbridge output: %v", out)
	}
}
