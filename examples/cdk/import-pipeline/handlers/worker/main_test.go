package main

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory/pkg/jobs"
)

type fakeWorkerLedger struct {
	idempotency []jobs.CreateIdempotencyRecordInput
	statuses    []jobs.UpsertRecordStatusInput
}

func (f *fakeWorkerLedger) CreateIdempotencyRecord(ctx context.Context, in jobs.CreateIdempotencyRecordInput) (*jobs.JobRequest, jobs.IdempotencyCreateOutcome, error) {
	f.idempotency = append(f.idempotency, in)
	return &jobs.JobRequest{JobID: in.JobID, IdempotencyKey: in.IdempotencyKey}, jobs.IdempotencyOutcomeCreated, nil
}

func (f *fakeWorkerLedger) UpsertRecordStatus(ctx context.Context, in jobs.UpsertRecordStatusInput) (*jobs.JobRecord, error) {
	f.statuses = append(f.statuses, in)
	return &jobs.JobRecord{JobID: in.JobID, RecordID: in.RecordID, Status: in.Status}, nil
}

func TestHandle_ProcessesRecords(t *testing.T) {
	ledger := &fakeWorkerLedger{}

	prev := newWorkerLedger
	t.Cleanup(func() { newWorkerLedger = prev })
	newWorkerLedger = func() (workerLedger, error) { return ledger, nil }

	makeMsg := func(jobID string, recordID string) events.SQSMessage {
		body, _ := json.Marshal(recordMessage{JobID: jobID, RecordID: recordID})
		return events.SQSMessage{Body: string(body)}
	}

	event := events.SQSEvent{
		Records: []events.SQSMessage{
			makeMsg("job-1", "rec-1"),
			makeMsg("job-1", "rec-3"),
			{Body: "not json"},
		},
	}

	if _, err := handle(context.Background(), event); err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}

	if len(ledger.idempotency) != 2 {
		t.Fatalf("expected 2 idempotency creates, got %d", len(ledger.idempotency))
	}
	if ledger.idempotency[0].IdempotencyKey != "record#rec-1" {
		t.Fatalf("expected record#rec-1, got %q", ledger.idempotency[0].IdempotencyKey)
	}
	if ledger.idempotency[1].IdempotencyKey != "record#rec-3" {
		t.Fatalf("expected record#rec-3, got %q", ledger.idempotency[1].IdempotencyKey)
	}

	if len(ledger.statuses) != 4 {
		t.Fatalf("expected 4 record status upserts, got %d", len(ledger.statuses))
	}

	if ledger.statuses[0].Status != jobs.RecordStatusProcessing || ledger.statuses[0].RecordID != "rec-1" {
		t.Fatalf("unexpected status[0]: %#v", ledger.statuses[0])
	}
	if ledger.statuses[1].Status != jobs.RecordStatusSucceeded || ledger.statuses[1].RecordID != "rec-1" {
		t.Fatalf("unexpected status[1]: %#v", ledger.statuses[1])
	}
	if ledger.statuses[2].Status != jobs.RecordStatusProcessing || ledger.statuses[2].RecordID != "rec-3" {
		t.Fatalf("unexpected status[2]: %#v", ledger.statuses[2])
	}
	if ledger.statuses[3].Status != jobs.RecordStatusFailed || ledger.statuses[3].RecordID != "rec-3" {
		t.Fatalf("unexpected status[3]: %#v", ledger.statuses[3])
	}
	if ledger.statuses[3].Error == nil {
		t.Fatalf("expected error envelope for failed record")
	}
}

func TestHandle_LedgerInitError(t *testing.T) {
	prev := newWorkerLedger
	t.Cleanup(func() { newWorkerLedger = prev })
	newWorkerLedger = func() (workerLedger, error) { return nil, fmt.Errorf("boom") }

	if _, err := handle(context.Background(), events.SQSEvent{}); err == nil {
		t.Fatalf("expected error")
	}
}
