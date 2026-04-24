package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambdacontext"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

const dynamoDBEventNameRemove = "REMOVE"

func runFixtureM1(f Fixture) error {
	now := time.Unix(0, 0).UTC()
	effects := &fixtureM1Effects{}
	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP0),
		apptheory.WithClock(fixedClock{now: now}),
		apptheory.WithIDGenerator(fixedIDGenerator{id: "req_test_123"}),
		apptheory.WithObservability(apptheory.ObservabilityHooks{
			Log: func(r apptheory.LogRecord) {
				effects.logs = append(effects.logs, FixtureLogRecord{
					Level:         r.Level,
					Event:         r.Event,
					RequestID:     r.RequestID,
					TenantID:      r.TenantID,
					Method:        r.Method,
					Path:          r.Path,
					Status:        r.Status,
					ErrorCode:     r.ErrorCode,
					Trigger:       r.Trigger,
					CorrelationID: r.CorrelationID,
					Source:        r.Source,
					DetailType:    r.DetailType,
					TableName:     r.TableName,
					EventID:       r.EventID,
					EventName:     r.EventName,
				})
			},
			Metric: func(r apptheory.MetricRecord) {
				effects.metrics = append(effects.metrics, FixtureMetricRecord{
					Name:  r.Name,
					Value: r.Value,
					Tags:  r.Tags,
				})
			},
			Span: func(r apptheory.SpanRecord) {
				effects.spans = append(effects.spans, FixtureSpanRecord{
					Name:       r.Name,
					Attributes: r.Attributes,
				})
			},
		}),
	)

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

	ctx, cancel := fixtureM1LambdaContext(now, f.Input.Context)
	if cancel != nil {
		defer cancel()
	}

	out, err := app.HandleLambda(ctx, f.Input.AWSEvent.Event)
	return compareFixtureM1Result(f, out, err, effects)
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

type fixtureM1Effects struct {
	logs    []FixtureLogRecord
	metrics []FixtureMetricRecord
	spans   []FixtureSpanRecord
}

func compareFixtureM1Result(f Fixture, out any, runErr error, effectInputs ...*fixtureM1Effects) error {
	effects := &fixtureM1Effects{}
	if len(effectInputs) > 0 && effectInputs[0] != nil {
		effects = effectInputs[0]
	}

	if f.Expect.Error != nil {
		if len(f.Expect.Output) != 0 {
			return errors.New("fixture expect cannot set both error and output_json")
		}
		if runErr == nil {
			return errors.New("expected error, got nil")
		}
		expected := strings.TrimSpace(f.Expect.Error.Message)
		if expected != "" && strings.TrimSpace(runErr.Error()) != expected {
			return fmt.Errorf("error message mismatch: expected %q, got %q", expected, runErr.Error())
		}
		return compareFixtureM1SideEffectsIfExpected(f, effects)
	}
	if len(f.Expect.Output) == 0 {
		return errors.New("fixture missing expect.output_json or expect.error")
	}
	if runErr != nil {
		return runErr
	}
	if err := compareFixtureOutputJSON(f, out); err != nil {
		return err
	}
	return compareFixtureM1SideEffectsIfExpected(f, effects)
}

func compareFixtureM1SideEffectsIfExpected(f Fixture, effects *fixtureM1Effects) error {
	if f.Expect.Logs == nil && f.Expect.Metrics == nil && f.Expect.Spans == nil {
		return nil
	}
	if effects == nil {
		effects = &fixtureM1Effects{}
	}
	return compareFixtureSideEffects(f.Expect, effects.logs, effects.metrics, effects.spans)
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
	switch strings.TrimSpace(name) {
	case "ddb_requires_event_middleware":
		return func(ctx *apptheory.EventContext, _ events.DynamoDBEventRecord) error {
			return requireEventMiddleware(ctx)
		}
	case "ddb_require_normalized_summary":
		return func(_ *apptheory.EventContext, record events.DynamoDBEventRecord) error {
			return requireDynamoDBSafeSummary(record, false)
		}
	case "ddb_require_normalized_summary_fail_on_remove":
		return func(_ *apptheory.EventContext, record events.DynamoDBEventRecord) error {
			return requireDynamoDBSafeSummary(record, true)
		}
	case "ddb_observed_fail_on_remove":
		return func(_ *apptheory.EventContext, record events.DynamoDBEventRecord) error {
			if err := requireDynamoDBSafeSummary(record, false); err != nil {
				return err
			}
			if strings.TrimSpace(record.EventName) == dynamoDBEventNameRemove {
				return errors.New("raw dynamodb remove failure: do-not-log")
			}
			return nil
		}
	}

	handler := builtInRecordHandler[events.DynamoDBEventRecord](
		name,
		"ddb_noop",
		"ddb_always_fail",
		"ddb_fail_on_event_name_remove",
		func(record events.DynamoDBEventRecord) bool {
			return strings.TrimSpace(record.EventName) == dynamoDBEventNameRemove
		},
	)
	if handler == nil {
		return nil
	}
	return apptheory.DynamoDBStreamHandler(handler)
}

func requireDynamoDBSafeSummary(record events.DynamoDBEventRecord, failOnRemove bool) error {
	summary := dynamoDBSafeSummary(record)
	for _, key := range []string{"table_name", "event_id", "event_name", "sequence_number", "stream_view_type"} {
		if strings.TrimSpace(asString(summary[key])) == "" {
			return fmt.Errorf("missing normalized dynamodb %s", key)
		}
	}
	if rawLog := strings.TrimSpace(asString(summary["safe_log"])); rawLog == "" || containsAny(rawLog, []string{
		"release#rel_123",
		"do-not-log",
		"previous-secret",
	}) {
		return errors.New("unsafe dynamodb stream summary")
	}
	if failOnRemove && strings.TrimSpace(record.EventName) == dynamoDBEventNameRemove {
		return errors.New("fail")
	}
	return nil
}

func dynamoDBSafeSummary(record events.DynamoDBEventRecord) map[string]any {
	summary := apptheory.NormalizeDynamoDBStreamRecord(record)
	return map[string]any{
		"aws_region":       summary.AWSRegion,
		"event_id":         summary.EventID,
		"event_name":       summary.EventName,
		"safe_log":         summary.SafeLog,
		"sequence_number":  summary.SequenceNumber,
		"size_bytes":       int(summary.SizeBytes),
		"stream_view_type": summary.StreamViewType,
		"table_name":       summary.TableName,
	}
}

func builtInEventBridgeHandler(name string) apptheory.EventBridgeHandler {
	switch strings.TrimSpace(name) {
	case "eventbridge_workload_envelope":
		return func(ctx *apptheory.EventContext, event events.EventBridgeEvent) (any, error) {
			return apptheory.NormalizeEventBridgeWorkloadEnvelope(ctx, event), nil
		}
	case "eventbridge_scheduled_summary":
		return func(ctx *apptheory.EventContext, event events.EventBridgeEvent) (any, error) {
			return apptheory.NormalizeEventBridgeScheduledWorkload(ctx, event), nil
		}
	case "eventbridge_observed_success":
		return func(ctx *apptheory.EventContext, event events.EventBridgeEvent) (any, error) {
			return apptheory.NormalizeEventBridgeWorkloadEnvelope(ctx, event), nil
		}
	case "eventbridge_observed_panic":
		return func(_ *apptheory.EventContext, _ events.EventBridgeEvent) (any, error) {
			panic("raw eventbridge panic: do-not-log")
		}
	case "eventbridge_require_workload_envelope":
		return func(ctx *apptheory.EventContext, event events.EventBridgeEvent) (any, error) {
			return apptheory.RequireEventBridgeWorkloadEnvelope(ctx, event)
		}
	default:
		handler := builtInOutputHandler[events.EventBridgeEvent](name, "eventbridge")
		if handler == nil {
			return nil
		}
		return apptheory.EventBridgeHandler(handler)
	}
}

func fixtureM1LambdaContext(now time.Time, input FixtureContext) (context.Context, context.CancelFunc) {
	ctx := context.Background()
	var cancel context.CancelFunc
	if input.RemainingMS > 0 {
		ctx, cancel = context.WithDeadline(ctx, now.Add(time.Duration(input.RemainingMS)*time.Millisecond))
	}
	if requestID := strings.TrimSpace(input.AWSRequestID); requestID != "" {
		ctx = lambdacontext.NewContext(ctx, &lambdacontext.LambdaContext{AwsRequestID: requestID})
	}
	return ctx, cancel
}

func containsAny(value string, sentinels []string) bool {
	for _, sentinel := range sentinels {
		if sentinel != "" && strings.Contains(value, sentinel) {
			return true
		}
	}
	return false
}

func asString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
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
