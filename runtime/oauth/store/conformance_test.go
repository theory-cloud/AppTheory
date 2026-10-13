package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

// storeConformanceFixture is the shared store conformance table. From
// runtime/oauth/store/ the repository root is three levels up.
const storeConformanceFixture = "../../../contract-tests/fixtures/routing/mcp-auth-facade/facade-store-conformance.v1.json"

// fixtureCaseCount is the case count the shared fixture must carry.
const fixtureCaseCount = 33

func newStores(clock *store.ManualClock) store.Stores {
	return store.Stores{
		Transaction: store.NewMemoryTransactionStore(store.TransactionStoreOptions{
			Now: clock.Now,
		}),
		AuthorizationCode: store.NewMemoryAuthorizationCodeStore(store.AuthorizationCodeStoreOptions{
			Now: clock.Now,
		}),
		Client: store.NewMemoryClientStore(store.ClientStoreOptions{
			Now: clock.Now,
		}),
		RouteRefreshBroker: store.NewMemoryRouteRefreshBrokerStore(store.RouteRefreshBrokerStoreOptions{
			Now: clock.Now,
			// The shared table's lock_ttl_seconds; the lock TTL is a store
			// option, not a per-call argument.
			LockTTL: 30 * time.Second,
		}),
		RateLimit: store.NewMemoryRateLimitStore(store.RateLimitStoreOptions{
			Now: clock.Now,
		}),
	}
}

// TestStoreConformance runs the shared store conformance table against the
// in-memory reference stores and asserts the whole table ran.
func TestStoreConformance(t *testing.T) {
	cases, err := store.LoadConformanceCases(storeConformanceFixture)
	if err != nil {
		t.Fatalf("load store conformance fixture: %v", err)
	}
	if len(cases) != fixtureCaseCount {
		t.Fatalf("store conformance fixture case count = %d, want %d", len(cases), fixtureCaseCount)
	}

	clock := store.NewManualClock(store.ConformanceEpoch)
	ran := store.RunConformance(t, newStores(clock), cases, clock)
	if ran != fixtureCaseCount {
		t.Fatalf("store conformance runner executed %d cases, want %d", ran, fixtureCaseCount)
	}
	t.Logf("store conformance: ran %d of %d fixture cases", ran, len(cases))
}

func TestManualClockSetAndAdvance(t *testing.T) {
	start := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	clock := store.NewManualClock(start)
	if got := clock.Now(); !got.Equal(start) {
		t.Fatalf("clock.Now() = %s, want %s", got, start)
	}
	clock.Advance(90 * time.Second)
	if got := clock.Now(); !got.Equal(start.Add(90 * time.Second)) {
		t.Fatalf("clock after advance = %s, want %s", got, start.Add(90*time.Second))
	}
	clock.Set(start)
	if got := clock.Now(); !got.Equal(start) {
		t.Fatalf("clock after set = %s, want %s", got, start)
	}
}

func TestTransactionStoreConsumeSemantics(t *testing.T) {
	ctx := context.Background()
	clock := store.NewManualClock(store.ConformanceEpoch)
	transactions := store.NewMemoryTransactionStore(store.TransactionStoreOptions{Now: clock.Now, TTL: 10 * time.Minute})

	if _, err := transactions.Consume(ctx, "  "); !errors.Is(err, store.ErrTransactionNotFound) {
		t.Fatalf("blank key consume error = %v, want ErrTransactionNotFound", err)
	}

	record := &store.TransactionRecord{StateHash: "state-1", ClientID: "client-1"}
	if err := transactions.Put(ctx, record); err != nil {
		t.Fatalf("put: %v", err)
	}
	if record.Version != 1 || record.ExpiresAt.IsZero() {
		t.Fatalf("put did not normalize the record: %+v", record)
	}

	clock.Advance(11 * time.Minute)
	if _, err := transactions.Consume(ctx, "state-1"); !errors.Is(err, store.ErrTransactionExpired) {
		t.Fatalf("expired consume error = %v, want ErrTransactionExpired", err)
	}
	if _, err := transactions.Consume(ctx, "state-1"); !errors.Is(err, store.ErrTransactionNotFound) {
		t.Fatalf("second consume error = %v, want ErrTransactionNotFound (burned)", err)
	}
}

func TestAuthorizationCodeStoreReplayIsDistinguishable(t *testing.T) {
	ctx := context.Background()
	clock := store.NewManualClock(store.ConformanceEpoch)
	codes := store.NewMemoryAuthorizationCodeStore(store.AuthorizationCodeStoreOptions{Now: clock.Now})

	if err := codes.Put(ctx, &store.AuthorizationCodeRecord{CodeHash: "code-1", ClientID: "client-1"}); err != nil {
		t.Fatalf("put: %v", err)
	}
	first, err := codes.Consume(ctx, "code-1")
	if err != nil {
		t.Fatalf("first consume: %v", err)
	}
	if first.CodeHash != "code-1" {
		t.Fatalf("first consume record = %+v", first)
	}

	retained, err := codes.Consume(ctx, "code-1")
	if !errors.Is(err, store.ErrAuthorizationCodeReplayed) {
		t.Fatalf("replay error = %v, want ErrAuthorizationCodeReplayed", err)
	}
	if retained == nil || retained.CodeHash != "code-1" {
		t.Fatalf("replay did not return the retained record: %+v", retained)
	}
	if errors.Is(err, store.ErrAuthorizationCodeNotFound) {
		t.Fatal("replay must be distinguishable from an unknown code")
	}

	if _, err := codes.Consume(ctx, "code-unknown"); !errors.Is(err, store.ErrAuthorizationCodeNotFound) {
		t.Fatalf("unknown code error = %v, want ErrAuthorizationCodeNotFound", err)
	}
}

func TestClientStoreUpdateIsCompareAndSwap(t *testing.T) {
	ctx := context.Background()
	clock := store.NewManualClock(store.ConformanceEpoch)
	clients := store.NewMemoryClientStore(store.ClientStoreOptions{Now: clock.Now})

	if err := clients.Put(ctx, &store.ClientRecord{ClientIDHash: "client-hash", ClientID: "client-1"}); err != nil {
		t.Fatalf("put: %v", err)
	}
	stored, err := clients.Get(ctx, "client-hash")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Version != 1 {
		t.Fatalf("version after put = %d, want 1", stored.Version)
	}

	if _, updateErr := clients.Update(ctx, stored, stored.Version); updateErr != nil {
		t.Fatalf("first update: %v", updateErr)
	}
	if _, staleErr := clients.Update(ctx, stored, stored.Version); !errors.Is(staleErr, store.ErrClientVersionConflict) {
		t.Fatalf("stale update error = %v, want ErrClientVersionConflict", staleErr)
	}

	updated, err := clients.Get(ctx, "client-hash")
	if err != nil {
		t.Fatalf("get after update: %v", err)
	}
	if updated.Version != 2 {
		t.Fatalf("version after update = %d, want 2", updated.Version)
	}
	if _, err := clients.Get(ctx, "missing"); !errors.Is(err, store.ErrClientNotFound) {
		t.Fatalf("unknown client error = %v, want ErrClientNotFound", err)
	}
}

func TestRouteRefreshBrokerStoreLockAndRevocation(t *testing.T) {
	ctx := context.Background()
	clock := store.NewManualClock(store.ConformanceEpoch)
	brokers := store.NewMemoryRouteRefreshBrokerStore(store.RouteRefreshBrokerStoreOptions{
		Now:     clock.Now,
		LockTTL: 30 * time.Second,
	})

	if err := brokers.Put(ctx, &store.RouteRefreshBrokerRecord{HandleHash: "handle-1", Status: store.BrokerStatusActive}); err != nil {
		t.Fatalf("put: %v", err)
	}

	locked, err := brokers.AcquireLock(ctx, "handle-1", "owner-1", 1)
	if err != nil {
		t.Fatalf("acquire lock: %v", err)
	}
	if locked.Version != 2 || locked.RefreshLockOwner != "owner-1" {
		t.Fatalf("locked record = %+v", locked)
	}
	if _, lockErr := brokers.AcquireLock(ctx, "handle-1", "owner-2", 1); !errors.Is(lockErr, store.ErrBrokerLocked) {
		t.Fatalf("contended lock error = %v, want ErrBrokerLocked", lockErr)
	}

	clock.Advance(31 * time.Second)
	if _, reacquireErr := brokers.AcquireLock(ctx, "handle-1", "owner-2", locked.Version); reacquireErr != nil {
		t.Fatalf("re-acquire after lock expiry: %v", reacquireErr)
	}

	if _, swapErr := brokers.CompareAndSwap(ctx, locked, locked.Version); !errors.Is(swapErr, store.ErrBrokerVersionConflict) {
		t.Fatalf("stale swap error = %v, want ErrBrokerVersionConflict", swapErr)
	}

	revoked, err := brokers.Revoke(ctx, "handle-1")
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if revoked.Status != store.BrokerStatusRevoked {
		t.Fatalf("revoked status = %q, want %q", revoked.Status, store.BrokerStatusRevoked)
	}
	if _, revokeErr := brokers.Revoke(ctx, "handle-1"); revokeErr != nil {
		t.Fatalf("idempotent revoke: %v", revokeErr)
	}
	stored, err := brokers.Get(ctx, "handle-1")
	if err != nil {
		t.Fatalf("get revoked: %v", err)
	}
	if stored.Status != store.BrokerStatusRevoked {
		t.Fatalf("get after revoke status = %q, want revoked", stored.Status)
	}
	if _, err := brokers.AcquireLock(ctx, "handle-1", "owner-3", -1); !errors.Is(err, store.ErrBrokerRevoked) {
		t.Fatalf("lock on revoked record error = %v, want ErrBrokerRevoked", err)
	}
	if _, err := brokers.CompareAndSwap(ctx, stored, stored.Version); !errors.Is(err, store.ErrBrokerRevoked) {
		t.Fatalf("swap on revoked record error = %v, want ErrBrokerRevoked", err)
	}
	if _, err := brokers.Get(ctx, "missing"); !errors.Is(err, store.ErrBrokerNotFound) {
		t.Fatalf("unknown handle error = %v, want ErrBrokerNotFound", err)
	}
}

// TestRouteRefreshBrokerTTLBoundary pins the broker's local lifetime policy at
// nanosecond resolution on the injected clock: a record is live one nanosecond
// before its TTL and absent at and after it.
func TestRouteRefreshBrokerTTLBoundary(t *testing.T) {
	ctx := context.Background()
	clock := store.NewManualClock(store.ConformanceEpoch)
	brokers := store.NewMemoryRouteRefreshBrokerStore(store.RouteRefreshBrokerStoreOptions{
		Now: clock.Now,
		TTL: time.Second,
	})

	for _, handle := range []string{"handle-boundary", "handle-past"} {
		if err := brokers.Put(ctx, &store.RouteRefreshBrokerRecord{HandleHash: handle, Status: store.BrokerStatusActive}); err != nil {
			t.Fatalf("put %s: %v", handle, err)
		}
	}
	storedAt := clock.Now()

	clock.Set(storedAt.Add(time.Second - time.Nanosecond))
	if _, err := brokers.Get(ctx, "handle-boundary"); err != nil {
		t.Fatalf("get one nanosecond before the TTL = %v, want success", err)
	}

	clock.Set(storedAt.Add(time.Second))
	if _, err := brokers.Get(ctx, "handle-boundary"); !errors.Is(err, store.ErrBrokerNotFound) {
		t.Fatalf("get at the TTL = %v, want ErrBrokerNotFound", err)
	}

	clock.Set(storedAt.Add(time.Second + time.Nanosecond))
	if _, err := brokers.Get(ctx, "handle-past"); !errors.Is(err, store.ErrBrokerNotFound) {
		t.Fatalf("get one nanosecond past the TTL = %v, want ErrBrokerNotFound", err)
	}
}

// TestReferenceStoresDeepCopySlices pins that a slice a reference store hands
// out (and the slice a caller hands in) is never the stored slice: mutating one
// cannot reach the other, so an application cannot corrupt retained state.
func TestReferenceStoresDeepCopySlices(t *testing.T) {
	ctx := context.Background()
	clock := store.NewManualClock(store.ConformanceEpoch)

	t.Run("transaction", func(t *testing.T) {
		transactions := store.NewMemoryTransactionStore(store.TransactionStoreOptions{Now: clock.Now})
		record := &store.TransactionRecord{StateHash: "alias-tx", Scopes: []string{"scope-a"}}
		if err := transactions.Put(ctx, record); err != nil {
			t.Fatalf("put: %v", err)
		}
		record.Scopes[0] = "mutated-caller"
		consumed, err := transactions.Consume(ctx, "alias-tx")
		if err != nil {
			t.Fatalf("consume: %v", err)
		}
		if got := consumed.Scopes[0]; got != "scope-a" {
			t.Fatalf("stored scopes aliased the caller: got %q, want %q", got, "scope-a")
		}
	})

	t.Run("authorization_code", func(t *testing.T) {
		codes := store.NewMemoryAuthorizationCodeStore(store.AuthorizationCodeStoreOptions{Now: clock.Now})
		record := &store.AuthorizationCodeRecord{CodeHash: "alias-code", Scopes: []string{"scope-a"}}
		if err := codes.Put(ctx, record); err != nil {
			t.Fatalf("put: %v", err)
		}
		record.Scopes[0] = "mutated-caller"
		first, err := codes.Consume(ctx, "alias-code")
		if err != nil {
			t.Fatalf("consume: %v", err)
		}
		if got := first.Scopes[0]; got != "scope-a" {
			t.Fatalf("stored scopes aliased the caller: got %q", got)
		}
		first.Scopes[0] = "mutated-returned"
		replayed, err := codes.Consume(ctx, "alias-code")
		if !errors.Is(err, store.ErrAuthorizationCodeReplayed) {
			t.Fatalf("second consume error = %v, want ErrAuthorizationCodeReplayed", err)
		}
		if got := replayed.Scopes[0]; got != "scope-a" {
			t.Fatalf("stored scopes aliased a returned copy: got %q", got)
		}
	})

	t.Run("client", func(t *testing.T) {
		clients := store.NewMemoryClientStore(store.ClientStoreOptions{Now: clock.Now})
		record := &store.ClientRecord{
			ClientIDHash:  "alias-client",
			RedirectURIs:  []string{"https://a.example.test/cb"},
			GrantTypes:    []string{"authorization_code"},
			ResponseTypes: []string{"code"},
		}
		if err := clients.Put(ctx, record); err != nil {
			t.Fatalf("put: %v", err)
		}
		record.RedirectURIs[0] = "mutated-caller"
		stored, err := clients.Get(ctx, "alias-client")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		if got := stored.RedirectURIs[0]; got != "https://a.example.test/cb" {
			t.Fatalf("stored redirect uris aliased the caller: got %q", got)
		}
		stored.RedirectURIs[0] = "mutated-returned"
		stored.GrantTypes[0] = "mutated-returned"
		stored.ResponseTypes[0] = "mutated-returned"
		again, err := clients.Get(ctx, "alias-client")
		if err != nil {
			t.Fatalf("get again: %v", err)
		}
		if again.RedirectURIs[0] != "https://a.example.test/cb" ||
			again.GrantTypes[0] != "authorization_code" ||
			again.ResponseTypes[0] != "code" {
			t.Fatalf("stored client aliased a returned copy: %+v", again)
		}
	})

	t.Run("route_refresh_broker", func(t *testing.T) {
		brokers := store.NewMemoryRouteRefreshBrokerStore(store.RouteRefreshBrokerStoreOptions{Now: clock.Now})
		record := &store.RouteRefreshBrokerRecord{
			HandleHash: "alias-broker",
			Status:     store.BrokerStatusActive,
			Scopes:     []string{"scope-a"},
		}
		if err := brokers.Put(ctx, record); err != nil {
			t.Fatalf("put: %v", err)
		}
		record.Scopes[0] = "mutated-caller"
		stored, err := brokers.Get(ctx, "alias-broker")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		if got := stored.Scopes[0]; got != "scope-a" {
			t.Fatalf("stored scopes aliased the caller: got %q", got)
		}
		stored.Scopes[0] = "mutated-returned"
		again, err := brokers.Get(ctx, "alias-broker")
		if err != nil {
			t.Fatalf("get again: %v", err)
		}
		if got := again.Scopes[0]; got != "scope-a" {
			t.Fatalf("stored scopes aliased a returned copy: got %q", got)
		}
	})
}

func TestRateLimitStoreWindowAndBudget(t *testing.T) {
	ctx := context.Background()
	clock := store.NewManualClock(store.ConformanceEpoch)
	limits := store.NewMemoryRateLimitStore(store.RateLimitStoreOptions{Now: clock.Now, Window: time.Minute})

	key := store.RateLimitBucketKey{Identifier: "client-1", Resource: "https://mcp.example.test/mcp", Operation: "dcr", Limit: 2}
	first, err := limits.CheckAndIncrement(ctx, key)
	if err != nil {
		t.Fatalf("first check: %v", err)
	}
	if !first.Allowed || first.Remaining != 1 {
		t.Fatalf("first check = %+v, want allowed with 1 remaining", first)
	}
	if _, checkErr := limits.CheckAndIncrement(ctx, key); checkErr != nil {
		t.Fatalf("second check: %v", checkErr)
	}
	third, err := limits.CheckAndIncrement(ctx, key)
	if err != nil {
		t.Fatalf("third check: %v", err)
	}
	if third.Allowed || third.Remaining != 0 {
		t.Fatalf("third check = %+v, want limited", third)
	}

	clock.Advance(61 * time.Second)
	afterWindow, err := limits.CheckAndIncrement(ctx, key)
	if err != nil {
		t.Fatalf("post-window check: %v", err)
	}
	if !afterWindow.Allowed {
		t.Fatalf("post-window check = %+v, want allowed", afterWindow)
	}

	if _, err := limits.CheckAndIncrement(ctx, store.RateLimitBucketKey{Resource: "r", Operation: "o", Limit: 1}); !errors.Is(err, store.ErrRecordKeyRequired) {
		t.Fatalf("blank identifier error = %v, want ErrRecordKeyRequired", err)
	}
}
