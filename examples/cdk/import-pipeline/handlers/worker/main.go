package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"

	"github.com/theory-cloud/apptheory/pkg/jobs"
	"github.com/theory-cloud/tabletheory"
)

type recordMessage struct {
	JobID    string `json:"job_id"`
	RecordID string `json:"record_id"`
}

type workerLedger interface {
	CreateIdempotencyRecord(ctx context.Context, in jobs.CreateIdempotencyRecordInput) (*jobs.JobRequest, jobs.IdempotencyCreateOutcome, error)
	UpsertRecordStatus(ctx context.Context, in jobs.UpsertRecordStatusInput) (*jobs.JobRecord, error)
}

var newWorkerLedger = func() (workerLedger, error) {
	db, err := tabletheory.NewLambdaOptimized()
	if err != nil {
		return nil, fmt.Errorf("tabletheory init: %w", err)
	}
	return jobs.NewDynamoJobLedger(db, jobs.DefaultConfig()), nil
}

func handle(ctx context.Context, event events.SQSEvent) (events.SQSEventResponse, error) {
	ledger, err := newWorkerLedger()
	if err != nil {
		return events.SQSEventResponse{}, err
	}

	for _, msg := range event.Records {
		var payload recordMessage
		if err := json.Unmarshal([]byte(msg.Body), &payload); err != nil {
			continue
		}
		jobID := strings.TrimSpace(payload.JobID)
		recordID := strings.TrimSpace(payload.RecordID)
		if jobID == "" || recordID == "" {
			continue
		}

		_, _, _ = ledger.CreateIdempotencyRecord(ctx, jobs.CreateIdempotencyRecordInput{
			JobID:          jobID,
			IdempotencyKey: "record#" + recordID,
		})

		_, _ = ledger.UpsertRecordStatus(ctx, jobs.UpsertRecordStatusInput{
			JobID:    jobID,
			RecordID: recordID,
			Status:   jobs.RecordStatusProcessing,
		})

		if strings.HasSuffix(recordID, "3") {
			env := jobs.NewErrorEnvelope("bad\nnews", map[string]any{"pan_value": "4111111111111111"})
			_, _ = ledger.UpsertRecordStatus(ctx, jobs.UpsertRecordStatusInput{
				JobID:    jobID,
				RecordID: recordID,
				Status:   jobs.RecordStatusFailed,
				Error:    env,
			})
			continue
		}

		_, _ = ledger.UpsertRecordStatus(ctx, jobs.UpsertRecordStatusInput{
			JobID:    jobID,
			RecordID: recordID,
			Status:   jobs.RecordStatusSucceeded,
		})
	}

	return events.SQSEventResponse{}, nil
}

func main() {
	lambda.Start(handle)
}
