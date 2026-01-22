package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func runFixtureM1(f Fixture) error {
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))

	for _, name := range f.Setup.Middlewares {
		mw := builtInM1EventMiddleware(name)
		if mw == nil {
			return fmt.Errorf("unknown event middleware %q", name)
		}
		app.UseEvents(mw)
	}

	for _, r := range f.Setup.SQS {
		queue := strings.TrimSpace(r.Queue)
		handler := builtInSQSHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown sqs handler %q", r.Handler)
		}
		app.SQS(queue, handler)
	}

	for _, r := range f.Setup.Kinesis {
		stream := strings.TrimSpace(r.Stream)
		handler := builtInKinesisHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown kinesis handler %q", r.Handler)
		}
		app.Kinesis(stream, handler)
	}

	for _, r := range f.Setup.SNS {
		topic := strings.TrimSpace(r.Topic)
		handler := builtInSNSHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown sns handler %q", r.Handler)
		}
		app.SNS(topic, handler)
	}

	for _, r := range f.Setup.DynamoDB {
		table := strings.TrimSpace(r.Table)
		handler := builtInDynamoDBStreamHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown dynamodb handler %q", r.Handler)
		}
		app.DynamoDB(table, handler)
	}

	for _, r := range f.Setup.EventBridge {
		handler := builtInEventBridgeHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown eventbridge handler %q", r.Handler)
		}
		selector := apptheory.EventBridgeSelector{
			RuleName:   strings.TrimSpace(r.RuleName),
			Source:     strings.TrimSpace(r.Source),
			DetailType: strings.TrimSpace(r.DetailType),
		}
		app.EventBridge(selector, handler)
	}

	if f.Input.AWSEvent == nil {
		return errors.New("fixture missing input.aws_event")
	}

	out, err := app.HandleLambda(context.Background(), f.Input.AWSEvent.Event)
	if err != nil {
		return err
	}
	return compareFixtureOutputJSON(f, out)
}

func builtInM1EventMiddleware(name string) apptheory.EventMiddleware {
	switch strings.TrimSpace(name) {
	case "evt_mw_a":
		return func(next apptheory.EventHandler) apptheory.EventHandler {
			return func(ctx *apptheory.EventContext, event any) (any, error) {
				ctx.Set("mw", "ok")
				ctx.Set("trace", []string{"evt_mw_a"})
				return next(ctx, event)
			}
		}
	case "evt_mw_b":
		return func(next apptheory.EventHandler) apptheory.EventHandler {
			return func(ctx *apptheory.EventContext, event any) (any, error) {
				var trace []string
				if existing := ctx.Get("trace"); existing != nil {
					if values, ok := existing.([]string); ok {
						trace = append([]string(nil), values...)
					}
				}
				trace = append(trace, "evt_mw_b")
				ctx.Set("trace", trace)
				return next(ctx, event)
			}
		}
	default:
		return nil
	}
}

func compareFixtureOutputJSON(f Fixture, out any) error {
	if len(f.Expect.Output) == 0 {
		return errors.New("fixture missing expect.output_json")
	}

	var expected any
	if err := json.Unmarshal(f.Expect.Output, &expected); err != nil {
		return fmt.Errorf("parse expected output_json: %w", err)
	}

	actualJSON, err := json.Marshal(out)
	if err != nil {
		return fmt.Errorf("marshal actual output: %w", err)
	}

	var actual any
	if err := json.Unmarshal(actualJSON, &actual); err != nil {
		return fmt.Errorf("parse actual output as json: %w", err)
	}

	if !jsonEqual(expected, actual) {
		return fmt.Errorf("output_json mismatch")
	}
	return nil
}

func builtInRecordHandler[T any](
	name string,
	noopName string,
	alwaysFailName string,
	conditionalFailName string,
	shouldFail func(T) bool,
) func(*apptheory.EventContext, T) error {
	switch strings.TrimSpace(name) {
	case noopName:
		return func(_ *apptheory.EventContext, _ T) error {
			return nil
		}
	case alwaysFailName:
		return func(_ *apptheory.EventContext, _ T) error {
			return errors.New("fail")
		}
	case conditionalFailName:
		return func(_ *apptheory.EventContext, record T) error {
			if shouldFail(record) {
				return errors.New("fail")
			}
			return nil
		}
	default:
		return nil
	}
}

func requireEventMiddleware(ctx *apptheory.EventContext) error {
	if ctx.Get("mw") != "ok" {
		return errors.New("missing middleware value")
	}
	existing := ctx.Get("trace")
	trace, ok := existing.([]string)
	if !ok || strings.Join(trace, ",") != "evt_mw_a,evt_mw_b" {
		return errors.New("bad trace")
	}
	return nil
}

func builtInSQSHandler(name string) apptheory.SQSHandler {
	if strings.TrimSpace(name) == "sqs_requires_event_middleware" {
		return func(ctx *apptheory.EventContext, _ events.SQSMessage) error {
			return requireEventMiddleware(ctx)
		}
	}

	handler := builtInRecordHandler[events.SQSMessage](
		name,
		"sqs_noop",
		"sqs_always_fail",
		"sqs_fail_on_body",
		func(msg events.SQSMessage) bool { return strings.TrimSpace(msg.Body) == "fail" },
	)
	if handler == nil {
		return nil
	}
	return apptheory.SQSHandler(handler)
}

func builtInKinesisHandler(name string) apptheory.KinesisHandler {
	if strings.TrimSpace(name) == "kinesis_requires_event_middleware" {
		return func(ctx *apptheory.EventContext, _ events.KinesisEventRecord) error {
			return requireEventMiddleware(ctx)
		}
	}

	handler := builtInRecordHandler[events.KinesisEventRecord](
		name,
		"kinesis_noop",
		"kinesis_always_fail",
		"kinesis_fail_on_data",
		func(record events.KinesisEventRecord) bool {
			return strings.TrimSpace(string(record.Kinesis.Data)) == "fail"
		},
	)
	if handler == nil {
		return nil
	}
	return apptheory.KinesisHandler(handler)
}

func builtInSNSHandler(name string) apptheory.SNSHandler {
	handler := builtInOutputHandler[events.SNSEventRecord](name, "sns")
	if handler == nil {
		return nil
	}
	return apptheory.SNSHandler(handler)
}

func builtInDynamoDBStreamHandler(name string) apptheory.DynamoDBStreamHandler {
	if strings.TrimSpace(name) == "ddb_requires_event_middleware" {
		return func(ctx *apptheory.EventContext, _ events.DynamoDBEventRecord) error {
			return requireEventMiddleware(ctx)
		}
	}

	handler := builtInRecordHandler[events.DynamoDBEventRecord](
		name,
		"ddb_noop",
		"ddb_always_fail",
		"ddb_fail_on_event_name_remove",
		func(record events.DynamoDBEventRecord) bool { return strings.TrimSpace(record.EventName) == "REMOVE" },
	)
	if handler == nil {
		return nil
	}
	return apptheory.DynamoDBStreamHandler(handler)
}

func builtInEventBridgeHandler(name string) apptheory.EventBridgeHandler {
	handler := builtInOutputHandler[events.EventBridgeEvent](name, "eventbridge")
	if handler == nil {
		return nil
	}
	return apptheory.EventBridgeHandler(handler)
}

func builtInOutputHandler[Event any](name string, prefix string) func(*apptheory.EventContext, Event) (any, error) {
	switch strings.TrimSpace(name) {
	case prefix + "_static_a":
		return func(_ *apptheory.EventContext, _ Event) (any, error) {
			return map[string]any{"handler": "a"}, nil
		}
	case prefix + "_static_b":
		return func(_ *apptheory.EventContext, _ Event) (any, error) {
			return map[string]any{"handler": "b"}, nil
		}
	case prefix + "_echo_event_middleware":
		return func(ctx *apptheory.EventContext, _ Event) (any, error) {
			return map[string]any{
				"mw":    ctx.Get("mw"),
				"trace": ctx.Get("trace"),
			}, nil
		}
	default:
		return nil
	}
}
