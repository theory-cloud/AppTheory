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

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
)

const dynamoDBEventNameRemove = "REMOVE"
const cloudWatchLogsSubscriptionHandlerName = "kinesis_require_cloudwatch_logs_subscription"
const cloudWatchLogsSubscriptionMissingHelperMessage = "apptheory: cloudwatch logs subscription decoder helper missing"

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

	if err := registerFixtureM1EventMiddlewares(app, f); err != nil {
		return err
	}

	if f.Input.AWSEvent == nil {
		return errors.New("fixture missing input.aws_event")
	}

	cloudWatchLogsExpectations, err := newCloudWatchLogsSubscriptionExpectations(f)
	if err != nil {
		return err
	}

	if routeErr := registerFixtureM1EventRoutes(app, f, cloudWatchLogsExpectations); routeErr != nil {
		return routeErr
	}

	ctx, cancel := fixtureM1LambdaContext(now, f.Input.Context)
	if cancel != nil {
		defer cancel()
	}

	out, err := app.HandleLambda(ctx, f.Input.AWSEvent.Event)
	return compareFixtureM1Result(f, out, err, effects)
}

func registerFixtureM1EventMiddlewares(app *apptheory.App, f Fixture) error {
	for _, name := range f.Setup.Middlewares {
		mw := builtInM1EventMiddleware(name)
		if mw == nil {
			return fmt.Errorf("unknown event middleware %q", name)
		}
		app.UseEvents(mw)
	}
	return nil
}

func registerFixtureM1EventRoutes(
	app *apptheory.App,
	f Fixture,
	cloudWatchLogsExpectations *cloudWatchLogsSubscriptionExpectations,
) error {
	if err := registerFixtureM1SQSRoutes(app, f); err != nil {
		return err
	}
	if err := registerFixtureM1KinesisRoutes(app, f, cloudWatchLogsExpectations); err != nil {
		return err
	}
	if err := registerFixtureM1SNSRoutes(app, f); err != nil {
		return err
	}
	if err := registerFixtureM1DynamoDBRoutes(app, f); err != nil {
		return err
	}
	return registerFixtureM1EventBridgeRoutes(app, f)
}

func registerFixtureM1SQSRoutes(app *apptheory.App, f Fixture) error {
	for _, r := range f.Setup.SQS {
		queue := strings.TrimSpace(r.Queue)
		handler := builtInSQSHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown sqs handler %q", r.Handler)
		}
		app.SQS(queue, handler)
	}
	return nil
}

func registerFixtureM1KinesisRoutes(
	app *apptheory.App,
	f Fixture,
	cloudWatchLogsExpectations *cloudWatchLogsSubscriptionExpectations,
) error {
	for _, r := range f.Setup.Kinesis {
		stream := strings.TrimSpace(r.Stream)
		handler := builtInKinesisHandler(r.Handler, cloudWatchLogsExpectations)
		if handler == nil {
			return fmt.Errorf("unknown kinesis handler %q", r.Handler)
		}
		app.Kinesis(stream, handler)
	}
	return nil
}

func registerFixtureM1SNSRoutes(app *apptheory.App, f Fixture) error {
	for _, r := range f.Setup.SNS {
		topic := strings.TrimSpace(r.Topic)
		handler := builtInSNSHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown sns handler %q", r.Handler)
		}
		app.SNS(topic, handler)
	}
	return nil
}

func registerFixtureM1DynamoDBRoutes(app *apptheory.App, f Fixture) error {
	for _, r := range f.Setup.DynamoDB {
		table := strings.TrimSpace(r.Table)
		handler := builtInDynamoDBStreamHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown dynamodb handler %q", r.Handler)
		}
		app.DynamoDB(table, handler)
	}
	return nil
}

func registerFixtureM1EventBridgeRoutes(app *apptheory.App, f Fixture) error {
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
	return nil
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

func builtInKinesisHandler(name string, cloudWatchLogsExpectations *cloudWatchLogsSubscriptionExpectations) apptheory.KinesisHandler {
	switch strings.TrimSpace(name) {
	case "kinesis_requires_event_middleware":
		return func(ctx *apptheory.EventContext, _ events.KinesisEventRecord) error {
			return requireEventMiddleware(ctx)
		}
	case cloudWatchLogsSubscriptionHandlerName:
		return newCloudWatchLogsSubscriptionHandler(cloudWatchLogsExpectations, decodeCloudWatchLogsSubscriptionRecord)
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

type cloudWatchLogsSubscriptionExpectations struct {
	byRecordID map[string]FixtureCloudWatchLogsSubscriptionRecord
}

type cloudWatchLogsSubscriptionDecoder func(events.KinesisEventRecord) (FixtureCloudWatchLogsSubscriptionRecord, error)

func newCloudWatchLogsSubscriptionExpectations(f Fixture) (*cloudWatchLogsSubscriptionExpectations, error) {
	usesHandler := fixtureUsesCloudWatchLogsSubscriptionHandler(f)
	if err := validateCloudWatchLogsSubscriptionExpectationShape(f, usesHandler); err != nil {
		return nil, err
	}
	if f.Expect.CloudWatchLogsSubscription == nil {
		return nil, nil
	}
	if f.Input.AWSEvent == nil {
		return nil, errors.New("fixture missing input.aws_event")
	}

	inputRecordIDs, err := kinesisInputRecordIDs(f.Input.AWSEvent.Event)
	if err != nil {
		return nil, err
	}

	expectedByID, err := cloudWatchLogsSubscriptionExpectationsByRecordID(f.Expect.CloudWatchLogsSubscription.Records)
	if err != nil {
		return nil, err
	}
	if err := validateCloudWatchLogsSubscriptionInputRecordIDs(inputRecordIDs, expectedByID); err != nil {
		return nil, err
	}

	return &cloudWatchLogsSubscriptionExpectations{byRecordID: expectedByID}, nil
}

func fixtureUsesCloudWatchLogsSubscriptionHandler(f Fixture) bool {
	for _, route := range f.Setup.Kinesis {
		if strings.TrimSpace(route.Handler) == cloudWatchLogsSubscriptionHandlerName {
			return true
		}
	}
	return false
}

func validateCloudWatchLogsSubscriptionExpectationShape(f Fixture, usesHandler bool) error {
	if f.Expect.CloudWatchLogsSubscription == nil {
		if usesHandler {
			return errors.New("fixture missing expect.cloudwatch_logs_subscription")
		}
		return nil
	}
	if !usesHandler {
		return errors.New("expect.cloudwatch_logs_subscription requires kinesis_require_cloudwatch_logs_subscription handler")
	}
	if len(f.Expect.CloudWatchLogsSubscription.Records) == 0 {
		return errors.New("fixture missing expect.cloudwatch_logs_subscription.records")
	}
	return nil
}

func cloudWatchLogsSubscriptionExpectationsByRecordID(
	records []FixtureCloudWatchLogsSubscriptionRecord,
) (map[string]FixtureCloudWatchLogsSubscriptionRecord, error) {
	expectedByID := make(map[string]FixtureCloudWatchLogsSubscriptionRecord, len(records))
	for i, expected := range records {
		recordID := strings.TrimSpace(expected.RecordID)
		if recordID == "" {
			return nil, fmt.Errorf("expect.cloudwatch_logs_subscription.records[%d] missing record_id", i)
		}
		if _, exists := expectedByID[recordID]; exists {
			return nil, fmt.Errorf("duplicate cloudwatch logs subscription expectation for record_id %q", recordID)
		}
		expected.RecordID = recordID
		if err := validateCloudWatchLogsSubscriptionExpectationRecord(expected); err != nil {
			return nil, err
		}
		expectedByID[recordID] = expected
	}
	return expectedByID, nil
}

func validateCloudWatchLogsSubscriptionInputRecordIDs(
	inputRecordIDs []string,
	expectedByID map[string]FixtureCloudWatchLogsSubscriptionRecord,
) error {
	seenInputRecordIDs := make(map[string]bool, len(inputRecordIDs))
	for _, recordID := range inputRecordIDs {
		if seenInputRecordIDs[recordID] {
			return fmt.Errorf("duplicate kinesis input record_id %q", recordID)
		}
		seenInputRecordIDs[recordID] = true
		if _, ok := expectedByID[recordID]; !ok {
			return fmt.Errorf("missing cloudwatch logs subscription expectation for kinesis record_id %q", recordID)
		}
	}
	for recordID := range expectedByID {
		if !seenInputRecordIDs[recordID] {
			return fmt.Errorf("extra cloudwatch logs subscription expectation for record_id %q", recordID)
		}
	}
	return nil
}

func kinesisInputRecordIDs(raw json.RawMessage) ([]string, error) {
	var event struct {
		Records []struct {
			EventID string `json:"eventID"`
		} `json:"Records"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		return nil, fmt.Errorf("parse kinesis input event for cloudwatch logs subscription expectations: %w", err)
	}
	if len(event.Records) == 0 {
		return nil, errors.New("cloudwatch logs subscription fixture missing kinesis input records")
	}
	ids := make([]string, 0, len(event.Records))
	for i, record := range event.Records {
		recordID := strings.TrimSpace(record.EventID)
		if recordID == "" {
			return nil, fmt.Errorf("kinesis input Records[%d] missing eventID for cloudwatch logs subscription expectation", i)
		}
		ids = append(ids, recordID)
	}
	return ids, nil
}

func validateCloudWatchLogsSubscriptionExpectationRecord(expected FixtureCloudWatchLogsSubscriptionRecord) error {
	if expected.DecodeError {
		return validateCloudWatchLogsSubscriptionDecodeErrorExpectation(expected)
	}

	if missing := missingCloudWatchLogsSubscriptionDecodedFields(expected); len(missing) > 0 {
		return fmt.Errorf("cloudwatch logs subscription record_id %q expectation missing %s; malformed records must set decode_error=true", expected.RecordID, strings.Join(missing, ", "))
	}
	if err := validateCloudWatchLogsSubscriptionFilters(expected); err != nil {
		return err
	}
	if err := validateCloudWatchLogsSubscriptionLogEvents(expected); err != nil {
		return err
	}
	if cloudWatchLogsSafeSummaryContainsForbidden(expected.SafeSummary, expected.ForbiddenSafeLogSubstrings) {
		return fmt.Errorf("cloudwatch logs subscription record_id %q safe_summary contains forbidden raw log substring", expected.RecordID)
	}

	return nil
}

func validateCloudWatchLogsSubscriptionDecodeErrorExpectation(
	expected FixtureCloudWatchLogsSubscriptionRecord,
) error {
	if cloudWatchLogsSubscriptionDecodeErrorHasDecodedFields(expected) {
		return fmt.Errorf("cloudwatch logs subscription record_id %q has decode_error=true and decoded fields", expected.RecordID)
	}
	return nil
}

func cloudWatchLogsSubscriptionDecodeErrorHasDecodedFields(expected FixtureCloudWatchLogsSubscriptionRecord) bool {
	return strings.TrimSpace(expected.MessageType) != "" ||
		strings.TrimSpace(expected.Owner) != "" ||
		strings.TrimSpace(expected.LogGroup) != "" ||
		strings.TrimSpace(expected.LogStream) != "" ||
		len(expected.SubscriptionFilters) > 0 ||
		len(expected.LogEvents) > 0 ||
		len(expected.SafeSummary) > 0 ||
		len(expected.ForbiddenSafeLogSubstrings) > 0
}

func missingCloudWatchLogsSubscriptionDecodedFields(expected FixtureCloudWatchLogsSubscriptionRecord) []string {
	missing := make([]string, 0, 7)
	if strings.TrimSpace(expected.MessageType) == "" {
		missing = append(missing, "message_type")
	}
	if strings.TrimSpace(expected.Owner) == "" {
		missing = append(missing, "owner")
	}
	if strings.TrimSpace(expected.LogGroup) == "" {
		missing = append(missing, "log_group")
	}
	if strings.TrimSpace(expected.LogStream) == "" {
		missing = append(missing, "log_stream")
	}
	if len(expected.SubscriptionFilters) == 0 {
		missing = append(missing, "subscription_filters")
	}
	if len(expected.LogEvents) == 0 {
		missing = append(missing, "log_events")
	}
	if len(expected.SafeSummary) == 0 {
		missing = append(missing, "safe_summary")
	}
	return missing
}

func validateCloudWatchLogsSubscriptionFilters(expected FixtureCloudWatchLogsSubscriptionRecord) error {
	for i, filter := range expected.SubscriptionFilters {
		if strings.TrimSpace(filter) == "" {
			return fmt.Errorf("cloudwatch logs subscription record_id %q subscription_filters[%d] is empty", expected.RecordID, i)
		}
	}
	return nil
}

func validateCloudWatchLogsSubscriptionLogEvents(expected FixtureCloudWatchLogsSubscriptionRecord) error {
	for i, event := range expected.LogEvents {
		if strings.TrimSpace(event.ID) == "" {
			return fmt.Errorf("cloudwatch logs subscription record_id %q log_events[%d] missing id", expected.RecordID, i)
		}
		if strings.TrimSpace(event.Message) == "" {
			return fmt.Errorf("cloudwatch logs subscription record_id %q log_events[%d] missing message", expected.RecordID, i)
		}
	}
	return nil
}

func newCloudWatchLogsSubscriptionHandler(
	expectations *cloudWatchLogsSubscriptionExpectations,
	decoder cloudWatchLogsSubscriptionDecoder,
) apptheory.KinesisHandler {
	if decoder == nil {
		decoder = missingCloudWatchLogsSubscriptionDecoder
	}
	return func(_ *apptheory.EventContext, record events.KinesisEventRecord) error {
		if expectations == nil {
			return errors.New("fixture missing validated cloudwatch logs subscription expectations")
		}
		recordID := strings.TrimSpace(record.EventID)
		expected, ok := expectations.byRecordID[recordID]
		if !ok {
			return fmt.Errorf("missing cloudwatch logs subscription expectation for kinesis record_id %q", recordID)
		}

		actual, err := decoder(record)
		if err != nil {
			return err
		}
		if expected.DecodeError {
			return fmt.Errorf("cloudwatch logs subscription record_id %q expected decode_error=true, got decoded record", recordID)
		}
		return compareCloudWatchLogsSubscriptionDecodedRecord(expected, actual)
	}
}

func decodeCloudWatchLogsSubscriptionRecord(record events.KinesisEventRecord) (FixtureCloudWatchLogsSubscriptionRecord, error) {
	decoded, err := apptheory.DecodeCloudWatchLogsSubscription(record)
	if err != nil {
		return FixtureCloudWatchLogsSubscriptionRecord{}, err
	}
	return FixtureCloudWatchLogsSubscriptionRecord{
		RecordID:            decoded.RecordID,
		MessageType:         decoded.MessageType,
		Owner:               decoded.Owner,
		LogGroup:            decoded.LogGroup,
		LogStream:           decoded.LogStream,
		SubscriptionFilters: append([]string(nil), decoded.SubscriptionFilters...),
		LogEvents:           cloudWatchLogsSubscriptionFixtureLogEvents(decoded.LogEvents),
		SafeSummary:         cloudWatchLogsSubscriptionSafeSummaryMap(decoded.SafeSummary),
	}, nil
}

func cloudWatchLogsSubscriptionFixtureLogEvents(
	in []apptheory.CloudWatchLogsSubscriptionLogEvent,
) []FixtureCloudWatchLogsSubscriptionLogEvent {
	if len(in) == 0 {
		return nil
	}
	out := make([]FixtureCloudWatchLogsSubscriptionLogEvent, len(in))
	for i, event := range in {
		out[i] = FixtureCloudWatchLogsSubscriptionLogEvent{
			ID:        event.ID,
			Timestamp: event.Timestamp,
			Message:   event.Message,
		}
	}
	return out
}

func cloudWatchLogsSubscriptionSafeSummaryMap(summary apptheory.CloudWatchLogsSubscriptionSummary) map[string]any {
	return map[string]any{
		"record_id":                 summary.RecordID,
		"message_type":              summary.MessageType,
		"owner":                     summary.Owner,
		"log_group":                 summary.LogGroup,
		"log_stream":                summary.LogStream,
		"subscription_filter_count": summary.SubscriptionFilterCount,
		"log_event_count":           summary.LogEventCount,
		"safe_log":                  summary.SafeLog,
	}
}

func missingCloudWatchLogsSubscriptionDecoder(events.KinesisEventRecord) (FixtureCloudWatchLogsSubscriptionRecord, error) {
	return FixtureCloudWatchLogsSubscriptionRecord{}, errors.New(cloudWatchLogsSubscriptionMissingHelperMessage)
}

func compareCloudWatchLogsSubscriptionDecodedRecord(
	expected FixtureCloudWatchLogsSubscriptionRecord,
	actual FixtureCloudWatchLogsSubscriptionRecord,
) error {
	if actualRecordID := strings.TrimSpace(actual.RecordID); actualRecordID != "" && actualRecordID != expected.RecordID {
		return fmt.Errorf("cloudwatch logs subscription record_id mismatch: expected %q, got %q", expected.RecordID, actualRecordID)
	}
	if strings.TrimSpace(actual.MessageType) != strings.TrimSpace(expected.MessageType) {
		return fmt.Errorf("cloudwatch logs subscription record_id %q message_type mismatch", expected.RecordID)
	}
	if strings.TrimSpace(actual.Owner) != strings.TrimSpace(expected.Owner) {
		return fmt.Errorf("cloudwatch logs subscription record_id %q owner mismatch", expected.RecordID)
	}
	if strings.TrimSpace(actual.LogGroup) != strings.TrimSpace(expected.LogGroup) {
		return fmt.Errorf("cloudwatch logs subscription record_id %q log_group mismatch", expected.RecordID)
	}
	if strings.TrimSpace(actual.LogStream) != strings.TrimSpace(expected.LogStream) {
		return fmt.Errorf("cloudwatch logs subscription record_id %q log_stream mismatch", expected.RecordID)
	}
	if !stringSlicesEqual(expected.SubscriptionFilters, actual.SubscriptionFilters) {
		return fmt.Errorf("cloudwatch logs subscription record_id %q subscription_filters mismatch", expected.RecordID)
	}
	if !cloudWatchLogsSubscriptionLogEventsEqual(expected.LogEvents, actual.LogEvents) {
		return fmt.Errorf("cloudwatch logs subscription record_id %q log_events mismatch", expected.RecordID)
	}
	if !jsonEqual(expected.SafeSummary, actual.SafeSummary) {
		return fmt.Errorf("cloudwatch logs subscription record_id %q safe_summary mismatch", expected.RecordID)
	}
	if cloudWatchLogsSafeSummaryContainsForbidden(actual.SafeSummary, expected.ForbiddenSafeLogSubstrings) {
		return fmt.Errorf("cloudwatch logs subscription record_id %q safe_summary contains forbidden raw log substring", expected.RecordID)
	}
	return nil
}

func stringSlicesEqual(expected []string, actual []string) bool {
	if len(expected) != len(actual) {
		return false
	}
	for i := range expected {
		if expected[i] != actual[i] {
			return false
		}
	}
	return true
}

func cloudWatchLogsSubscriptionLogEventsEqual(
	expected []FixtureCloudWatchLogsSubscriptionLogEvent,
	actual []FixtureCloudWatchLogsSubscriptionLogEvent,
) bool {
	if len(expected) != len(actual) {
		return false
	}
	for i := range expected {
		if expected[i] != actual[i] {
			return false
		}
	}
	return true
}

func cloudWatchLogsSafeSummaryContainsForbidden(safeSummary map[string]any, forbidden []string) bool {
	if len(safeSummary) == 0 || len(forbidden) == 0 {
		return false
	}
	raw, err := json.Marshal(safeSummary)
	if err != nil {
		return true
	}
	return containsAny(string(raw), forbidden)
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
