package apptheory

import (
	"context"
	"errors"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

type SNSHandler func(*EventContext, events.SNSEventRecord) (any, error)

type snsRoute struct {
	TopicName string
	Handler   SNSHandler
}

// SNS registers a handler for an SNS topic by topic name.
func (a *App) SNS(topicName string, handler SNSHandler) *App {
	if a == nil {
		return a
	}
	topicName = strings.TrimSpace(topicName)
	if topicName == "" || handler == nil {
		return a
	}
	a.snsRoutes = append(a.snsRoutes, snsRoute{TopicName: topicName, Handler: handler})
	return a
}

func snsTopicNameFromARN(arn string) string {
	arn = strings.TrimSpace(arn)
	if arn == "" {
		return ""
	}
	parts := strings.Split(arn, ":")
	if len(parts) == 0 {
		return ""
	}
	return strings.TrimSpace(parts[len(parts)-1])
}

func (a *App) snsHandlerForEvent(event events.SNSEvent) SNSHandler {
	if a == nil {
		return nil
	}
	for _, record := range event.Records {
		topicName := snsTopicNameFromARN(record.SNS.TopicArn)
		if topicName == "" {
			continue
		}
		for _, route := range a.snsRoutes {
			if route.TopicName == topicName {
				return route.Handler
			}
		}
		break
	}
	return nil
}

// ServeSNS routes an SNS event to the registered topic handler.
//
// If the topic is unrecognized, it fails closed by returning an error.
//
// The returned output value is ignored by AWS for SNS triggers, but is useful for tests and local invocation tooling.
func (a *App) ServeSNS(ctx context.Context, event events.SNSEvent) ([]any, error) {
	handler := a.snsHandlerForEvent(event)
	if handler == nil {
		return nil, errors.New("apptheory: unrecognized sns topic")
	}

	handler = wrapEventRecordHandlerWithOutput(
		a,
		handler,
		func(event any) (events.SNSEventRecord, bool) {
			record, ok := event.(events.SNSEventRecord)
			return record, ok
		},
		"apptheory: invalid sns record type",
	)

	evtCtx := a.eventContext(ctx)
	outputs := make([]any, 0, len(event.Records))
	for _, record := range event.Records {
		out, err := handler(evtCtx, record)
		if err != nil {
			return nil, err
		}
		outputs = append(outputs, out)
	}
	return outputs, nil
}
