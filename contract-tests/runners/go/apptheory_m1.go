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
		handler := builtInDynamoDBStreamHandler(r.Handler, effects)
		if handler == nil {
			return fmt.Errorf("unknown dynamodb handler %q", r.Handler)
		}
		app.DynamoDB(table, handler)
	}

	for _, r := range f.Setup.EventBridge {
		handler := builtInEventBridgeHandler(r.Handler, f.Input.AWSEvent.Event, effects)
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

func builtInDynamoDBStreamHandler(name string, effectsInput ...*fixtureM1Effects) apptheory.DynamoDBStreamHandler {
	effects := firstM1Effects(effectsInput...)
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
		return func(ctx *apptheory.EventContext, record events.DynamoDBEventRecord) error {
			if err := requireDynamoDBSafeSummary(record, false); err != nil {
				return err
			}
			if strings.TrimSpace(record.EventName) == dynamoDBEventNameRemove {
				recordDynamoDBEffects(effects, ctx, record, "error", "error", "app.internal")
				return errors.New("fail")
			}
			recordDynamoDBEffects(effects, ctx, record, "info", "success", "")
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

func builtInEventBridgeHandler(name string, rawInput ...any) apptheory.EventBridgeHandler {
	var raw json.RawMessage
	effects := &fixtureM1Effects{}
	if len(rawInput) > 0 {
		if value, ok := rawInput[0].(json.RawMessage); ok {
			raw = value
		}
	}
	if len(rawInput) > 1 {
		if value, ok := rawInput[1].(*fixtureM1Effects); ok && value != nil {
			effects = value
		}
	}
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
			summary := eventBridgeWorkloadEnvelopeSummary(ctx, event, raw)
			recordEventBridgeEffects(effects, ctx, summary, "info", "success", "")
			return summary, nil
		}
	case "eventbridge_observed_panic":
		return func(ctx *apptheory.EventContext, event events.EventBridgeEvent) (any, error) {
			summary := eventBridgeWorkloadEnvelopeSummary(ctx, event, raw)
			recordEventBridgeEffects(effects, ctx, summary, "error", "error", "app.internal")
			return nil, errors.New("apptheory: event workload failed")
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

func firstM1Effects(inputs ...*fixtureM1Effects) *fixtureM1Effects {
	if len(inputs) > 0 && inputs[0] != nil {
		return inputs[0]
	}
	return &fixtureM1Effects{}
}

func recordEventBridgeEffects(
	effects *fixtureM1Effects,
	ctx *apptheory.EventContext,
	summary map[string]any,
	level string,
	outcome string,
	errorCode string,
) {
	if effects == nil {
		return
	}
	correlationID := asString(summary["correlation_id"])
	source := asString(summary["source"])
	detailType := asString(summary["detail_type"])
	effects.logs = append(effects.logs, FixtureLogRecord{
		Level:         level,
		Event:         "event.completed",
		RequestID:     ctxRequestID(ctx),
		ErrorCode:     errorCode,
		Trigger:       "eventbridge",
		CorrelationID: correlationID,
		Source:        source,
		DetailType:    detailType,
	})
	effects.metrics = append(effects.metrics, FixtureMetricRecord{
		Name:  "apptheory.event",
		Value: 1,
		Tags: map[string]string{
			"correlation_id": correlationID,
			"detail_type":    detailType,
			"error_code":     errorCode,
			"outcome":        outcome,
			"source":         source,
			"trigger":        "eventbridge",
		},
	})
	effects.spans = append(effects.spans, FixtureSpanRecord{
		Name: "eventbridge " + source + " " + detailType,
		Attributes: map[string]string{
			"correlation.id":    correlationID,
			"event.detail_type": detailType,
			"event.source":      source,
			"error.code":        errorCode,
			"outcome":           outcome,
			"trigger":           "eventbridge",
		},
	})
}

func recordDynamoDBEffects(
	effects *fixtureM1Effects,
	ctx *apptheory.EventContext,
	record events.DynamoDBEventRecord,
	level string,
	outcome string,
	errorCode string,
) {
	if effects == nil {
		return
	}
	summary := dynamoDBSafeSummary(record)
	tableName := asString(summary["table_name"])
	eventID := asString(summary["event_id"])
	eventName := asString(summary["event_name"])
	effects.logs = append(effects.logs, FixtureLogRecord{
		Level:         level,
		Event:         "event.completed",
		RequestID:     ctxRequestID(ctx),
		ErrorCode:     errorCode,
		Trigger:       "dynamodb_stream",
		CorrelationID: eventID,
		TableName:     tableName,
		EventID:       eventID,
		EventName:     eventName,
	})
	effects.metrics = append(effects.metrics, FixtureMetricRecord{
		Name:  "apptheory.event",
		Value: 1,
		Tags: map[string]string{
			"correlation_id": eventID,
			"error_code":     errorCode,
			"event_name":     eventName,
			"outcome":        outcome,
			"table_name":     tableName,
			"trigger":        "dynamodb_stream",
		},
	})
	effects.spans = append(effects.spans, FixtureSpanRecord{
		Name: "dynamodb_stream " + tableName + " " + eventName,
		Attributes: map[string]string{
			"correlation.id":      eventID,
			"dynamodb.event_id":   eventID,
			"dynamodb.event_name": eventName,
			"dynamodb.table_name": tableName,
			"error.code":          errorCode,
			"outcome":             outcome,
			"trigger":             "dynamodb_stream",
		},
	})
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

func eventBridgeWorkloadEnvelopeSummary(
	ctx *apptheory.EventContext,
	event events.EventBridgeEvent,
	raw json.RawMessage,
) map[string]any {
	rawObject := rawJSONObject(raw)
	correlationID, correlationSource := eventBridgeCorrelationID(ctx, event, rawObject)

	return map[string]any{
		"account":            event.AccountID,
		"correlation_id":     correlationID,
		"correlation_source": correlationSource,
		"detail_type":        event.DetailType,
		"event_id":           event.ID,
		"region":             event.Region,
		"request_id":         ctxRequestID(ctx),
		"resources":          event.Resources,
		"source":             event.Source,
		"time":               rawString(rawObject, "time"),
	}
}

func eventBridgeCorrelationID(
	ctx *apptheory.EventContext,
	event events.EventBridgeEvent,
	raw map[string]any,
) (string, string) {
	if value := rawString(rawObjectField(raw, "metadata"), "correlation_id"); value != "" {
		return value, "metadata.correlation_id"
	}
	if value := rawHeaderString(rawObjectField(raw, "headers"), "x-correlation-id"); value != "" {
		return value, "headers.x-correlation-id"
	}
	if value := rawString(rawObjectField(raw, "detail"), "correlation_id"); value != "" {
		return value, "detail.correlation_id"
	}
	if value := strings.TrimSpace(event.ID); value != "" {
		return value, "event.id"
	}
	if value := ctxLambdaAWSRequestID(ctx); value != "" {
		return value, "lambda.aws_request_id"
	}
	return "", ""
}

func rawJSONObject(raw json.RawMessage) map[string]any {
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return map[string]any{}
	}
	return object
}

func rawObjectField(object map[string]any, key string) map[string]any {
	if object == nil {
		return map[string]any{}
	}
	value, ok := object[key]
	if !ok {
		return map[string]any{}
	}
	child, ok := value.(map[string]any)
	if !ok || child == nil {
		return map[string]any{}
	}
	return child
}

func rawString(object map[string]any, key string) string {
	if object == nil {
		return ""
	}
	value, ok := object[key]
	if !ok {
		return ""
	}
	return asString(value)
}

func rawHeaderString(headers map[string]any, key string) string {
	key = strings.TrimSpace(strings.ToLower(key))
	if key == "" || headers == nil {
		return ""
	}
	for name, value := range headers {
		if strings.TrimSpace(strings.ToLower(name)) != key {
			continue
		}
		if single := asString(value); single != "" {
			return single
		}
		if values, ok := value.([]any); ok {
			for _, entry := range values {
				if single := asString(entry); single != "" {
					return single
				}
			}
		}
	}
	return ""
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

func ctxRequestID(ctx *apptheory.EventContext) string {
	if ctx == nil {
		return ""
	}
	return strings.TrimSpace(ctx.RequestID)
}

func ctxLambdaAWSRequestID(ctx *apptheory.EventContext) string {
	if ctx == nil {
		return ""
	}
	lambdaCtx, ok := lambdacontext.FromContext(ctx.Context())
	if !ok || lambdaCtx == nil {
		return ""
	}
	return strings.TrimSpace(lambdaCtx.AwsRequestID)
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
