package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
)

const streamNameEnv = "APPTHEORY_KINESIS_STREAM_NAME"

type cloudWatchLogsProcessor func(context.Context, apptheory.CloudWatchLogsSubscription) error

func buildApp(logger *log.Logger, processor cloudWatchLogsProcessor) *apptheory.App {
	if logger == nil {
		logger = log.Default()
	}
	if processor == nil {
		processor = processCloudWatchLogsSubscription
	}

	streamName := strings.TrimSpace(os.Getenv(streamNameEnv))
	app := apptheory.New()
	app.Kinesis(streamName, func(ctx *apptheory.EventContext, record events.KinesisEventRecord) error {
		decoded, err := apptheory.DecodeCloudWatchLogsSubscription(record)
		if err != nil {
			return err
		}

		if err := processor(ctx.Context(), decoded); err != nil {
			return err
		}

		// SafeSummary intentionally excludes raw CloudWatch log messages.
		logger.Printf("processed cloudwatch logs subscription %s", decoded.SafeSummary.SafeLog)
		return nil
	})
	return app
}

func processCloudWatchLogsSubscription(ctx context.Context, decoded apptheory.CloudWatchLogsSubscription) error {
	for _, event := range decoded.LogEvents {
		if err := processCloudWatchLogEvent(ctx, decoded, event); err != nil {
			return err
		}
	}
	return nil
}

func processCloudWatchLogEvent(
	_ context.Context,
	_ apptheory.CloudWatchLogsSubscription,
	event apptheory.CloudWatchLogsSubscriptionLogEvent,
) error {
	// Application-specific work belongs here. Keep raw customer log messages in
	// local scope; use IDs/counts/sizes for logs, metrics, and traces.
	_ = struct {
		ID          string
		Timestamp   int64
		MessageSize int
	}{
		ID:          event.ID,
		Timestamp:   event.Timestamp,
		MessageSize: len(event.Message),
	}
	return nil
}

func main() {
	app := buildApp(log.Default(), nil)
	lambda.Start(func(ctx context.Context, event json.RawMessage) (any, error) {
		return app.HandleLambda(ctx, event)
	})
}
