package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// recordingTB records reported failures instead of failing the running test, so
// the conformance runner's own error paths can be exercised.
type recordingTB struct {
	testing.TB
	reported []string
}

func (tb *recordingTB) Helper() {}

func (tb *recordingTB) Errorf(format string, args ...any) {
	tb.reported = append(tb.reported, fmt.Sprintf(format, args...))
}

func TestMemoryStoreClockDefaultsAndNilRecords(t *testing.T) {
	ctx := context.Background()

	// A store built without a clock falls back to wall time.
	limits := NewMemoryRateLimitStore(RateLimitStoreOptions{})
	result, err := limits.CheckAndIncrement(ctx, RateLimitBucketKey{Identifier: "client", Limit: 1})
	if err != nil || !result.Allowed || result.ResetAt.IsZero() {
		t.Fatalf("default-clock rate limit = %+v %v", result, err)
	}

	// recordCopy is defensively nil-safe.
	if recordCopy[TransactionRecord](nil) != nil {
		t.Fatal("recordCopy(nil) must be nil")
	}

	clock := NewManualClock(ConformanceEpoch)

	transactions := NewMemoryTransactionStore(TransactionStoreOptions{Now: clock.Now})
	if err := transactions.Put(ctx, nil); !errors.Is(err, ErrRecordKeyRequired) {
		t.Fatalf("transaction Put(nil) = %v", err)
	}
	if err := transactions.Put(ctx, &TransactionRecord{StateHash: "  "}); !errors.Is(err, ErrRecordKeyRequired) {
		t.Fatalf("transaction Put(blank) = %v", err)
	}

	codes := NewMemoryAuthorizationCodeStore(AuthorizationCodeStoreOptions{Now: clock.Now})
	if err := codes.Put(ctx, nil); !errors.Is(err, ErrRecordKeyRequired) {
		t.Fatalf("code Put(nil) = %v", err)
	}
	if err := codes.Put(ctx, &AuthorizationCodeRecord{CodeHash: " "}); !errors.Is(err, ErrRecordKeyRequired) {
		t.Fatalf("code Put(blank) = %v", err)
	}
	if _, err := codes.Consume(ctx, "  "); !errors.Is(err, ErrAuthorizationCodeNotFound) {
		t.Fatalf("code Consume(blank) = %v", err)
	}

	clients := NewMemoryClientStore(ClientStoreOptions{Now: clock.Now})
	if err := clients.Put(ctx, nil); !errors.Is(err, ErrRecordKeyRequired) {
		t.Fatalf("client Put(nil) = %v", err)
	}
	if err := clients.Put(ctx, &ClientRecord{ClientIDHash: " "}); !errors.Is(err, ErrRecordKeyRequired) {
		t.Fatalf("client Put(blank) = %v", err)
	}
	if _, err := clients.Get(ctx, "  "); !errors.Is(err, ErrClientNotFound) {
		t.Fatalf("client Get(blank) = %v", err)
	}
	if _, err := clients.Update(ctx, nil, 1); !errors.Is(err, ErrRecordKeyRequired) {
		t.Fatalf("client Update(nil) = %v", err)
	}
	if _, err := clients.Update(ctx, &ClientRecord{ClientIDHash: "missing"}, 1); !errors.Is(err, ErrClientNotFound) {
		t.Fatalf("client Update(unknown) = %v", err)
	}
}

// TestReferenceBrokerLockTTLPinsTheUpstreamFetchDeadline pins the reference
// broker store's default lock TTL to the number the brokered refresh grant is
// built around: 15 seconds is the M2.1 hardened upstream HTTP deadline (10 s,
// shared by the discovery, token, and JWKS fetches) plus a five-second margin,
// and it is well above the facade's three-second coalesce wait cap, so a waiter
// for an in-flight rotation can never outlive and steal the lock. Changing the
// default without the matching facade change is a silent regression, so the
// number and the expiry a lock actually writes are both pinned.
func TestReferenceBrokerLockTTLPinsTheUpstreamFetchDeadline(t *testing.T) {
	if DefaultRouteRefreshLockTTL != 15*time.Second {
		t.Fatalf("DefaultRouteRefreshLockTTL = %s, want 15s", DefaultRouteRefreshLockTTL)
	}
	ctx := context.Background()
	clock := NewManualClock(ConformanceEpoch)
	broker := NewMemoryRouteRefreshBrokerStore(RouteRefreshBrokerStoreOptions{Now: clock.Now})
	if err := broker.Put(ctx, &RouteRefreshBrokerRecord{HandleHash: "handle"}); err != nil {
		t.Fatalf("broker Put = %v", err)
	}
	locked, err := broker.AcquireLock(ctx, "handle", "owner", 1)
	if err != nil {
		t.Fatalf("broker AcquireLock = %v", err)
	}
	if held := locked.RefreshLockExpiresAt.Sub(clock.Now()); held != DefaultRouteRefreshLockTTL {
		t.Fatalf("lock is held for %s, want %s", held, DefaultRouteRefreshLockTTL)
	}
	if _, err := broker.AcquireLock(ctx, "handle", "thief", locked.Version); !errors.Is(err, ErrBrokerLocked) {
		t.Fatalf("second AcquireLock = %v, want ErrBrokerLocked", err)
	}
}

func TestMemoryBrokerStoreEdges(t *testing.T) {
	ctx := context.Background()
	clock := NewManualClock(ConformanceEpoch)
	brokers := NewMemoryRouteRefreshBrokerStore(RouteRefreshBrokerStoreOptions{
		Now:     clock.Now,
		TTL:     10 * time.Minute,
		LockTTL: 30 * time.Second,
	})

	if err := brokers.Put(ctx, nil); !errors.Is(err, ErrRecordKeyRequired) {
		t.Fatalf("broker Put(nil) = %v", err)
	}
	if err := brokers.Put(ctx, &RouteRefreshBrokerRecord{HandleHash: " "}); !errors.Is(err, ErrRecordKeyRequired) {
		t.Fatalf("broker Put(blank) = %v", err)
	}
	if _, err := brokers.Get(ctx, "  "); !errors.Is(err, ErrBrokerNotFound) {
		t.Fatalf("broker Get(blank) = %v", err)
	}
	if _, err := brokers.AcquireLock(ctx, "  ", "owner", 1); !errors.Is(err, ErrBrokerNotFound) {
		t.Fatalf("broker AcquireLock(blank) = %v", err)
	}
	if _, err := brokers.CompareAndSwap(ctx, nil, 1); !errors.Is(err, ErrRecordKeyRequired) {
		t.Fatalf("broker CompareAndSwap(nil) = %v", err)
	}
	if _, err := brokers.Revoke(ctx, "  "); !errors.Is(err, ErrBrokerNotFound) {
		t.Fatalf("broker Revoke(blank) = %v", err)
	}

	// Unknown handles are not found at each operation.
	if _, err := brokers.AcquireLock(ctx, "unknown", "owner", 1); !errors.Is(err, ErrBrokerNotFound) {
		t.Fatalf("AcquireLock(unknown) = %v", err)
	}
	if _, err := brokers.CompareAndSwap(ctx, &RouteRefreshBrokerRecord{HandleHash: "unknown"}, 1); !errors.Is(err, ErrBrokerNotFound) {
		t.Fatalf("CompareAndSwap(unknown) = %v", err)
	}
	if _, err := brokers.Revoke(ctx, "unknown"); !errors.Is(err, ErrBrokerNotFound) {
		t.Fatalf("Revoke(unknown) = %v", err)
	}

	// A stale expected version reports a version conflict.
	if err := brokers.Put(ctx, &RouteRefreshBrokerRecord{HandleHash: "handle", Status: BrokerStatusActive}); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := brokers.AcquireLock(ctx, "handle", "owner", 99); !errors.Is(err, ErrBrokerVersionConflict) {
		t.Fatalf("AcquireLock(stale) = %v", err)
	}

	// A swap with an empty status adopts the current status and keeps storedAt.
	if err := brokers.Put(ctx, &RouteRefreshBrokerRecord{HandleHash: "swap", Status: BrokerStatusActive}); err != nil {
		t.Fatalf("put swap: %v", err)
	}
	swapped, err := brokers.CompareAndSwap(ctx, &RouteRefreshBrokerRecord{HandleHash: "swap"}, 1)
	if err != nil {
		t.Fatalf("compare and swap: %v", err)
	}
	if swapped.Status != BrokerStatusActive || swapped.Version != 2 {
		t.Fatalf("swapped record = %+v", swapped)
	}

	// The local lifetime policy treats an aged-out handle as absent.
	clock.Advance(11 * time.Minute)
	if _, err := brokers.Get(ctx, "handle"); !errors.Is(err, ErrBrokerNotFound) {
		t.Fatalf("aged-out Get = %v", err)
	}
}

func TestNewManualClockZeroStart(t *testing.T) {
	clock := NewManualClock(time.Time{})
	if got := clock.Now(); !got.Equal(time.Unix(0, 0).UTC()) {
		t.Fatalf("zero-start clock = %s, want the Unix epoch", got)
	}
}

// --- conformance runner ------------------------------------------------------

// stubTransaction is a transaction store with injectable failures.
type stubTransaction struct{ putErr, consumeErr error }

func (s stubTransaction) Put(context.Context, *TransactionRecord) error { return s.putErr }
func (s stubTransaction) Consume(context.Context, string) (*TransactionRecord, error) {
	return nil, s.consumeErr
}

// stubAuthCode is an authorization-code store with injectable failures.
type stubAuthCode struct{ putErr, consumeErr error }

func (s stubAuthCode) Put(context.Context, *AuthorizationCodeRecord) error { return s.putErr }
func (s stubAuthCode) Consume(context.Context, string) (*AuthorizationCodeRecord, error) {
	return nil, s.consumeErr
}

// stubClient is a client store whose Get failures are scripted in order.
type stubClient struct {
	putErr    error
	updateErr error
	getErrs   []error
}

func (s *stubClient) Put(context.Context, *ClientRecord) error { return s.putErr }
func (s *stubClient) Get(context.Context, string) (*ClientRecord, error) {
	if len(s.getErrs) == 0 {
		return &ClientRecord{ClientIDHash: "client", Version: 1}, nil
	}
	err := s.getErrs[0]
	s.getErrs = s.getErrs[1:]
	if err != nil {
		return nil, err
	}
	return &ClientRecord{ClientIDHash: "client", Version: 1}, nil
}
func (s *stubClient) Update(context.Context, *ClientRecord, int) (*ClientRecord, error) {
	if s.updateErr != nil {
		return nil, s.updateErr
	}
	return &ClientRecord{ClientIDHash: "client", Version: 2}, nil
}

// stubBroker is a seedable broker store with scripted failures.
type stubBroker struct {
	seedErr    error
	getErrs    []error
	lockErrs   []error
	lockNil    bool
	swapErr    error
	revokeErr  error
	seedCalled bool
}

func (s *stubBroker) Put(context.Context, *RouteRefreshBrokerRecord) error {
	s.seedCalled = true
	return s.seedErr
}
func (s *stubBroker) Get(context.Context, string) (*RouteRefreshBrokerRecord, error) {
	if len(s.getErrs) == 0 {
		return &RouteRefreshBrokerRecord{Version: 1}, nil
	}
	err := s.getErrs[0]
	s.getErrs = s.getErrs[1:]
	if err != nil {
		return nil, err
	}
	return &RouteRefreshBrokerRecord{Version: 1}, nil
}
func (s *stubBroker) AcquireLock(context.Context, string, string, int) (*RouteRefreshBrokerRecord, error) {
	if len(s.lockErrs) > 0 {
		err := s.lockErrs[0]
		s.lockErrs = s.lockErrs[1:]
		if err != nil {
			return nil, err
		}
	}
	if s.lockNil {
		return nil, nil
	}
	return &RouteRefreshBrokerRecord{Version: 2}, nil
}
func (s *stubBroker) CompareAndSwap(context.Context, *RouteRefreshBrokerRecord, int) (*RouteRefreshBrokerRecord, error) {
	if s.swapErr != nil {
		return nil, s.swapErr
	}
	return &RouteRefreshBrokerRecord{Version: 3}, nil
}
func (s *stubBroker) Revoke(context.Context, string) (*RouteRefreshBrokerRecord, error) {
	if s.revokeErr != nil {
		return nil, s.revokeErr
	}
	return &RouteRefreshBrokerRecord{Status: BrokerStatusRevoked}, nil
}

// notSeedableBroker is a broker store without the seeder capability.
type notSeedableBroker struct{}

func (notSeedableBroker) Get(context.Context, string) (*RouteRefreshBrokerRecord, error) {
	return nil, ErrBrokerNotFound
}
func (notSeedableBroker) AcquireLock(context.Context, string, string, int) (*RouteRefreshBrokerRecord, error) {
	return nil, ErrBrokerNotFound
}
func (notSeedableBroker) CompareAndSwap(context.Context, *RouteRefreshBrokerRecord, int) (*RouteRefreshBrokerRecord, error) {
	return nil, ErrBrokerNotFound
}
func (notSeedableBroker) Revoke(context.Context, string) (*RouteRefreshBrokerRecord, error) {
	return nil, ErrBrokerNotFound
}

// stubRateLimit is a rate-limit store whose results are scripted in order.
type stubRateLimit struct{ errs []error }

func (s *stubRateLimit) CheckAndIncrement(context.Context, RateLimitBucketKey) (RateLimitResult, error) {
	if len(s.errs) > 0 {
		err := s.errs[0]
		s.errs = s.errs[1:]
		if err != nil {
			return RateLimitResult{}, err
		}
	}
	return RateLimitResult{Allowed: true}, nil
}

// testStores bundles scripted stores, seeded with the shared clock.
func testStores(clock *ManualClock) Stores {
	return Stores{
		Transaction:        stubTransaction{},
		AuthorizationCode:  stubAuthCode{},
		Client:             &stubClient{},
		RouteRefreshBroker: &stubBroker{},
		RateLimit:          &stubRateLimit{},
	}
}

func TestLoadConformanceCasesEdges(t *testing.T) {
	if _, err := LoadConformanceCases(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("a missing fixture was accepted")
	}

	unparseable := filepath.Join(t.TempDir(), "unparseable.json")
	if err := os.WriteFile(unparseable, []byte("not json"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	if _, err := LoadConformanceCases(unparseable); err == nil {
		t.Fatal("an unparseable fixture was accepted")
	}

	empty := filepath.Join(t.TempDir(), "empty.json")
	if err := os.WriteFile(empty, []byte(`{"cases":[]}`), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	if _, err := LoadConformanceCases(empty); err == nil {
		t.Fatal("an empty fixture was accepted")
	}
}

func TestRunConformanceReportsUnsupportedScenario(t *testing.T) {
	clock := NewManualClock(ConformanceEpoch)
	tb := &recordingTB{TB: t}
	ran := RunConformance(tb, testStores(clock), []ConformanceCase{{ID: "bad", Scenario: "nope"}}, clock)
	if ran != 0 {
		t.Fatalf("RunConformance ran %d unsupported cases", ran)
	}
	if len(tb.reported) == 0 {
		t.Fatal("RunConformance did not report the unsupported scenario")
	}
}

func TestHarnessHelpersWithoutClock(t *testing.T) {
	harness := &conformanceHarness{tb: t}
	if harness.now().IsZero() {
		t.Fatal("a clock-less harness reported the zero instant")
	}
	harness.advance(0)
	harness.advance(10)

	testCase := ConformanceCase{ID: "case", Params: map[string]any{}, Expect: map[string]any{}}
	if got := harness.expiry(testCase); !got.IsZero() {
		t.Fatalf("expiry without ttl_seconds = %s", got)
	}
	if got := harness.seconds(testCase, "missing"); got != 0 {
		t.Fatalf("seconds(missing) = %s", got)
	}
	if got := harness.count(testCase, "missing"); got != 1 {
		t.Fatalf("count(missing) = %d", got)
	}
	if got := harness.key(testCase, ""); got != "case" {
		t.Fatalf("key(empty suffix) = %q", got)
	}

	withClock := &conformanceHarness{tb: t, clock: NewManualClock(ConformanceEpoch)}
	withClock.advance(-1)
	if got := withClock.seconds(ConformanceCase{Params: map[string]any{"ttl_seconds": float64(5)}}, "ttl_seconds"); got != 5*time.Second {
		t.Fatalf("seconds = %s", got)
	}
}

func TestConformanceScenarioErrorPaths(t *testing.T) {
	boom := errors.New("store boom")
	clock := NewManualClock(ConformanceEpoch)

	cases := []struct {
		name     string
		stores   Stores
		testCase ConformanceCase
	}{
		{"transaction_put", Stores{
			Transaction: stubTransaction{putErr: boom},
		}, ConformanceCase{ID: "tx", Scenario: "consume_single_use", Store: conformanceStoreTransaction}},
		{"code_put", Stores{
			AuthorizationCode: stubAuthCode{putErr: boom},
		}, ConformanceCase{ID: "code", Scenario: "consume_single_use_then_replay", Store: conformanceStoreAuthCode}},
		{"unknown_store", Stores{}, ConformanceCase{ID: "u", Scenario: "consume_unknown", Store: conformanceStoreClient}},
		{"after_ttl_transaction_put", Stores{
			Transaction: stubTransaction{putErr: boom},
		}, ConformanceCase{ID: "ttl-tx", Scenario: "consume_after_ttl", Store: conformanceStoreTransaction}},
		{"after_ttl_code_put", Stores{
			AuthorizationCode: stubAuthCode{putErr: boom},
		}, ConformanceCase{ID: "ttl-code", Scenario: "consume_after_ttl", Store: conformanceStoreAuthCode}},
		{"after_ttl_unknown_store", Stores{}, ConformanceCase{ID: "ttl-u", Scenario: "consume_after_ttl", Store: conformanceStoreClient}},
		{"concurrent_tx_put", Stores{
			Transaction: stubTransaction{putErr: boom},
		}, ConformanceCase{ID: "cc-tx", Scenario: "concurrent_consume", Store: conformanceStoreTransaction}},
		{"concurrent_code_put", Stores{
			AuthorizationCode: stubAuthCode{putErr: boom},
		}, ConformanceCase{ID: "cc-code", Scenario: "concurrent_consume", Store: conformanceStoreAuthCode}},
		{"concurrent_unknown_store", Stores{}, ConformanceCase{ID: "cc-u", Scenario: "concurrent_consume", Store: conformanceStoreClient}},
		{"get_unknown_unsupported", Stores{}, ConformanceCase{ID: "gu", Scenario: "get_unknown", Store: conformanceStoreTransaction}},
	}
	for _, entry := range cases {
		t.Run(entry.name, func(t *testing.T) {
			harness := &conformanceHarness{tb: t, stores: entry.stores, clock: clock}
			if _, err := harness.run(entry.testCase); err == nil {
				t.Fatalf("scenario %s unexpectedly succeeded", entry.testCase.Scenario)
			}
		})
	}
}

func TestConformanceClientScenarioErrorPaths(t *testing.T) {
	boom := errors.New("store boom")
	clock := NewManualClock(ConformanceEpoch)

	withClient := func(client ClientStore) func() Stores {
		return func() Stores {
			stores := testStores(clock)
			stores.Client = client
			return stores
		}
	}

	cases := []struct {
		name     string
		stores   func() Stores
		scenario string
		id       string
	}{
		{"put_get_update_put", withClient(&stubClient{putErr: boom}), "put_get_update", "pgu-put"},
		{"put_get_update_get", withClient(&stubClient{getErrs: []error{boom}}), "put_get_update", "pgu-get"},
		{"put_get_update_second_get", withClient(&stubClient{getErrs: []error{nil, boom}}), "put_get_update", "pgu-second-get"},
		{"stale_put", withClient(&stubClient{putErr: boom}), "update_stale_version", "stale-put"},
		{"stale_get", withClient(&stubClient{getErrs: []error{boom}}), "update_stale_version", "stale-get"},
		{"stale_first_update", withClient(&stubClient{updateErr: boom}), "update_stale_version", "stale-update"},
		{"stale_second_get", withClient(&stubClient{getErrs: []error{nil, boom}}), "update_stale_version", "stale-second-get"},
	}
	for _, entry := range cases {
		t.Run(entry.name, func(t *testing.T) {
			harness := &conformanceHarness{tb: t, stores: entry.stores(), clock: clock}
			if _, err := harness.run(ConformanceCase{
				ID:       entry.id,
				Scenario: entry.scenario,
				Store:    conformanceStoreClient,
			}); err == nil {
				t.Fatal("the client scenario unexpectedly succeeded")
			}
		})
	}
}

func TestConformanceBrokerScenarioErrorPaths(t *testing.T) {
	boom := errors.New("store boom")
	clock := NewManualClock(ConformanceEpoch)

	withBroker := func(broker RouteRefreshBrokerStore) func() Stores {
		return func() Stores {
			stores := testStores(clock)
			stores.RouteRefreshBroker = broker
			return stores
		}
	}

	cases := []struct {
		name     string
		stores   func() Stores
		scenario string
		id       string
	}{
		{"acquire_seed", withBroker(notSeedableBroker{}), "acquire_lock_exclusive_with_expiry", "a-seed"},
		{"acquire_first_get", withBroker(&stubBroker{getErrs: []error{boom}}), "acquire_lock_exclusive_with_expiry", "a-get1"},
		{"acquire_second_get", withBroker(&stubBroker{getErrs: []error{nil, boom}}), "acquire_lock_exclusive_with_expiry", "a-get2"},
		{"acquire_seed_swap", withBroker(notSeedableBroker{}), "compare_and_swap_versioned", "s-seed"},
		{"acquire_get_swap", withBroker(&stubBroker{getErrs: []error{boom}}), "compare_and_swap_versioned", "s-get"},
		{"acquire_lock_error", withBroker(&stubBroker{lockErrs: []error{boom}}), "compare_and_swap_versioned", "s-lock"},
		{"acquire_lock_nil", withBroker(&stubBroker{lockNil: true}), "compare_and_swap_versioned", "s-lock-nil"},
		{"revoke_seed", withBroker(notSeedableBroker{}), "revoke_idempotent", "r-seed"},
		{"revoke_get", withBroker(&stubBroker{getErrs: []error{boom}}), "revoke_idempotent", "r-get"},
		{"revoke_then_lock_seed", withBroker(notSeedableBroker{}), "revoke_then_lock", "rtl-seed"},
		{"revoke_then_lock_get", withBroker(&stubBroker{getErrs: []error{boom}}), "revoke_then_lock", "rtl-get"},
		{"concurrent_acquire_seed", withBroker(notSeedableBroker{}), "concurrent_acquire_lock", "ca-seed"},
		{"concurrent_acquire_get", withBroker(&stubBroker{getErrs: []error{boom}}), "concurrent_acquire_lock", "ca-get"},
		{"concurrent_revoke_seed", withBroker(notSeedableBroker{}), "concurrent_revoke", "cr-seed"},
	}
	for _, entry := range cases {
		t.Run(entry.name, func(t *testing.T) {
			harness := &conformanceHarness{tb: t, stores: entry.stores(), clock: clock}
			if _, err := harness.run(ConformanceCase{
				ID:       entry.id,
				Scenario: entry.scenario,
				Store:    conformanceStoreBroker,
			}); err == nil {
				t.Fatal("the broker scenario unexpectedly succeeded")
			}
		})
	}
}

func TestConformanceRateLimitErrorPaths(t *testing.T) {
	boom := errors.New("store boom")

	limitCases := []struct {
		name     string
		errs     []error
		scenario string
	}{
		{"check", []error{boom}, "check_and_increment"},
		{"window_first", []error{boom}, "window_reset"},
		{"window_second", []error{nil, boom}, "window_reset"},
		{"window_third", []error{nil, nil, boom}, "window_reset"},
	}
	for _, entry := range limitCases {
		t.Run(entry.name, func(t *testing.T) {
			stores := Stores{RateLimit: &stubRateLimit{errs: entry.errs}}
			harness := &conformanceHarness{tb: t, stores: stores, clock: NewManualClock(ConformanceEpoch)}
			if _, err := harness.run(ConformanceCase{
				ID:       entry.name,
				Scenario: entry.scenario,
				Store:    "rate_limit",
				Params:   map[string]any{"limit": float64(5), "checks": float64(2), "window_seconds": float64(60)},
			}); err == nil {
				t.Fatal("the rate-limit scenario unexpectedly succeeded")
			}
		})
	}
}

func TestOutcomeForUnknownError(t *testing.T) {
	if got := outcomeFor(errors.New("unmapped")); got != "error: unmapped" {
		t.Fatalf("outcomeFor(unknown) = %q", got)
	}
}

func TestAssertConformanceExpectationsReportsGaps(t *testing.T) {
	tb := &recordingTB{TB: t}
	assertConformanceExpectations(tb, ConformanceCase{
		ID:     "case",
		Expect: map[string]any{"missing": "x", "mismatch": float64(2)},
	}, map[string]any{"mismatch": float64(3)})
	if len(tb.reported) != 2 {
		t.Fatalf("reported %d expectations, want 2: %v", len(tb.reported), tb.reported)
	}
}

func TestConformanceScalarHelpers(t *testing.T) {
	if got, ok := conformanceNumber(json.Number("2.5")); !ok || got != 2.5 {
		t.Fatalf("conformanceNumber(json.Number) = %v %t", got, ok)
	}
	if _, ok := conformanceNumber(json.Number("bad")); ok {
		t.Fatal("a malformed json.Number was accepted")
	}
	if _, ok := conformanceNumber("text"); ok {
		t.Fatal("a string was accepted as a number")
	}
	if got, ok := conformanceNumber(int(3)); !ok || got != 3 {
		t.Fatalf("conformanceNumber(int) = %v %t", got, ok)
	}
	if got, ok := conformanceNumber(int64(4)); !ok || got != 4 {
		t.Fatalf("conformanceNumber(int64) = %v %t", got, ok)
	}
	if values, ok := conformanceStrings([]any{"a", "b"}); !ok || len(values) != 2 {
		t.Fatalf("conformanceStrings([]any) = %v %t", values, ok)
	}
	if _, ok := conformanceStrings([]any{"a", 1}); ok {
		t.Fatal("a non-string array entry was accepted")
	}
	if _, ok := conformanceStrings(42); ok {
		t.Fatal("an integer was accepted as a string list")
	}
}
