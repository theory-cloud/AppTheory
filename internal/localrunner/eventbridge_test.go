package localrunner

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParseScheduleExpression(t *testing.T) {
	rate, err := parseScheduleExpression("rate(5 minutes)")
	if err != nil || rate.rateInterval != 5*time.Minute {
		t.Fatalf("rate: %+v %v", rate, err)
	}
	for _, invalid := range []string{"rate(1 minutes)", "rate(5 minute)", "rate(0 hours)", "rate(2 weeks)", "cron(0 12 * * *)"} {
		if _, parseErr := parseScheduleExpression(invalid); parseErr == nil {
			t.Fatalf("%q must be refused", invalid)
		}
	}
	start := time.Date(2026, 1, 1, 11, 59, 0, 0, time.UTC)
	cron, err := parseScheduleExpression("cron(0 12 * * ? *)")
	if err != nil {
		t.Fatalf("cron: %v", err)
	}
	next, err := cron.next(start)
	if err != nil || !next.Equal(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("next noon: %v %v", next, err)
	}
	weekday, err := parseScheduleExpression("cron(0/15 8-9 ? JAN MON-FRI 2026)")
	if err != nil {
		t.Fatalf("cron names: %v", err)
	}
	next, err = weekday.next(time.Date(2026, 1, 2, 8, 0, 0, 0, time.UTC)) // Friday
	if err != nil || !next.Equal(time.Date(2026, 1, 2, 8, 15, 0, 0, time.UTC)) {
		t.Fatalf("weekday next: %v %v", next, err)
	}
	for _, unsupported := range []string{"cron(0 12 L * ? *)", "cron(0 12 ? * 6L *)", "cron(0 12 ? * 3#2 *)"} {
		if _, err := parseScheduleExpression(unsupported); err == nil {
			t.Fatalf("%q must be refused by name", unsupported)
		}
	}
}

func TestEventBridgeBusMatchesAndDispatches(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	bus := newEventBridgeBus(clock)
	var mu sync.Mutex
	var fired []map[string]any
	runtime := &eventBridgeRuleRuntime{
		rule: RuleSpec{
			LogicalID:    "Rule",
			BusName:      "custom",
			EventPattern: json.RawMessage(`{"source":["app.test"],"detail":{"kind":["x"]}}`),
		},
		fire: func(_ context.Context, event map[string]any) {
			mu.Lock()
			fired = append(fired, event)
			mu.Unlock()
		},
	}
	runtime.setActive(true)
	bus.register(runtime)
	disabled := &eventBridgeRuleRuntime{
		rule: RuleSpec{LogicalID: "Disabled", BusName: "custom", EventPattern: json.RawMessage(`{"source":["app.test"]}`)},
	}
	bus.register(disabled)

	results, failed := bus.putEvents(context.Background(), []eventBridgeEntry{
		{Source: "app.test", DetailType: "Thing", Detail: `{"kind":"x"}`, EventBusName: "custom"},
		{Source: "other.test", DetailType: "Thing", Detail: `{"kind":"x"}`, EventBusName: "custom"},
		{Source: "app.test", DetailType: "Thing", Detail: `{"kind":"x"}`, EventBusName: "default"},
	})
	if failed != 0 || len(results) != 3 || results[0].EventID == "" {
		t.Fatalf("putEvents: %+v failed %d", results, failed)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(fired)
		mu.Unlock()
		if count > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(fired) != 1 {
		t.Fatalf("matching rule fired %d times, want 1: %+v", len(fired), fired)
	}
	event := fired[0]
	if event["source"] != "app.test" || event["detail-type"] != "Thing" ||
		event["account"] != LocalAccountID || event["region"] != LocalRegion {
		t.Fatalf("unexpected envelope: %+v", event)
	}
	if _, ok := event["id"].(string); !ok {
		t.Fatalf("envelope has no id: %+v", event)
	}
}

func TestEventBridgeScheduleFiresExactlyOnTheClock(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	bus := newEventBridgeBus(clock)
	rule := RuleSpec{
		LogicalID: "Schedule",
		Name:      "schedule",
		ARN:       ruleARN("default", "schedule"),
		Schedule:  "rate(5 minutes)",
		Enabled:   true,
		TargetSpecs: []RuleTargetSpec{{
			ID:       "target",
			Type:     "function",
			Function: "Fn",
		}},
	}
	deliverer, err := NewEventBridgeDeliverer(DeliverySource{ID: "Schedule", Kind: DeliveryKindEventBridgeSchedule, Rule: &rule}, bus)
	if err != nil {
		t.Fatalf("deliverer: %v", err)
	}
	reporter := &recordingDeliveryReporter{}
	var mu sync.Mutex
	var events []map[string]any
	env := DelivererEnv{
		Source: DeliverySource{ID: "Schedule", Kind: DeliveryKindEventBridgeSchedule, Rule: &rule},
		Clock:  clock,
		InvokeTarget: func(_ context.Context, function string, event []byte) (InvokeResult, error) {
			var decoded map[string]any
			if err := json.Unmarshal(event, &decoded); err != nil {
				return InvokeResult{}, err
			}
			mu.Lock()
			events = append(events, decoded)
			mu.Unlock()
			return InvokeResult{}, nil
		},
		State: reporter,
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		_ = deliverer.Start(ctx, env) //nolint:errcheck // the test cancels the deliverer
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	clock.Advance(15 * time.Minute) //nolint:errcheck // a test clock advance never fails
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(events)
		mu.Unlock()
		if count >= 3 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 3 {
		t.Fatalf("schedule fired %d times, want 3: %+v", len(events), events)
	}
	for _, event := range events {
		if event["source"] != "aws.events" || event["detail-type"] != "Scheduled Event" {
			t.Fatalf("unexpected scheduled envelope: %+v", event)
		}
		resources, _ := event["resources"].([]any) //nolint:errcheck // the test built this shape
		if len(resources) != 1 || resources[0] != rule.ARN {
			t.Fatalf("scheduled envelope resources: %+v", event)
		}
	}
	if reporter.fired != 3 || reporter.delivered != 3 {
		t.Fatalf("reporter fired/delivered: %+v", reporter)
	}
}

func TestEventBridgeRetryAndDeadLetter(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	fake := newFakeSQS(t)
	fake.queue("dlq", nil)
	bus := newEventBridgeBus(clock)
	rule := RuleSpec{
		LogicalID:    "Rule",
		Name:         "rule",
		ARN:          ruleARN("default", "rule"),
		Enabled:      true,
		EventPattern: json.RawMessage(`{"source":["app.fail"]}`),
		TargetSpecs: []RuleTargetSpec{{
			ID:                  "target",
			Type:                "function",
			Function:            "Fn",
			ARN:                 "arn:aws:lambda:us-east-1:123456789012:function:Fn",
			RetryPolicy:         &RuleRetryPolicy{MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600},
			DeadLetterQueue:     "Dlq",
			DeadLetterQueueName: "dlq",
		}},
	}
	deliverer, err := NewEventBridgeDeliverer(DeliverySource{ID: "Rule", Kind: DeliveryKindEventBridgeRule, Rule: &rule}, bus)
	if err != nil {
		t.Fatalf("deliverer: %v", err)
	}
	reporter := &recordingDeliveryReporter{}
	env := DelivererEnv{
		Source:  DeliverySource{ID: "Rule", Kind: DeliveryKindEventBridgeRule, Rule: &rule},
		Clock:   clock,
		Backend: DeliveryBackend{SQS: newSQSClient(fake.server.URL)},
		InvokeTarget: func(context.Context, string, []byte) (InvokeResult, error) {
			return InvokeResult{HandlerError: "boom"}, nil
		},
		State: reporter,
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		_ = deliverer.Start(ctx, env) //nolint:errcheck // the test cancels the deliverer
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	bus.putEvents(ctx, []eventBridgeEntry{{Source: "app.fail", DetailType: "Fail", Detail: `{}`}})
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		clock.Advance(time.Minute) //nolint:errcheck // a test clock advance never fails
		if reporter.deadLettered > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	fake.mu.Lock()
	sent := append([]map[string]any(nil), fake.sent...)
	fake.mu.Unlock()
	if reporter.deadLettered != 1 || len(sent) != 1 {
		t.Fatalf("deadLettered %d sent %d: %+v", reporter.deadLettered, len(sent), sent)
	}
	attributes := sent[0]["MessageAttributes"].(map[string]any) //nolint:errcheck // the test built this shape
	for name, want := range map[string]string{
		"RULE_ARN":                  rule.ARN,
		"TARGET_ARN":                rule.TargetSpecs[0].ARN,
		"ERROR_CODE":                eventBridgeErrorFromTarget,
		"ERROR_MESSAGE":             "boom",
		"EXHAUSTED_RETRY_CONDITION": eventBridgeConditionRetries,
		"RETRY_ATTEMPTS":            "3",
	} {
		entry, ok := attributes[name].(map[string]any)
		if !ok || entry["StringValue"] != want {
			t.Fatalf("DLQ attribute %s = %+v, want %q", name, attributes[name], want)
		}
	}
	if body, _ := sent[0]["MessageBody"].(string); !strings.Contains(body, `"detail-type":"Fail"`) { //nolint:errcheck // the test built this shape
		t.Fatalf("DLQ body %q, want the shaped event payload", body)
	}
}

func TestEventBridgeInputShaping(t *testing.T) {
	rule := RuleSpec{Name: "rule", ARN: ruleARN("default", "rule")}
	event := map[string]any{
		"source":      "app.test",
		"detail-type": "Thing",
		"detail":      map[string]any{"item": "x", "number": json.Number("7")},
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	shaped, err := eventBridgeInput(RuleTargetSpec{InputPath: "$.detail"}, event, rule, now)
	if err != nil || string(shaped) != `{"item":"x","number":7}` {
		t.Fatalf("InputPath: %s %v", shaped, err)
	}
	shaped, err = eventBridgeInput(RuleTargetSpec{Input: `{"static":true}`}, event, rule, now)
	if err != nil || string(shaped) != `{"static":true}` {
		t.Fatalf("Input: %s %v", shaped, err)
	}
	transformer := &RuleInputTransformer{
		InputPathsMap: map[string]string{"item": "$.detail.item", "source": "$.source"},
		InputTemplate: `{"item": <item>, "rule": "<aws.events.rule-name>", "source": "<source>"}`,
	}
	shaped, err = eventBridgeInput(RuleTargetSpec{InputTransformer: transformer}, event, rule, now)
	if err != nil {
		t.Fatalf("transformer: %v", err)
	}
	var decoded map[string]any
	if decodeErr := json.Unmarshal(shaped, &decoded); decodeErr != nil {
		t.Fatalf("transformer output is not JSON: %s %v", shaped, decodeErr)
	}
	if decoded["item"] != "x" || decoded["rule"] != "rule" || decoded["source"] != "app.test" {
		t.Fatalf("transformer output: %s", shaped)
	}
	missing, err := renderEventBridgeTemplate(&RuleInputTransformer{
		InputPathsMap: map[string]string{"nope": "$.detail.nope"},
		InputTemplate: `{"value": "<nope>"}`,
	}, event, rule, now)
	if err != nil || strings.Contains(string(missing), "nope") {
		t.Fatalf("a missing path must remove the variable: %s %v", missing, err)
	}
}

func TestEventBridgeMessageGroupResolution(t *testing.T) {
	event := map[string]any{"detail": map[string]any{"group": "g1"}}
	if got := eventBridgeMessageGroup("$.detail.group", event); got != "g1" {
		t.Fatalf("path group %q", got)
	}
	if got := eventBridgeMessageGroup("literal", event); got != "literal" {
		t.Fatalf("literal group %q", got)
	}
	if got := eventBridgeMessageGroup("$.detail.missing", event); got != "" {
		t.Fatalf("missing group %q", got)
	}
}

// AWS defines ? as a day field with no specific value that delegates to the
// other day field, so cron(0 12 ? * MON-FRI *) fires Monday through Friday
// only. After Friday 2026-01-02 12:00 the next firing is Monday, not Saturday.
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html
func TestCronQuestionDelegatesToTheOtherDayField(t *testing.T) {
	spec, err := parseScheduleExpression("cron(0 12 ? * MON-FRI *)")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	got, err := spec.next(time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)) // Friday
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	want := time.Date(2026, 1, 5, 12, 0, 0, 0, time.UTC) // Monday
	if !got.Equal(want) {
		t.Fatalf("next after Friday = %s, want Monday %s", got, want)
	}
}

// EventBridge numbers day-of-week 1-7 with SUN=1, so a name must equal its
// numeric value: cron(0 12 4 * SUN *) fires on Sunday 2026-01-04, and MON fires
// on a Monday rather than a Sunday.
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html
func TestCronDayOfWeekNamesUseAWSNumbering(t *testing.T) {
	sunday, err := parseScheduleExpression("cron(0 12 4 * SUN *)")
	if err != nil {
		t.Fatalf("parse SUN: %v", err)
	}
	got, err := sunday.next(time.Date(2026, 1, 3, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("SUN next: %v", err)
	}
	if want := time.Date(2026, 1, 4, 12, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("cron(0 12 4 * SUN *) next = %s, want Sunday %s", got, want)
	}
	monday, err := parseScheduleExpression("cron(0 12 ? * MON *)")
	if err != nil {
		t.Fatalf("parse MON: %v", err)
	}
	got, err = monday.next(time.Date(2026, 1, 4, 0, 0, 0, 0, time.UTC)) // Sunday
	if err != nil {
		t.Fatalf("MON next: %v", err)
	}
	if want := time.Date(2026, 1, 5, 12, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("cron(0 12 ? * MON *) next after Sunday = %s, want Monday %s", got, want)
	}
}

// The Day-of-month and Day-of-week fields are mutually exclusive: AWS refuses
// * in both and requires ? in one, so the refusal names both fields.
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html
func TestCronRefusesAsteriskInBothDayFields(t *testing.T) {
	_, err := parseScheduleExpression("cron(0 12 * * * *)")
	if err == nil {
		t.Fatal("cron with * in both day fields must be refused")
	}
	if !strings.Contains(err.Error(), "day-of-month") || !strings.Contains(err.Error(), "day-of-week") {
		t.Fatalf("the refusal must name both day fields: %v", err)
	}
}
