package testkit

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory"
)

type SQSEventOptions struct {
	QueueARN string
	Records  []SQSMessageOptions
}

type SQSMessageOptions struct {
	MessageID         string
	Body              string
	EventSourceARN    string
	MessageAttributes map[string]events.SQSMessageAttribute
}

func SQSEvent(opts SQSEventOptions) events.SQSEvent {
	queueARN := strings.TrimSpace(opts.QueueARN)
	out := events.SQSEvent{Records: make([]events.SQSMessage, 0, len(opts.Records))}
	for _, rec := range opts.Records {
		id := strings.TrimSpace(rec.MessageID)
		if id == "" {
			id = fmt.Sprintf("msg-%d", len(out.Records)+1)
		}
		arn := strings.TrimSpace(rec.EventSourceARN)
		if arn == "" {
			arn = queueARN
		}
		out.Records = append(out.Records, events.SQSMessage{
			MessageId:         id,
			Body:              rec.Body,
			EventSource:       "aws:sqs",
			EventSourceARN:    arn,
			MessageAttributes: rec.MessageAttributes,
		})
	}
	return out
}

type EventBridgeEventOptions struct {
	ID         string
	Source     string
	DetailType string
	Resources  []string
	Detail     any
	Time       time.Time
	Region     string
	AccountID  string
}

func EventBridgeEvent(opts EventBridgeEventOptions) events.EventBridgeEvent {
	id := strings.TrimSpace(opts.ID)
	if id == "" {
		id = "evt-1"
	}
	source := strings.TrimSpace(opts.Source)
	if source == "" {
		source = "aws.events"
	}
	detailType := strings.TrimSpace(opts.DetailType)
	if detailType == "" {
		detailType = "Scheduled Event"
	}
	region := strings.TrimSpace(opts.Region)
	if region == "" {
		region = "us-east-1"
	}
	accountID := strings.TrimSpace(opts.AccountID)
	if accountID == "" {
		accountID = "000000000000"
	}
	eventTime := opts.Time
	if eventTime.IsZero() {
		eventTime = time.Unix(0, 0).UTC()
	}

	detail := json.RawMessage("null")
	if opts.Detail != nil {
		if b, err := json.Marshal(opts.Detail); err == nil {
			detail = b
		}
	}

	return events.EventBridgeEvent{
		Version:    "0",
		ID:         id,
		DetailType: detailType,
		Source:     source,
		AccountID:  accountID,
		Time:       eventTime,
		Region:     region,
		Resources:  append([]string(nil), opts.Resources...),
		Detail:     detail,
	}
}

type DynamoDBStreamEventOptions struct {
	StreamARN string
	Records   []DynamoDBStreamRecordOptions
}

type DynamoDBStreamRecordOptions struct {
	EventID   string
	EventName string
}

func DynamoDBStreamEvent(opts DynamoDBStreamEventOptions) events.DynamoDBEvent {
	streamARN := strings.TrimSpace(opts.StreamARN)
	out := events.DynamoDBEvent{Records: make([]events.DynamoDBEventRecord, 0, len(opts.Records))}
	for _, rec := range opts.Records {
		id := strings.TrimSpace(rec.EventID)
		if id == "" {
			id = fmt.Sprintf("ddb-%d", len(out.Records)+1)
		}
		name := strings.TrimSpace(rec.EventName)
		if name == "" {
			name = "MODIFY"
		}
		out.Records = append(out.Records, events.DynamoDBEventRecord{
			EventID:        id,
			EventName:      name,
			EventSource:    "aws:dynamodb",
			EventSourceArn: streamARN,
			EventVersion:   "1.1",
			AWSRegion:      "us-east-1",
		})
	}
	return out
}

func (e *Env) InvokeSQS(ctx context.Context, app *apptheory.App, event events.SQSEvent) events.SQSEventResponse {
	if ctx == nil {
		ctx = context.Background()
	}
	return app.ServeSQS(ctx, event)
}

func (e *Env) InvokeEventBridge(
	ctx context.Context,
	app *apptheory.App,
	event events.EventBridgeEvent,
) (any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	return app.ServeEventBridge(ctx, event)
}

func (e *Env) InvokeDynamoDBStream(
	ctx context.Context,
	app *apptheory.App,
	event events.DynamoDBEvent,
) events.DynamoDBEventResponse {
	if ctx == nil {
		ctx = context.Background()
	}
	return app.ServeDynamoDBStream(ctx, event)
}
