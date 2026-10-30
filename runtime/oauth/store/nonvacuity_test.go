package store_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

// Non-vacuity negative controls for the shared store conformance table. Each
// broken bundle below breaks exactly one store semantic the table pins; the
// matching test proves the table reports a failure, so a row that only ever
// passes because the reference store happens to be correct cannot go silent.

// nonTerminalCodeStore is a deliberately-broken AuthorizationCodeStore: a
// replayed or expired-burned consume is reported as a fresh success instead of
// a terminal replay/expired outcome.
type nonTerminalCodeStore struct {
	store.AuthorizationCodeStore
}

// Consume reports a replay or an expired burn as (record, nil), so a later
// consume looks fresh/consumable rather than terminal.
func (s nonTerminalCodeStore) Consume(
	ctx context.Context,
	codeHash string,
) (*store.AuthorizationCodeRecord, error) {
	record, err := s.AuthorizationCodeStore.Consume(ctx, codeHash)
	if errors.Is(err, store.ErrAuthorizationCodeReplayed) ||
		errors.Is(err, store.ErrAuthorizationCodeExpired) {
		return record, nil
	}
	return record, err
}

// nonBumpingBrokerStore is a deliberately-broken RouteRefreshBrokerStore: the
// wrapped reference store bumps every version, but this wrapper's read reports a
// revoked or refreshing record one version lower, erasing the delta a lock or a
// revoke is required to leave behind. The seeder embed keeps the conformance
// harness's seed path working through the wrapper.
type nonBumpingBrokerStore struct {
	store.RouteRefreshBrokerStore
	store.RouteRefreshBrokerSeeder
	store.RouteRefreshBrokerTransactionalFamilyStore
}

// Get hides the version bump a lock or revoke advanced on a record that is now
// refreshing or revoked, so a caller reading the version back observes 0 delta.
func (s nonBumpingBrokerStore) Get(
	ctx context.Context,
	handleHash string,
) (*store.RouteRefreshBrokerRecord, error) {
	record, err := s.RouteRefreshBrokerStore.Get(ctx, handleHash)
	if err != nil || record == nil {
		return record, err
	}
	if record.Status == store.BrokerStatusRevoked || record.Status == store.BrokerStatusRefreshing {
		record.Version--
	}
	return record, nil
}

// nonTombstoneBrokerStore revokes members individually and never writes the
// family tombstone, so a re-created family ID is not refused.
type nonTombstoneBrokerStore struct {
	*store.MemoryRouteRefreshBrokerStore
}

func (s nonTombstoneBrokerStore) RevokeFamily(
	ctx context.Context,
	familyHash string,
) ([]*store.RouteRefreshBrokerRecord, error) {
	records, err := s.ListFamily(ctx, familyHash)
	if err != nil {
		return nil, err
	}
	revoked := make([]*store.RouteRefreshBrokerRecord, 0, len(records))
	for _, record := range records {
		updated, revokeErr := s.Revoke(ctx, record.HandleHash)
		if revokeErr != nil {
			return nil, revokeErr
		}
		revoked = append(revoked, updated)
	}
	return revoked, nil
}

// nonAtomicRotateBrokerStore returns a successor without storing it or updating
// the predecessor, so a rotation can hand out a handle nothing can revoke.
type nonAtomicRotateBrokerStore struct {
	*store.MemoryRouteRefreshBrokerStore
}

func (s nonAtomicRotateBrokerStore) RotateFamily(
	_ context.Context,
	rotation store.RouteRefreshFamilyRotation,
) (*store.RouteRefreshBrokerRecord, error) {
	if rotation.Successor == nil {
		return nil, store.ErrRecordKeyRequired
	}
	return rotation.Successor, nil
}

// conformanceRecorder captures the failures RunConformance reports instead of
// failing a real test, so one broken bundle can be run and inspected. Only
// Helper and Errorf are ever called by the runner.
type conformanceRecorder struct {
	testing.TB
	failures []string
}

func (r *conformanceRecorder) Helper() {}

func (r *conformanceRecorder) Errorf(format string, args ...any) {
	r.failures = append(r.failures, fmt.Sprintf(format, args...))
}

// conformanceFixtureCases loads the shared table, which every control reuses.
func conformanceFixtureCases(tb testing.TB) []store.ConformanceCase {
	tb.Helper()
	cases, err := store.LoadConformanceCases(storeConformanceFixture)
	if err != nil {
		tb.Fatalf("load store conformance fixture: %v", err)
	}
	if len(cases) != fixtureCaseCount {
		tb.Fatalf("store conformance fixture case count = %d, want %d", len(cases), fixtureCaseCount)
	}
	return cases
}

// newTTLIgnoringBrokerStores builds the reference bundle with a broker whose
// handle lifetime is far longer than the table's own TTL, so an aged-out handle
// is still returned.
func newTTLIgnoringBrokerStores(clock *store.ManualClock) store.Stores {
	stores := newStores(clock)
	stores.RouteRefreshBroker = store.NewMemoryRouteRefreshBrokerStore(store.RouteRefreshBrokerStoreOptions{
		Now: clock.Now,
		// The table's mandated lock TTL: the broken bundle must break exactly one
		// semantic (the handle lifetime), not the lock.
		LockTTL: store.DefaultRouteRefreshLockTTL,
		TTL:     100 * time.Hour,
	})
	return stores
}

// nonBumpingBrokerStores wraps the reference broker so its version bumps on a
// lock or a revoke are invisible to a read.
func nonBumpingBrokerStores(clock *store.ManualClock) store.Stores {
	stores := newStores(clock)
	real, ok := stores.RouteRefreshBroker.(*store.MemoryRouteRefreshBrokerStore)
	if !ok {
		panic(fmt.Sprintf("reference broker type = %T, want *store.MemoryRouteRefreshBrokerStore", stores.RouteRefreshBroker))
	}
	stores.RouteRefreshBroker = nonBumpingBrokerStore{
		RouteRefreshBrokerStore:                    real,
		RouteRefreshBrokerSeeder:                   real,
		RouteRefreshBrokerTransactionalFamilyStore: real,
	}
	return stores
}

// nonTombstoneBrokerStores wraps the reference broker so a family revocation
// revokes members individually and leaves no tombstone behind.
func nonTombstoneBrokerStores(clock *store.ManualClock) store.Stores {
	stores := newStores(clock)
	real, ok := stores.RouteRefreshBroker.(*store.MemoryRouteRefreshBrokerStore)
	if !ok {
		panic(fmt.Sprintf("reference broker type = %T, want *store.MemoryRouteRefreshBrokerStore", stores.RouteRefreshBroker))
	}
	stores.RouteRefreshBroker = nonTombstoneBrokerStore{MemoryRouteRefreshBrokerStore: real}
	return stores
}

// nonAtomicRotateBrokerStores wraps the reference broker so a rotation returns a
// successor without storing it or updating the predecessor.
func nonAtomicRotateBrokerStores(clock *store.ManualClock) store.Stores {
	stores := newStores(clock)
	real, ok := stores.RouteRefreshBroker.(*store.MemoryRouteRefreshBrokerStore)
	if !ok {
		panic(fmt.Sprintf("reference broker type = %T, want *store.MemoryRouteRefreshBrokerStore", stores.RouteRefreshBroker))
	}
	stores.RouteRefreshBroker = nonAtomicRotateBrokerStore{MemoryRouteRefreshBrokerStore: real}
	return stores
}

// TestStoreConformanceBaselineHasNoFailures pins the control's other half: the
// unmodified reference bundle must report zero failures, so a failure count for
// a broken bundle is evidence about the break, not about the recorder.
func TestStoreConformanceBaselineHasNoFailures(t *testing.T) {
	cases := conformanceFixtureCases(t)
	clock := store.NewManualClock(store.ConformanceEpoch)
	recorder := &conformanceRecorder{}

	ran := store.RunConformance(recorder, newStores(clock), cases, clock)
	if ran != len(cases) {
		t.Fatalf("good baseline ran %d of %d cases", ran, len(cases))
	}
	if len(recorder.failures) != 0 {
		t.Fatalf("good baseline reported %d failure(s):\n%s", len(recorder.failures), strings.Join(recorder.failures, "\n"))
	}
}

// TestStoreConformanceFailsBrokenStores proves the table is non-vacuous for each
// new store semantic: one deliberately-broken store per bundle must produce at
// least one reported failure, and the rows that pin the broken semantic must be
// among them.
func TestStoreConformanceFailsBrokenStores(t *testing.T) {
	cases := conformanceFixtureCases(t)

	tests := []struct {
		name         string
		stores       func(clock *store.ManualClock) store.Stores
		wantFailures []string
	}{
		{
			name: "non_terminal_code",
			stores: func(clock *store.ManualClock) store.Stores {
				broken := newStores(clock)
				broken.AuthorizationCode = nonTerminalCodeStore{broken.AuthorizationCode}
				return broken
			},
			wantFailures: []string{
				"store.authorization_code.consume_is_single_use_then_replayed",
				"store.authorization_code.expired_consume_then_replay",
				"store.authorization_code.clock_back_after_consume_is_replayed",
				"store.authorization_code.clock_back_after_expired_burn_is_replayed",
			},
		},
		{
			name:   "ttl_ignoring_broker",
			stores: newTTLIgnoringBrokerStores,
			wantFailures: []string{
				"store.route_refresh_broker.record_expired_at_ttl_boundary",
				"store.route_refresh_broker.expired_record_refuses_lock",
				"store.route_refresh_broker.expired_record_refuses_swap",
			},
		},
		{
			name:   "non_bumping_broker",
			stores: nonBumpingBrokerStores,
			wantFailures: []string{
				"store.route_refresh_broker.acquire_lock_bumps_version",
				"store.route_refresh_broker.revoke_bumps_version",
			},
		},
		{
			name:   "non_tombstone_broker",
			stores: nonTombstoneBrokerStores,
			wantFailures: []string{
				"store.route_refresh_broker.family_tombstone_revokes_more_than_eight_members",
				"store.route_refresh_broker.family_tombstone_covers_more_than_one_hundred_members",
			},
		},
		{
			name:   "non_atomic_rotate_broker",
			stores: nonAtomicRotateBrokerStores,
			wantFailures: []string{
				"store.route_refresh_broker.family_rotate_is_atomic",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			clock := store.NewManualClock(store.ConformanceEpoch)
			recorder := &conformanceRecorder{}
			store.RunConformance(recorder, test.stores(clock), cases, clock)

			if len(recorder.failures) == 0 {
				t.Fatalf("%s: the conformance table reported no failures against a broken store", test.name)
			}
			reported := strings.Join(recorder.failures, "\n")
			for _, want := range test.wantFailures {
				if !strings.Contains(reported, want) {
					t.Errorf("%s: expected row %s to fail; reported failures:\n%s", test.name, want, reported)
				}
			}
			t.Logf("%s: %d failing row(s):\n%s", test.name, len(recorder.failures), reported)
		})
	}
}
