package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/theory-cloud/apptheory/pkg/jobs"
	"github.com/theory-cloud/tabletheory"
)

type s3ObjectCreatedDetail struct {
	Bucket struct {
		Name string `json:"name"`
	} `json:"bucket"`
	Object struct {
		Key string `json:"key"`
	} `json:"object"`
}

type recordMessage struct {
	JobID    string `json:"job_id"`
	RecordID string `json:"record_id"`
}

type ingestLedger interface {
	CreateIdempotencyRecord(ctx context.Context, in jobs.CreateIdempotencyRecordInput) (*jobs.JobRequest, jobs.IdempotencyCreateOutcome, error)
	CompleteIdempotencyRecord(ctx context.Context, in jobs.CompleteIdempotencyRecordInput) (*jobs.JobRequest, error)
	CreateJob(ctx context.Context, in jobs.CreateJobInput) (*jobs.JobMeta, error)
}

type sqsSender interface {
	SendMessage(ctx context.Context, params *sqs.SendMessageInput, optFns ...func(*sqs.Options)) (*sqs.SendMessageOutput, error)
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

var newIngestLedger = func() (ingestLedger, error) {
	db, err := tabletheory.NewLambdaOptimized()
	if err != nil {
		return nil, fmt.Errorf("tabletheory init: %w", err)
	}
	return jobs.NewDynamoJobLedger(db, jobs.DefaultConfig()), nil
}

var newIngestSqsSender = func(ctx context.Context) (sqsSender, error) {
	awsCfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	return sqs.NewFromConfig(awsCfg), nil
}

func processIngest(
	ctx context.Context,
	tenantID string,
	workQueueURL string,
	bucketName string,
	objectKey string,
	ledger ingestLedger,
	sqsClient sqsSender,
) (map[string]any, error) {
	jobID := sha256Hex(bucketName + "/" + objectKey)

	_, outcome, err := ledger.CreateIdempotencyRecord(ctx, jobs.CreateIdempotencyRecordInput{
		JobID:          jobID,
		IdempotencyKey: "ingest",
	})
	if err != nil {
		return nil, err
	}
	if outcome != jobs.IdempotencyOutcomeCreated {
		return map[string]any{"ok": true, "job_id": jobID, "idempotency": string(outcome)}, nil
	}

	if _, err := ledger.CreateJob(ctx, jobs.CreateJobInput{
		JobID:    jobID,
		TenantID: tenantID,
		Status:   jobs.JobStatusRunning,
	}); err != nil {
		var typed *jobs.Error
		if !errors.As(err, &typed) || typed.Type != jobs.ErrorTypeConflict {
			return nil, err
		}
	}

	for i := 1; i <= 3; i++ {
		body, _ := json.Marshal(recordMessage{
			JobID:    jobID,
			RecordID: fmt.Sprintf("rec-%d", i),
		})
		if _, err := sqsClient.SendMessage(ctx, &sqs.SendMessageInput{
			QueueUrl:    aws.String(workQueueURL),
			MessageBody: aws.String(string(body)),
		}); err != nil {
			return nil, fmt.Errorf("send message: %w", err)
		}
	}

	_, err = ledger.CompleteIdempotencyRecord(ctx, jobs.CompleteIdempotencyRecordInput{
		JobID:          jobID,
		IdempotencyKey: "ingest",
		Result: map[string]any{
			"bucket":  bucketName,
			"key":     objectKey,
			"records": 3,
		},
	})
	if err != nil {
		return nil, err
	}

	return map[string]any{"ok": true, "job_id": jobID}, nil
}

func handle(ctx context.Context, event events.CloudWatchEvent) (map[string]any, error) {
	tenantID := strings.TrimSpace(os.Getenv("TENANT_ID"))
	if tenantID == "" {
		tenantID = "demo"
	}

	workQueueURL := strings.TrimSpace(os.Getenv("WORK_QUEUE_URL"))
	if workQueueURL == "" {
		return nil, fmt.Errorf("missing WORK_QUEUE_URL")
	}

	var detail s3ObjectCreatedDetail
	if err := json.Unmarshal(event.Detail, &detail); err != nil {
		return nil, fmt.Errorf("invalid detail: %w", err)
	}

	bucketName := strings.TrimSpace(detail.Bucket.Name)
	objectKey := strings.TrimSpace(detail.Object.Key)
	if bucketName == "" || objectKey == "" {
		return nil, fmt.Errorf("missing bucket/key in event detail")
	}

	ledger, err := newIngestLedger()
	if err != nil {
		return nil, err
	}
	sqsClient, err := newIngestSqsSender(ctx)
	if err != nil {
		return nil, err
	}

	return processIngest(ctx, tenantID, workQueueURL, bucketName, objectKey, ledger, sqsClient)
}

func main() {
	lambda.Start(handle)
}
