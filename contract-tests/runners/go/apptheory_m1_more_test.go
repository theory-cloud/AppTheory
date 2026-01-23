package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/runtime"
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

	if builtInKinesisHandler("nope") != nil {
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
