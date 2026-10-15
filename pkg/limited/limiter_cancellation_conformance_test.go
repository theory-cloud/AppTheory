package limited

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/tabletheory/v5"
	"github.com/theory-cloud/tabletheory/v5/pkg/session"
	"github.com/theory-cloud/tabletheory/v5/pkg/testing/fakedb"
)

// limiterCancellationFixtureCaseCount pins the shared fixture's row count so a
// dropped row fails this suite instead of silently shrinking it.
const limiterCancellationFixtureCaseCount = 13

// limiterCancellationFixtureCaseIDs pins the shared fixture's rows by id, in
// fixture order, so a renamed, inserted, dropped or reordered row fails the
// suite instead of only moving a count.
var limiterCancellationFixtureCaseIDs = []string{
	"limiter.cancellation.genuine_condition_failure",
	"limiter.cancellation.genuine_condition_failure_after_none",
	"limiter.cancellation.genuine_condition_failure_missing_code_in_position",
	"limiter.cancellation.throttle_only",
	"limiter.cancellation.throttle_after_none",
	"limiter.cancellation.transaction_conflict_only",
	"limiter.cancellation.ordered_conflict_after_throttle",
	"limiter.cancellation.ordered_throttle_before_condition",
	"limiter.cancellation.ambiguous_all_none",
	"limiter.cancellation.no_reasons",
	"limiter.cancellation.message_only_condition_text",
	"limiter.cancellation.unknown_reason_code",
	"limiter.transport.non_cancellation_error",
}

const limiterCancellationFixturePath = "../../contract-tests/fixtures/routing/limiter/multi-window-cancellation.v1.json"

// limiterFixtureDeliverCancelledException is the only supported "deliver" value:
// the row must be handed to TableTheory as a hand-built cancelled exception so
// its exact cancellation message reaches the classifier.
const limiterFixtureDeliverCancelledException = "cancelled_exception"

const (
	outcomeAdmitted      = "admitted"
	outcomeSoftDenial    = "soft_denial"
	outcomeInternalError = "internal_error"
)

type limiterCancellationFixture struct {
	Limiter struct {
		Strategy   string                 `json:"strategy"`
		Windows    []limiterFixtureWindow `json:"windows"`
		ClockEpoch string                 `json:"clock_epoch"`
		Key        limiterFixtureKey      `json:"key"`
	} `json:"limiter"`
	Cases []limiterCancellationCase `json:"cases"`

	epoch time.Time
}

type limiterFixtureWindow struct {
	DurationSeconds int `json:"duration_seconds"`
	MaxRequests     int `json:"max_requests"`
}

type limiterFixtureKey struct {
	Identifier string `json:"identifier"`
	Resource   string `json:"resource"`
	Operation  string `json:"operation"`
}

type limiterCancellationCase struct {
	ID             string                      `json:"id"`
	Class          string                      `json:"class"`
	Deliver        string                      `json:"deliver"`
	Cancellation   *limiterFixtureCancellation `json:"cancellation"`
	TransportError *limiterFixtureTransport    `json:"transport_error"`
	Expect         limiterFixtureExpectations  `json:"expect"`
}

type limiterFixtureCancellation struct {
	Message string                 `json:"message"`
	Reasons []limiterFixtureReason `json:"reasons"`
}

type limiterFixtureReason struct {
	Code    *string `json:"code"`
	Message *string `json:"message"`
}

type limiterFixtureTransport struct {
	Message string `json:"message"`
}

type limiterFixtureExpectations struct {
	FailOpen   string `json:"fail_open"`
	FailClosed string `json:"fail_closed"`
}

type limiterFixturePolicy struct {
	name     string
	failOpen bool
	outcome  string
}

// TestDynamoRateLimiter_CancellationConformance drives the real multi-window
// limiter over a real TableTheory client bound to TableTheory's fake DynamoDB,
// queueing each fixture cancellation shape through the fake's transaction seam
// under both failOpen policies.
func TestDynamoRateLimiter_CancellationConformance(t *testing.T) {
	fixture := loadLimiterCancellationFixture(t)
	require.Len(t, fixture.Cases, limiterCancellationFixtureCaseCount)

	for _, testCase := range fixture.Cases {
		testCase.validate(t)
		t.Run(testCase.ID, func(t *testing.T) {
			for _, policy := range limiterFixturePolicies(testCase.Expect) {
				t.Run(policy.name, func(t *testing.T) {
					assertFixtureLimiterOutcome(t, fixture, testCase, policy)
				})
			}
		})
	}
}

// TestDynamoRateLimiter_CancellationConformanceFixtureIsNotVacuous proves the
// table spans outcomes instead of collapsing onto one, in both directions.
func TestDynamoRateLimiter_CancellationConformanceFixtureIsNotVacuous(t *testing.T) {
	fixture := loadLimiterCancellationFixture(t)

	observed := make(map[string]int, len(fixture.Cases)*2)
	for _, testCase := range fixture.Cases {
		observed[testCase.Expect.FailOpen]++
		observed[testCase.Expect.FailClosed]++
	}

	require.Positive(t, observed[outcomeSoftDenial])
	require.Positive(t, observed[outcomeAdmitted])
	require.Positive(t, observed[outcomeInternalError])
}

// TestDynamoRateLimiter_CancellationConformanceTakesTransactPath proves the
// limiter is bound to a transaction-capable DB and that a queued genuine
// condition failure reaches the soft-denial branch, which only the transact
// path produces; the non-transactional fallback would admit the request.
func TestDynamoRateLimiter_CancellationConformanceTakesTransactPath(t *testing.T) {
	fixture := loadLimiterCancellationFixture(t)

	testCase, found := firstCaseExpectedToDeny(t, fixture.Cases)
	require.True(t, found)

	limiter := newFixtureLimiter(t, fixture, testCase, true)

	_, transactCapable := any(limiter.db).(transactDB)
	require.True(t, transactCapable, "limiter DB cannot transact; the conformance table would be vacuous")

	decision, err := limiter.CheckAndIncrement(context.Background(), fixture.limitKey())
	require.NoError(t, err)
	require.NotNil(t, decision)
	require.False(t, decision.Allowed)
	require.NotNil(t, decision.RetryAfter)
}

func loadLimiterCancellationFixture(t *testing.T) limiterCancellationFixture {
	t.Helper()

	raw, err := os.ReadFile(limiterCancellationFixturePath)
	require.NoError(t, err)

	var fixture limiterCancellationFixture
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.Equal(t, "multi_window", fixture.Limiter.Strategy)
	require.Len(t, fixture.Limiter.Windows, 2)
	require.Equal(t, limiterCancellationFixtureCaseIDs, fixture.caseIDs(), "fixture case ids diverged from the pinned list")

	epoch, parseErr := time.Parse(time.RFC3339, fixture.Limiter.ClockEpoch)
	require.NoError(t, parseErr)
	fixture.epoch = epoch

	return fixture
}

func (f limiterCancellationFixture) caseIDs() []string {
	ids := make([]string, 0, len(f.Cases))
	for _, testCase := range f.Cases {
		ids = append(ids, testCase.ID)
	}
	return ids
}

func (f limiterCancellationFixture) windowConfigs() []WindowConfig {
	configs := make([]WindowConfig, 0, len(f.Limiter.Windows))
	for _, window := range f.Limiter.Windows {
		configs = append(configs, WindowConfig{
			Duration:    time.Duration(window.DurationSeconds) * time.Second,
			MaxRequests: window.MaxRequests,
		})
	}
	return configs
}

func (f limiterCancellationFixture) limitKey() RateLimitKey {
	return RateLimitKey{
		Identifier: f.Limiter.Key.Identifier,
		Resource:   f.Limiter.Key.Resource,
		Operation:  f.Limiter.Key.Operation,
	}
}

func (c limiterCancellationCase) validate(t *testing.T) {
	t.Helper()

	require.NotEmpty(t, c.ID)
	require.NotEmpty(t, c.Class)
	require.Contains(t, []string{outcomeAdmitted, outcomeSoftDenial, outcomeInternalError}, c.Expect.FailOpen)
	require.Contains(t, []string{outcomeAdmitted, outcomeSoftDenial, outcomeInternalError}, c.Expect.FailClosed)

	if c.Deliver != "" && c.Deliver != limiterFixtureDeliverCancelledException {
		t.Fatalf("case %q declares unsupported deliver %q", c.ID, c.Deliver)
	}
	if c.Deliver == limiterFixtureDeliverCancelledException {
		require.NotNil(t, c.Cancellation, "case %q delivers a cancelled exception without a cancellation", c.ID)
	}

	switch {
	case c.Cancellation != nil && c.TransportError != nil:
		t.Fatalf("case %q queues both a cancellation and a transport error", c.ID)
	case c.Cancellation != nil:
		require.NotEmpty(t, c.Cancellation.Message)
	case c.TransportError != nil:
		require.NotEmpty(t, c.TransportError.Message)
	default:
		t.Fatalf("case %q queues neither a cancellation nor a transport error", c.ID)
	}
}

func limiterFixturePolicies(expect limiterFixtureExpectations) []limiterFixturePolicy {
	return []limiterFixturePolicy{
		{name: "fail_open", failOpen: true, outcome: expect.FailOpen},
		{name: "fail_closed", failOpen: false, outcome: expect.FailClosed},
	}
}

func assertFixtureLimiterOutcome(t *testing.T, fixture limiterCancellationFixture, testCase limiterCancellationCase, policy limiterFixturePolicy) {
	t.Helper()

	limiter := newFixtureLimiter(t, fixture, testCase, policy.failOpen)
	decision, err := limiter.CheckAndIncrement(context.Background(), fixture.limitKey())

	switch policy.outcome {
	case outcomeAdmitted:
		require.NoError(t, err)
		require.NotNil(t, decision)
		require.True(t, decision.Allowed)
	case outcomeSoftDenial:
		require.NoError(t, err)
		require.NotNil(t, decision)
		require.False(t, decision.Allowed)
		require.NotNil(t, decision.RetryAfter)
	case outcomeInternalError:
		var limitErr *Error
		require.ErrorAs(t, err, &limitErr)
		require.Equal(t, ErrorTypeInternal, limitErr.Type)
		require.Equal(t, "internal_error", string(limitErr.Type))
	default:
		t.Fatalf("case %q declares unknown limiter outcome %q", testCase.ID, policy.outcome)
	}
}

// newFixtureLimiter builds a fresh fake, DB and limiter per run: the fake's
// queued transaction failure persists until cleared. The rate-limit table is
// provisioned empty, as it would be in a real deployment, so the limiter's
// post-failure state read is served by DynamoDB rather than failing as
// table-not-found.
func newFixtureLimiter(t *testing.T, fixture limiterCancellationFixture, testCase limiterCancellationCase, failOpen bool) *DynamoRateLimiter {
	t.Helper()

	fake := fakedb.New()

	db, err := tabletheory.NewWithClient(session.Config{Region: "us-east-1"}, fake)
	require.NoError(t, err)
	require.NoError(t, db.EnsureTable(&RateLimitEntry{}))

	queueFixtureTransactionFailure(t, fake, testCase)

	config := DefaultConfig()
	config.FailOpen = failOpen

	limiter := NewDynamoRateLimiter(db, config, NewMultiWindowStrategy(fixture.windowConfigs()))
	limiter.SetClock(fixedClock{now: fixture.epoch})
	return limiter
}

func queueFixtureTransactionFailure(t *testing.T, fake *fakedb.Fake, testCase limiterCancellationCase) {
	t.Helper()

	switch {
	case testCase.Cancellation != nil && testCase.Deliver == limiterFixtureDeliverCancelledException:
		// This row's premise is the message text, so it is delivered as a
		// hand-built cancelled exception carrying the exact message and reasons.
		fake.QueueTransactionError(fixtureCancelledException(testCase.Cancellation))
	case testCase.Cancellation != nil:
		// The cancellation seam carries the ordered reason list only; the fake
		// synthesizes the service message.
		fake.QueueTransactionCancellation(fixtureCancellationReasons(testCase.Cancellation.Reasons))
	case testCase.TransportError != nil:
		fake.QueueTransactionError(errors.New(testCase.TransportError.Message))
	default:
		t.Fatalf("case %q queues neither a cancellation nor a transport error", testCase.ID)
	}
}

func fixtureCancelledException(cancellation *limiterFixtureCancellation) *types.TransactionCanceledException {
	return &types.TransactionCanceledException{
		Message:             aws.String(cancellation.Message),
		CancellationReasons: fixtureCancellationReasons(cancellation.Reasons),
	}
}

func fixtureCancellationReasons(reasons []limiterFixtureReason) []types.CancellationReason {
	queued := make([]types.CancellationReason, 0, len(reasons))
	for _, reason := range reasons {
		queued = append(queued, types.CancellationReason{Code: reason.Code, Message: reason.Message})
	}
	return queued
}

func firstCaseExpectedToDeny(t *testing.T, cases []limiterCancellationCase) (limiterCancellationCase, bool) {
	t.Helper()

	for _, testCase := range cases {
		if testCase.Cancellation != nil && testCase.Expect.FailOpen == outcomeSoftDenial {
			return testCase, true
		}
	}
	return limiterCancellationCase{}, false
}
