package apptheory

import (
	"context"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

type SQSHandler func(*EventContext, events.SQSMessage) error

type sqsRoute struct {
	QueueName string
	Handler   SQSHandler
}

// SQS registers a handler for an SQS queue by queue name.
func (a *App) SQS(queueName string, handler SQSHandler) *App {
	if a == nil {
		return a
	}
	queueName = strings.TrimSpace(queueName)
	if queueName == "" || handler == nil {
		return a
	}
	a.sqsRoutes = append(a.sqsRoutes, sqsRoute{QueueName: queueName, Handler: handler})
	return a
}

func sqsQueueNameFromARN(arn string) string {
	arn = strings.TrimSpace(arn)
	if arn == "" {
		return ""
	}
	parts := strings.Split(arn, ":")
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

func (a *App) sqsHandlerForEvent(event events.SQSEvent) SQSHandler {
	if a == nil {
		return nil
	}
	for _, record := range event.Records {
		queueName := sqsQueueNameFromARN(record.EventSourceARN)
		if queueName == "" {
			continue
		}
		for _, route := range a.sqsRoutes {
			if route.QueueName == queueName {
				return route.Handler
			}
		}
		break
	}
	return nil
}

var sqsBatchSpec = newBatchEventSpec[events.SQSMessage, events.SQSBatchItemFailure, events.SQSEventResponse](
	"apptheory: invalid sqs record type",
	func(msg events.SQSMessage) string { return msg.MessageId },
)

// ServeSQS routes an SQS event to the registered queue handler and returns a partial batch failure response.
//
// If the queue is unrecognized, it fails closed by returning all messages as failures.
func (a *App) ServeSQS(ctx context.Context, event events.SQSEvent) events.SQSEventResponse {
	return serveBatchEvent(ctx, a, event.Records, a.sqsHandlerForEvent(event), sqsBatchSpec)
}
