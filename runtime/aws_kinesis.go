package apptheory

import (
	"context"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

type KinesisHandler func(*EventContext, events.KinesisEventRecord) error

type kinesisRoute struct {
	StreamName string
	Handler    KinesisHandler
}

// Kinesis registers a handler for a Kinesis stream by stream name.
func (a *App) Kinesis(streamName string, handler KinesisHandler) *App {
	if a == nil {
		return a
	}
	streamName = strings.TrimSpace(streamName)
	if streamName == "" || handler == nil {
		return a
	}
	a.kinesisRoutes = append(a.kinesisRoutes, kinesisRoute{StreamName: streamName, Handler: handler})
	return a
}

func kinesisStreamNameFromARN(arn string) string {
	arn = strings.TrimSpace(arn)
	if arn == "" {
		return ""
	}
	parts := strings.Split(arn, ":")
	if len(parts) == 0 {
		return ""
	}
	last := parts[len(parts)-1]
	_, name, ok := strings.Cut(last, "/")
	if ok {
		return strings.TrimSpace(name)
	}
	return strings.TrimSpace(last)
}

func (a *App) kinesisHandlerForEvent(event events.KinesisEvent) KinesisHandler {
	if a == nil {
		return nil
	}
	for _, record := range event.Records {
		streamName := kinesisStreamNameFromARN(record.EventSourceArn)
		if streamName == "" {
			continue
		}
		for _, route := range a.kinesisRoutes {
			if route.StreamName == streamName {
				return route.Handler
			}
		}
		break
	}
	return nil
}

var kinesisBatchSpec = newBatchEventSpec[events.KinesisEventRecord, events.KinesisBatchItemFailure, events.KinesisEventResponse](
	"apptheory: invalid kinesis record type",
	func(record events.KinesisEventRecord) string { return record.Kinesis.SequenceNumber },
)

// ServeKinesis routes a Kinesis event to the registered stream handler and returns a partial batch failure response.
//
// If the stream is unrecognized, it fails closed by returning all records as failures.
func (a *App) ServeKinesis(ctx context.Context, event events.KinesisEvent) events.KinesisEventResponse {
	return serveBatchEvent(ctx, a, event.Records, a.kinesisHandlerForEvent(event), kinesisBatchSpec)
}
