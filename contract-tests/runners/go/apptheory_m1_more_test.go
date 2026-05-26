package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/testkit"
)

func TestCompareFixtureOutputJSON_CoversAllErrorBranches(t *testing.T) {
	t.Parallel()

	if err := compareFixtureOutputJSON(Fixture{Expect: FixtureExpect{Output: nil}}, map[string]any{"ok": true}); err == nil || !strings.Contains(err.Error(), "fixture missing expect.output_json") {
		t.Fatalf("expected missing expect.output_json error, got %v", err)
	}

	if err := compareFixtureOutputJSON(Fixture{Expect: FixtureExpect{Output: []byte(`{`)}}, map[string]any{"ok": true}); err == nil || !strings.Contains(err.Error(), "parse expected output_json") {
		t.Fatalf("expected parse expected output_json error, got %v", err)
	}

	if err := compareFixtureOutputJSON(Fixture{Expect: FixtureExpect{Output: []byte(`{"ok":true}`)}}, make(chan int)); err == nil || !strings.Contains(err.Error(), "marshal actual output") {
		t.Fatalf("expected marshal actual output error, got %v", err)
	}

	if err := compareFixtureOutputJSON(Fixture{Expect: FixtureExpect{Output: []byte(`{"ok":true}`)}}, map[string]any{"ok": false}); err == nil || !strings.Contains(err.Error(), "output_json mismatch") {
		t.Fatalf("expected output_json mismatch error, got %v", err)
	}

	if err := compareFixtureOutputJSON(Fixture{Expect: FixtureExpect{Output: []byte(`{"ok":true}`)}}, map[string]any{"ok": true}); err != nil {
		t.Fatalf("expected output_json match, got %v", err)
	}
}

func TestCompareFixtureM1Result_ErrorBranches(t *testing.T) {
	t.Parallel()

	if err := compareFixtureM1Result(
		Fixture{Expect: FixtureExpect{Error: &FixtureError{Message: "boom"}, Output: []byte(`{"ok":true}`)}},
		nil,
		errors.New("boom"),
	); err == nil || !strings.Contains(err.Error(), "cannot set both") {
		t.Fatalf("expected conflicting expect error, got %v", err)
	}

	if err := compareFixtureM1Result(
		Fixture{Expect: FixtureExpect{Error: &FixtureError{Message: "boom"}}},
		nil,
		nil,
	); err == nil || !strings.Contains(err.Error(), "expected error") {
		t.Fatalf("expected missing error failure, got %v", err)
	}

	if err := compareFixtureM1Result(
		Fixture{Expect: FixtureExpect{Error: &FixtureError{Message: "expected"}}},
		nil,
		errors.New("got"),
	); err == nil || !strings.Contains(err.Error(), "error message mismatch") {
		t.Fatalf("expected error message mismatch, got %v", err)
	}

	if err := compareFixtureM1Result(
		Fixture{Expect: FixtureExpect{Error: &FixtureError{Message: "boom"}}},
		nil,
		errors.New("boom"),
	); err != nil {
		t.Fatalf("expected error match, got %v", err)
	}

	if err := compareFixtureM1Result(
		Fixture{Expect: FixtureExpect{}},
		map[string]any{"ok": true},
		nil,
	); err == nil || !strings.Contains(err.Error(), "missing expect.output_json or expect.error") {
		t.Fatalf("expected missing expectation error, got %v", err)
	}
}

func TestBuiltInRecordHandler_AndRequireEventMiddleware_Branches(t *testing.T) {
	t.Parallel()

	noop := builtInRecordHandler[int]("noop", "noop", "always", "cond", func(int) bool { return false })
	if noop == nil || noop(&apptheory.EventContext{}, 1) != nil {
		t.Fatal("expected noop handler")
	}

	always := builtInRecordHandler[int]("always", "noop", "always", "cond", func(int) bool { return false })
	if always == nil || always(&apptheory.EventContext{}, 1) == nil {
		t.Fatal("expected always-fail handler")
	}

	cond := builtInRecordHandler[int]("cond", "noop", "always", "cond", func(v int) bool { return v == 1 })
	if cond == nil {
		t.Fatal("expected conditional handler")
	}
	if cond(&apptheory.EventContext{}, 0) != nil {
		t.Fatal("expected conditional handler to allow")
	}
	if cond(&apptheory.EventContext{}, 1) == nil {
		t.Fatal("expected conditional handler to fail")
	}

	if builtInRecordHandler[int]("nope", "noop", "always", "cond", func(int) bool { return false }) != nil {
		t.Fatal("expected unknown handler to be nil")
	}

	if err := requireEventMiddleware(&apptheory.EventContext{}); err == nil || !strings.Contains(err.Error(), "missing middleware value") {
		t.Fatalf("expected missing middleware value error, got %v", err)
	}

	ctx := &apptheory.EventContext{}
	ctx.Set("mw", "ok")
	ctx.Set("trace", []string{"evt_mw_a"})
	if err := requireEventMiddleware(ctx); err == nil || !strings.Contains(err.Error(), "bad trace") {
		t.Fatalf("expected bad trace error, got %v", err)
	}

	ctx.Set("trace", []string{"evt_mw_a", "evt_mw_b"})
	if err := requireEventMiddleware(ctx); err != nil {
		t.Fatalf("expected middleware requirement to pass, got %v", err)
	}
}

func TestBuiltInM1EventMiddleware_UnknownIsNil(t *testing.T) {
	t.Parallel()

	if builtInM1EventMiddleware("nope") != nil {
		t.Fatal("expected unknown middleware to be nil")
	}
}

func TestBuiltInOutputHandler_UnknownIsNil(t *testing.T) {
	t.Parallel()

	if builtInOutputHandler[int]("nope", "sns") != nil {
		t.Fatal("expected unknown output handler to be nil")
	}

	if builtInSNSHandler("nope") != nil {
		t.Fatal("expected unknown sns handler to be nil")
	}

	if builtInEventBridgeHandler("nope") != nil {
		t.Fatal("expected unknown eventbridge handler to be nil")
	}

	if builtInDynamoDBStreamHandler("nope") != nil {
		// Note: ddb special-case is only for ddb_requires_event_middleware.
		t.Fatal("expected unknown dynamodb handler to be nil")
	}

	if builtInKinesisHandler("nope", nil) != nil {
		t.Fatal("expected unknown kinesis handler to be nil")
	}

	if builtInSQSHandler("nope") != nil {
		t.Fatal("expected unknown sqs handler to be nil")
	}
}

func TestBuiltInSQSHandler_RequiresEventMiddleware(t *testing.T) {
	t.Parallel()

	h := builtInSQSHandler("sqs_requires_event_middleware")
	if h == nil {
		t.Fatal("expected sqs_requires_event_middleware handler")
	}
	if err := h(&apptheory.EventContext{}, events.SQSMessage{}); err == nil {
		t.Fatal("expected missing middleware error")
	}
}

func TestRunFixtureM1_MissingAWSEvent(t *testing.T) {
	t.Parallel()

	err := runFixtureM1(Fixture{})
	if err == nil || !strings.Contains(err.Error(), "fixture missing input.aws_event") {
		t.Fatalf("expected missing input.aws_event error, got %v", err)
	}
}

func TestCloudWatchLogsSubscriptionExpectations_Hygiene(t *testing.T) {
	t.Parallel()

	fixture := cloudWatchLogsSubscriptionFixtureForTest()
	expectations, err := newCloudWatchLogsSubscriptionExpectations(fixture)
	if err != nil {
		t.Fatalf("expected valid cloudwatch logs subscription expectations, got %v", err)
	}
	if expectations == nil || len(expectations.byRecordID) != 2 {
		t.Fatalf("expected two expectations, got %#v", expectations)
	}

	missing := cloudWatchLogsSubscriptionFixtureForTest()
	missing.Expect.CloudWatchLogsSubscription.Records = missing.Expect.CloudWatchLogsSubscription.Records[:1]
	if _, err := newCloudWatchLogsSubscriptionExpectations(missing); err == nil || !strings.Contains(err.Error(), "missing cloudwatch logs subscription expectation") {
		t.Fatalf("expected missing input record expectation error, got %v", err)
	}

	extra := cloudWatchLogsSubscriptionFixtureForTest()
	extra.Expect.CloudWatchLogsSubscription.Records = append(
		append([]FixtureCloudWatchLogsSubscriptionRecord(nil), extra.Expect.CloudWatchLogsSubscription.Records...),
		FixtureCloudWatchLogsSubscriptionRecord{RecordID: "unexpected", DecodeError: true},
	)
	if _, err := newCloudWatchLogsSubscriptionExpectations(extra); err == nil || !strings.Contains(err.Error(), "extra cloudwatch logs subscription expectation") {
		t.Fatalf("expected extra expectation error, got %v", err)
	}

	duplicate := cloudWatchLogsSubscriptionFixtureForTest()
	duplicate.Expect.CloudWatchLogsSubscription.Records = append(
		append([]FixtureCloudWatchLogsSubscriptionRecord(nil), duplicate.Expect.CloudWatchLogsSubscription.Records...),
		duplicate.Expect.CloudWatchLogsSubscription.Records[0],
	)
	if _, err := newCloudWatchLogsSubscriptionExpectations(duplicate); err == nil || !strings.Contains(err.Error(), "duplicate cloudwatch logs subscription expectation") {
		t.Fatalf("expected duplicate expectation error, got %v", err)
	}

	malformedNotMarked := cloudWatchLogsSubscriptionFixtureForTest()
	malformedNotMarked.Expect.CloudWatchLogsSubscription.Records[1] = FixtureCloudWatchLogsSubscriptionRecord{RecordID: "r2"}
	if _, err := newCloudWatchLogsSubscriptionExpectations(malformedNotMarked); err == nil || !strings.Contains(err.Error(), "malformed records must set decode_error=true") {
		t.Fatalf("expected malformed expectation hygiene error, got %v", err)
	}

	decodeErrorWithFields := cloudWatchLogsSubscriptionFixtureForTest()
	decodeErrorWithFields.Expect.CloudWatchLogsSubscription.Records[1] = FixtureCloudWatchLogsSubscriptionRecord{
		RecordID:    "r2",
		DecodeError: true,
		MessageType: "DATA_MESSAGE",
	}
	if _, err := newCloudWatchLogsSubscriptionExpectations(decodeErrorWithFields); err == nil || !strings.Contains(err.Error(), "decode_error=true and decoded fields") {
		t.Fatalf("expected decode_error decoded field hygiene error, got %v", err)
	}
}

func TestCloudWatchLogsSubscriptionHandler_CompareScaffold(t *testing.T) {
	t.Parallel()

	fixture := cloudWatchLogsSubscriptionFixtureForTest()
	expectations, err := newCloudWatchLogsSubscriptionExpectations(fixture)
	if err != nil {
		t.Fatalf("expected valid expectations, got %v", err)
	}

	validExpected := expectations.byRecordID["r1"]
	handler := newCloudWatchLogsSubscriptionHandler(expectations, func(record events.KinesisEventRecord) (FixtureCloudWatchLogsSubscriptionRecord, error) {
		if record.EventID == "r2" {
			return FixtureCloudWatchLogsSubscriptionRecord{}, errors.New("decode failed")
		}
		return validExpected, nil
	})

	if err := handler(&apptheory.EventContext{}, events.KinesisEventRecord{EventID: "r1"}); err != nil {
		t.Fatalf("expected valid decoded record to pass, got %v", err)
	}
	if err := handler(&apptheory.EventContext{}, events.KinesisEventRecord{EventID: "r2"}); err == nil || !strings.Contains(err.Error(), "decode failed") {
		t.Fatalf("expected decode_error record to return decoder error, got %v", err)
	}

	mismatched := newCloudWatchLogsSubscriptionHandler(expectations, func(events.KinesisEventRecord) (FixtureCloudWatchLogsSubscriptionRecord, error) {
		actual := validExpected
		actual.MessageType = "CONTROL_MESSAGE"
		return actual, nil
	})
	if err := mismatched(&apptheory.EventContext{}, events.KinesisEventRecord{EventID: "r1"}); err == nil || !strings.Contains(err.Error(), "message_type mismatch") {
		t.Fatalf("expected message_type comparison error, got %v", err)
	}

	unsafe := newCloudWatchLogsSubscriptionHandler(expectations, func(events.KinesisEventRecord) (FixtureCloudWatchLogsSubscriptionRecord, error) {
		actual := validExpected
		actual.SafeSummary = map[string]any{"safe_log": "contract log line alpha"}
		return actual, nil
	})
	if err := unsafe(&apptheory.EventContext{}, events.KinesisEventRecord{EventID: "r1"}); err == nil || !strings.Contains(err.Error(), "safe_summary mismatch") {
		t.Fatalf("expected safe_summary comparison error, got %v", err)
	}

	missingHelper := newCloudWatchLogsSubscriptionHandler(expectations, nil)
	if err := missingHelper(&apptheory.EventContext{}, events.KinesisEventRecord{EventID: "r1"}); err == nil || !strings.Contains(err.Error(), cloudWatchLogsSubscriptionMissingHelperMessage) {
		t.Fatalf("expected missing helper error, got %v", err)
	}
}

func TestCloudWatchLogsSubscriptionDecoderAdapter_UsesRuntimeHelper(t *testing.T) {
	t.Parallel()

	record := testkit.KinesisEvent(testkit.KinesisEventOptions{
		StreamARN: "arn:aws:kinesis:us-east-1:123:stream/stream",
		Records: []testkit.KinesisRecordOptions{
			testkit.KinesisCloudWatchLogsSubscriptionRecord(testkit.KinesisCloudWatchLogsSubscriptionRecordOptions{
				EventID: "r1",
				Subscription: testkit.CloudWatchLogsSubscriptionOptions{
					Owner:               "111122223333",
					LogGroup:            "/aws/lambda/example",
					LogStream:           "2026/05/26/[$LATEST]example",
					SubscriptionFilters: []string{"filter"},
					LogEvents: []apptheory.CloudWatchLogsSubscriptionLogEvent{
						{ID: "event-1", Timestamp: 1779806400000, Message: "contract log line alpha"},
					},
				},
			}),
		},
	}).Records[0]

	actual, err := decodeCloudWatchLogsSubscriptionRecord(record)
	if err != nil {
		t.Fatalf("decodeCloudWatchLogsSubscriptionRecord returned error: %v", err)
	}
	expected := cloudWatchLogsSubscriptionFixtureForTest().Expect.CloudWatchLogsSubscription.Records[0]
	if err := compareCloudWatchLogsSubscriptionDecodedRecord(expected, actual); err != nil {
		t.Fatalf("expected runtime decoded record to match fixture shape: %v", err)
	}

	if _, err := decodeCloudWatchLogsSubscriptionRecord(events.KinesisEventRecord{
		EventID: "r2",
		Kinesis: events.KinesisRecord{Data: []byte(`not-gzip`)},
	}); err == nil || !strings.Contains(err.Error(), "cloudwatch logs subscription gzip") {
		t.Fatalf("expected malformed kinesis data to fail decode, got %v", err)
	}
}

func cloudWatchLogsSubscriptionFixtureForTest() Fixture {
	return Fixture{
		Setup: FixtureSetup{
			Kinesis: []FixtureKinesisRoute{{Stream: "stream", Handler: cloudWatchLogsSubscriptionHandlerName}},
		},
		Input: FixtureInput{
			AWSEvent: &FixtureAWSEvent{
				Source: "kinesis",
				Event:  json.RawMessage(`{"Records":[{"eventID":"r1"},{"eventID":"r2"}]}`),
			},
		},
		Expect: FixtureExpect{
			CloudWatchLogsSubscription: &FixtureCloudWatchLogsSubscription{
				Records: []FixtureCloudWatchLogsSubscriptionRecord{
					{
						RecordID:            "r1",
						MessageType:         "DATA_MESSAGE",
						Owner:               "111122223333",
						LogGroup:            "/aws/lambda/example",
						LogStream:           "2026/05/26/[$LATEST]example",
						SubscriptionFilters: []string{"filter"},
						LogEvents: []FixtureCloudWatchLogsSubscriptionLogEvent{
							{ID: "event-1", Timestamp: 1779806400000, Message: "contract log line alpha"},
						},
						SafeSummary: map[string]any{
							"record_id":                 "r1",
							"message_type":              "DATA_MESSAGE",
							"owner":                     "111122223333",
							"log_group":                 "/aws/lambda/example",
							"log_stream":                "2026/05/26/[$LATEST]example",
							"subscription_filter_count": 1,
							"log_event_count":           1,
							"safe_log":                  "record_id=r1 owner=111122223333 log_group=/aws/lambda/example log_stream=2026/05/26/[$LATEST]example message_type=DATA_MESSAGE log_events=1 subscription_filters=1",
						},
						ForbiddenSafeLogSubstrings: []string{"contract log line alpha"},
					},
					{RecordID: "r2", DecodeError: true},
				},
			},
		},
	}
}
