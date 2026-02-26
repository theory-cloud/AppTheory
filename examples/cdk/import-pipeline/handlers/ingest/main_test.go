package main

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/theory-cloud/apptheory/pkg/jobs"
)

type fakeIngestLedger struct {
	outcome jobs.IdempotencyCreateOutcome

	createIdempotencyErr error
	createJobErr         error
	completeErr          error

	idempotencyCreates  []jobs.CreateIdempotencyRecordInput
	jobsCreated         []jobs.CreateJobInput
	idempotencyComplete []jobs.CompleteIdempotencyRecordInput
}

func (f *fakeIngestLedger) CreateIdempotencyRecord(ctx context.Context, in jobs.CreateIdempotencyRecordInput) (*jobs.JobRequest, jobs.IdempotencyCreateOutcome, error) {
	if f.createIdempotencyErr != nil {
		return nil, "", f.createIdempotencyErr
	}
	f.idempotencyCreates = append(f.idempotencyCreates, in)
	return &jobs.JobRequest{JobID: in.JobID, IdempotencyKey: in.IdempotencyKey}, f.outcome, nil
}

func (f *fakeIngestLedger) CompleteIdempotencyRecord(ctx context.Context, in jobs.CompleteIdempotencyRecordInput) (*jobs.JobRequest, error) {
	if f.completeErr != nil {
		return nil, f.completeErr
	}
	f.idempotencyComplete = append(f.idempotencyComplete, in)
	return &jobs.JobRequest{JobID: in.JobID, IdempotencyKey: in.IdempotencyKey}, nil
}

func (f *fakeIngestLedger) CreateJob(ctx context.Context, in jobs.CreateJobInput) (*jobs.JobMeta, error) {
	f.jobsCreated = append(f.jobsCreated, in)
	if f.createJobErr != nil {
		return nil, f.createJobErr
	}
	return &jobs.JobMeta{JobID: in.JobID, TenantID: in.TenantID, Status: in.Status}, nil
}

type fakeSqsSender struct {
	messages []*sqs.SendMessageInput
}

func (f *fakeSqsSender) SendMessage(ctx context.Context, params *sqs.SendMessageInput, optFns ...func(*sqs.Options)) (*sqs.SendMessageOutput, error) {
	f.messages = append(f.messages, params)
	return &sqs.SendMessageOutput{}, nil
}

func TestHandle_Success(t *testing.T) {
	t.Setenv("TENANT_ID", "demo")
	t.Setenv("WORK_QUEUE_URL", "https://example.com/queue")

	ledger := &fakeIngestLedger{outcome: jobs.IdempotencyOutcomeCreated}
	sender := &fakeSqsSender{}

	prevLedger := newIngestLedger
	prevSender := newIngestSqsSender
	t.Cleanup(func() {
		newIngestLedger = prevLedger
		newIngestSqsSender = prevSender
	})
	newIngestLedger = func() (ingestLedger, error) { return ledger, nil }
	newIngestSqsSender = func(ctx context.Context) (sqsSender, error) { return sender, nil }

	detail, _ := json.Marshal(s3ObjectCreatedDetail{
		Bucket: struct {
			Name string `json:"name"`
		}{Name: "bucket"},
		Object: struct {
			Key string `json:"key"`
		}{Key: "incoming/file.csv"},
	})
	out, err := handle(context.Background(), events.CloudWatchEvent{Detail: detail})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}

	if ok, _ := out["ok"].(bool); !ok {
		t.Fatalf("expected ok=true, got %#v", out["ok"])
	}

	wantJobID := sha256Hex("bucket/incoming/file.csv")
	if out["job_id"] != wantJobID {
		t.Fatalf("expected job_id %q, got %#v", wantJobID, out["job_id"])
	}

	if len(ledger.jobsCreated) != 1 {
		t.Fatalf("expected 1 CreateJob call, got %d", len(ledger.jobsCreated))
	}

	if len(sender.messages) != 3 {
		t.Fatalf("expected 3 SQS messages, got %d", len(sender.messages))
	}

	for i, msg := range sender.messages {
		if aws.ToString(msg.QueueUrl) != "https://example.com/queue" {
			t.Fatalf("expected QueueUrl to match, got %q", aws.ToString(msg.QueueUrl))
		}

		var payload recordMessage
		if err := json.Unmarshal([]byte(aws.ToString(msg.MessageBody)), &payload); err != nil {
			t.Fatalf("invalid message json: %v", err)
		}
		if payload.JobID != wantJobID {
			t.Fatalf("expected payload job_id %q, got %q", wantJobID, payload.JobID)
		}
		wantRecordID := fmt.Sprintf("rec-%d", i+1)
		if payload.RecordID != wantRecordID {
			t.Fatalf("expected record_id %q, got %q", wantRecordID, payload.RecordID)
		}
	}

	if len(ledger.idempotencyComplete) != 1 {
		t.Fatalf("expected 1 CompleteIdempotencyRecord call, got %d", len(ledger.idempotencyComplete))
	}
}

func TestHandle_IdempotencyAlreadyCompletedShortCircuits(t *testing.T) {
	t.Setenv("WORK_QUEUE_URL", "https://example.com/queue")

	ledger := &fakeIngestLedger{outcome: jobs.IdempotencyOutcomeAlreadyCompleted}
	sender := &fakeSqsSender{}

	prevLedger := newIngestLedger
	prevSender := newIngestSqsSender
	t.Cleanup(func() {
		newIngestLedger = prevLedger
		newIngestSqsSender = prevSender
	})
	newIngestLedger = func() (ingestLedger, error) { return ledger, nil }
	newIngestSqsSender = func(ctx context.Context) (sqsSender, error) { return sender, nil }

	detail, _ := json.Marshal(s3ObjectCreatedDetail{
		Bucket: struct {
			Name string `json:"name"`
		}{Name: "bucket"},
		Object: struct {
			Key string `json:"key"`
		}{Key: "incoming/file.csv"},
	})
	out, err := handle(context.Background(), events.CloudWatchEvent{Detail: detail})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}

	if out["idempotency"] != string(jobs.IdempotencyOutcomeAlreadyCompleted) {
		t.Fatalf("expected idempotency=%q, got %#v", jobs.IdempotencyOutcomeAlreadyCompleted, out["idempotency"])
	}
	if len(ledger.jobsCreated) != 0 {
		t.Fatalf("expected CreateJob not called")
	}
	if len(sender.messages) != 0 {
		t.Fatalf("expected SQS SendMessage not called")
	}
	if len(ledger.idempotencyComplete) != 0 {
		t.Fatalf("expected CompleteIdempotencyRecord not called")
	}
}

func TestHandle_CreateJobConflictContinues(t *testing.T) {
	t.Setenv("TENANT_ID", "demo")
	t.Setenv("WORK_QUEUE_URL", "https://example.com/queue")

	ledger := &fakeIngestLedger{
		outcome:             jobs.IdempotencyOutcomeCreated,
		createJobErr:        jobs.NewError(jobs.ErrorTypeConflict, "job already exists"),
		idempotencyComplete: nil,
	}
	sender := &fakeSqsSender{}

	prevLedger := newIngestLedger
	prevSender := newIngestSqsSender
	t.Cleanup(func() {
		newIngestLedger = prevLedger
		newIngestSqsSender = prevSender
	})
	newIngestLedger = func() (ingestLedger, error) { return ledger, nil }
	newIngestSqsSender = func(ctx context.Context) (sqsSender, error) { return sender, nil }

	detail, _ := json.Marshal(s3ObjectCreatedDetail{
		Bucket: struct {
			Name string `json:"name"`
		}{Name: "bucket"},
		Object: struct {
			Key string `json:"key"`
		}{Key: "incoming/file.csv"},
	})
	if _, err := handle(context.Background(), events.CloudWatchEvent{Detail: detail}); err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}

	if len(sender.messages) != 3 {
		t.Fatalf("expected 3 SQS messages, got %d", len(sender.messages))
	}
	if len(ledger.idempotencyComplete) != 1 {
		t.Fatalf("expected CompleteIdempotencyRecord called once, got %d", len(ledger.idempotencyComplete))
	}
}

func TestHandle_MissingWorkQueueUrl(t *testing.T) {
	t.Setenv("WORK_QUEUE_URL", "")
	if _, err := handle(context.Background(), events.CloudWatchEvent{}); err == nil {
		t.Fatalf("expected error")
	}
}

func TestHandle_InvalidEventDetail(t *testing.T) {
	t.Setenv("WORK_QUEUE_URL", "https://example.com/queue")
	if _, err := handle(context.Background(), events.CloudWatchEvent{Detail: []byte("{")}); err == nil {
		t.Fatalf("expected error")
	}
}

func TestHandle_LedgerInitError(t *testing.T) {
	t.Setenv("WORK_QUEUE_URL", "https://example.com/queue")

	prevLedger := newIngestLedger
	t.Cleanup(func() { newIngestLedger = prevLedger })
	newIngestLedger = func() (ingestLedger, error) { return nil, fmt.Errorf("boom") }

	detail, _ := json.Marshal(s3ObjectCreatedDetail{
		Bucket: struct {
			Name string `json:"name"`
		}{Name: "bucket"},
		Object: struct {
			Key string `json:"key"`
		}{Key: "incoming/file.csv"},
	})

	if _, err := handle(context.Background(), events.CloudWatchEvent{Detail: detail}); err == nil {
		t.Fatalf("expected error")
	}
}

func TestHandle_SqsInitError(t *testing.T) {
	t.Setenv("WORK_QUEUE_URL", "https://example.com/queue")

	ledger := &fakeIngestLedger{outcome: jobs.IdempotencyOutcomeAlreadyCompleted}

	prevLedger := newIngestLedger
	prevSender := newIngestSqsSender
	t.Cleanup(func() {
		newIngestLedger = prevLedger
		newIngestSqsSender = prevSender
	})
	newIngestLedger = func() (ingestLedger, error) { return ledger, nil }
	newIngestSqsSender = func(ctx context.Context) (sqsSender, error) { return nil, fmt.Errorf("boom") }

	detail, _ := json.Marshal(s3ObjectCreatedDetail{
		Bucket: struct {
			Name string `json:"name"`
		}{Name: "bucket"},
		Object: struct {
			Key string `json:"key"`
		}{Key: "incoming/file.csv"},
	})

	if _, err := handle(context.Background(), events.CloudWatchEvent{Detail: detail}); err == nil {
		t.Fatalf("expected error")
	}
}

func TestHandle_IdempotencyCreateError(t *testing.T) {
	t.Setenv("WORK_QUEUE_URL", "https://example.com/queue")

	ledger := &fakeIngestLedger{
		outcome:              jobs.IdempotencyOutcomeCreated,
		createIdempotencyErr: fmt.Errorf("boom"),
	}
	sender := &fakeSqsSender{}

	prevLedger := newIngestLedger
	prevSender := newIngestSqsSender
	t.Cleanup(func() {
		newIngestLedger = prevLedger
		newIngestSqsSender = prevSender
	})
	newIngestLedger = func() (ingestLedger, error) { return ledger, nil }
	newIngestSqsSender = func(ctx context.Context) (sqsSender, error) { return sender, nil }

	detail, _ := json.Marshal(s3ObjectCreatedDetail{
		Bucket: struct {
			Name string `json:"name"`
		}{Name: "bucket"},
		Object: struct {
			Key string `json:"key"`
		}{Key: "incoming/file.csv"},
	})

	if _, err := handle(context.Background(), events.CloudWatchEvent{Detail: detail}); err == nil {
		t.Fatalf("expected error")
	}
}

type fakeSqsSenderError struct{}

func (f *fakeSqsSenderError) SendMessage(ctx context.Context, params *sqs.SendMessageInput, optFns ...func(*sqs.Options)) (*sqs.SendMessageOutput, error) {
	return nil, fmt.Errorf("boom")
}

func TestHandle_SendMessageError(t *testing.T) {
	t.Setenv("WORK_QUEUE_URL", "https://example.com/queue")

	ledger := &fakeIngestLedger{outcome: jobs.IdempotencyOutcomeCreated}
	sender := &fakeSqsSenderError{}

	prevLedger := newIngestLedger
	prevSender := newIngestSqsSender
	t.Cleanup(func() {
		newIngestLedger = prevLedger
		newIngestSqsSender = prevSender
	})
	newIngestLedger = func() (ingestLedger, error) { return ledger, nil }
	newIngestSqsSender = func(ctx context.Context) (sqsSender, error) { return sender, nil }

	detail, _ := json.Marshal(s3ObjectCreatedDetail{
		Bucket: struct {
			Name string `json:"name"`
		}{Name: "bucket"},
		Object: struct {
			Key string `json:"key"`
		}{Key: "incoming/file.csv"},
	})

	if _, err := handle(context.Background(), events.CloudWatchEvent{Detail: detail}); err == nil {
		t.Fatalf("expected error")
	}
}
