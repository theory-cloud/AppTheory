package mcpfacade

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
)

// TestRefreshSweeperDefersOnStoreFailures pins the fail-transient posture of every
// family-capability failure: an unreadable family, an unwritable rotation intent,
// and an unclassifiable commit lose are deferred ticks, never errors and never
// family events.
func TestRefreshSweeperDefersOnStoreFailures(t *testing.T) {
	unreadable := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, unreadable)
	familyHash := brokerRecord(t, unreadable, handle).FamilyHash
	unreadable.broker.listFamilyErr = oauthstore.ErrBrokerFamilyStateUnavailable

	result, err := newSweeperForHarness(t, unreadable, nil).SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepDeferred, result.Outcome)
	require.Equal(t, RouteRefreshReasonFamilyStateUnavailable, result.DeferredReason)
	requireFamilyActive(t, unreadable, handle)

	unwritable := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle = mintedRefreshHandle(t, unwritable)
	familyHash = brokerRecord(t, unwritable, handle).FamilyHash
	unwritable.broker.compareAndSwapErr = errors.New("store unavailable")

	result, err = newSweeperForHarness(t, unwritable, nil).SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepDeferred, result.Outcome)
	require.Equal(t, RouteRefreshReasonRewriteFailure, result.DeferredReason)
	requireFamilyActive(t, unwritable, handle)
	// The release is best effort and shares the store that just failed, so the lock
	// is left to expire: the next tick defers on it rather than double-writing.
	require.NotEmpty(t, brokerRecord(t, unwritable, handle).RefreshLockOwner)

	uncommittable := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle = mintedRefreshHandle(t, uncommittable)
	familyHash = brokerRecord(t, uncommittable, handle).FamilyHash
	uncommittable.broker.rotateFamilyErr = errors.New("transaction unavailable")

	result, err = newSweeperForHarness(t, uncommittable, nil).SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepDeferred, result.Outcome)
	require.Equal(t, RouteRefreshReasonRewriteFailure, result.DeferredReason)
	requireFamilyActive(t, uncommittable, handle)
}

// TestRefreshSweeperClassifiesFamilyStates pins the outcomes that are not races: a
// tombstoned family and a family with no live head are reported as such, and a
// revoked commit race resolves to the tombstone outcome rather than a deferral.
func TestRefreshSweeperClassifiesFamilyStates(t *testing.T) {
	revoked := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, revoked)
	familyHash := brokerRecord(t, revoked, handle).FamilyHash
	familyStore, ok := revoked.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	require.True(t, ok)
	_, err := familyStore.RevokeFamily(context.Background(), familyHash)
	require.NoError(t, err)

	result, err := newSweeperForHarness(t, revoked, nil).SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepRevokedFamily, result.Outcome)

	noHead := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle = mintedRefreshHandle(t, noHead)
	record := brokerRecord(t, noHead, handle)
	record.GraceExpiresAt = noHead.clock.Now().Add(time.Minute)
	_, err = noHead.stores.RouteRefreshBroker.CompareAndSwap(context.Background(), record, record.Version)
	require.NoError(t, err)

	result, err = newSweeperForHarness(t, noHead, nil).SweepFamily(context.Background(), record.FamilyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepNoLiveHead, result.Outcome)

	revokedCommit := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle = mintedRefreshHandle(t, revokedCommit)
	familyHash = brokerRecord(t, revokedCommit, handle).FamilyHash
	revokedCommit.broker.rotateFamilyErr = oauthstore.ErrBrokerRevoked

	result, err = newSweeperForHarness(t, revokedCommit, nil).SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepRevokedFamily, result.Outcome)
}

// TestRefreshSweeperClassifiesLockFailures pins the lock-race taxonomy the
// concurrency contract names: contention defers, and a store that cannot answer
// defers with the store reason instead of failing the caller.
func TestRefreshSweeperClassifiesLockFailures(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		err    error
		want   RefreshSweepOutcome
		reason string
	}{
		{"family_state", oauthstore.ErrBrokerFamilyStateUnavailable, RefreshSweepDeferred, RouteRefreshReasonFamilyStateUnavailable},
		{"store", errors.New("store unavailable"), RefreshSweepDeferred, RouteRefreshReasonStoreFailure},
		{"not_found", oauthstore.ErrBrokerNotFound, RefreshSweepNoLiveHead, ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
			handle := mintedRefreshHandle(t, harness)
			familyHash := brokerRecord(t, harness, handle).FamilyHash
			harness.broker.acquireLockFn = func(context.Context, string, string, int) (*oauthstore.RouteRefreshBrokerRecord, error) {
				return nil, testCase.err
			}
			result, err := newSweeperForHarness(t, harness, nil).SweepFamily(context.Background(), familyHash)
			require.NoError(t, err)
			require.Equal(t, testCase.want, result.Outcome)
			require.Equal(t, testCase.reason, result.DeferredReason)
			requireFamilyActive(t, harness, handle)
		})
	}
}

// TestRefreshSweeperUpstreamFailureIsDeferred pins the transient upstream path: a
// 503 keeps the family, releases the lock, and leaves the intent marker so the
// next request-path attempt verifies lineage.
func TestRefreshSweeperUpstreamFailureIsDeferred(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	familyHash := brokerRecord(t, harness, handle).FamilyHash
	harness.scriptRefresh(func(context.Context) (*oauth.TokenSet, error) {
		return nil, oauth.NewProviderError(oauth.ProviderTemporarilyUnavailable, "refresh", "upstream busy")
	})

	result, err := newSweeperForHarness(t, harness, nil).SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepDeferred, result.Outcome)
	require.Equal(t, RouteRefreshReasonUpstreamRejected, result.DeferredReason)
	require.Equal(t, string(oauth.ProviderTemporarilyUnavailable), result.UpstreamClass)
	record := brokerRecord(t, harness, handle)
	require.False(t, record.RotationUnconfirmedAt.IsZero())
	require.Empty(t, record.RefreshLockOwner)
	requireFamilyActive(t, harness, handle)
}

// TestRefreshGrantUnverifiedFamilyNeverRevokes pins the fail-closed half of the
// terminal gate: when the family cannot be read, an invalid_grant is not evidence
// and the verdict is transient.
func TestRefreshGrantUnverifiedFamilyNeverRevokes(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	harness.scriptRefresh(func(context.Context) (*oauth.TokenSet, error) {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "refresh", "grant rejected")
	})
	harness.broker.listFamilyErr = oauthstore.ErrBrokerFamilyStateUnavailable

	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 503, response.Status)
	requireFamilyActive(t, harness, handle)
}

// TestRefreshGrantFailedRevocationIsTransient pins the other fail-closed half: a
// family tombstone that cannot be written must not leave the client holding a
// handle the facade still believes is live, so the answer is retryable.
func TestRefreshGrantFailedRevocationIsTransient(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	harness.scriptRefresh(func(context.Context) (*oauth.TokenSet, error) {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "refresh", "grant rejected")
	})
	harness.broker.revokeFamilyErr = errors.New("families unavailable")

	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 503, response.Status)
	requireFamilyActive(t, harness, handle)
}

// TestRefreshGrantAlreadyRevokedFamilyAnswersTerminally pins the idempotent
// terminal answer: a verdict about an already-tombstoned family is the uniform
// invalid_grant and emits no second revocation.
func TestRefreshGrantAlreadyRevokedFamilyAnswersTerminally(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	familyHash := brokerRecord(t, harness, handle).FamilyHash
	familyStore, ok := harness.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	require.True(t, ok)
	_, err := familyStore.RevokeFamily(context.Background(), familyHash)
	require.NoError(t, err)

	// The request path refuses a tombstoned record before it ever reaches the
	// terminal classifier, which is the same uniform answer.
	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, response.Status)
	require.Contains(t, string(response.Body), `"error":"invalid_grant"`)
}

// TestRefreshGrantIntentWriteFailureIsTransient pins the read-side twin of
// persist-before-ack: when the rotation intent cannot be written, no upstream
// material is presented and the caller is told to retry.
func TestRefreshGrantIntentWriteFailureIsTransient(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	harness.broker.compareAndSwapErr = errors.New("store unavailable")

	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 503, response.Status)
	require.Equal(t, 0, harness.fake.RefreshCallCount(),
		"the facade must not present upstream material it could not record an attempt for")
	requireFamilyActive(t, harness, handle)
	// The release shares the store that just failed, so the lock expires on its own.
	require.NotEmpty(t, brokerRecord(t, harness, handle).RefreshLockOwner)
}

// TestRefreshUpstreamRequiresARecord pins the defensive guard on the bounded call.
func TestRefreshUpstreamRequiresARecord(t *testing.T) {
	front := &frontChannelConfig{policy: RouteRefreshPolicy{RefreshBudget: time.Second}}
	_, err := front.refreshUpstream(context.Background(), nil)
	require.Error(t, err)
	var providerErr *oauth.ProviderError
	require.ErrorAs(t, err, &providerErr)
	require.Equal(t, oauth.ProviderInvalidRequest, providerErr.Class)
}

// TestReleaseRefreshLockWithoutARecord pins the best-effort release guard.
func TestReleaseRefreshLockWithoutARecord(t *testing.T) {
	front := &frontChannelConfig{}
	front.releaseRefreshLockAt(context.Background(), nil, nil)
}

// TestRefreshGrantLineageVerifiedServe pins the request-path half of the lineage
// check: a marked presentation whose family head already moved on is served from
// the new head — never by re-presenting the stale material — and the telemetry
// reason says so.
func TestRefreshGrantLineageVerifiedServe(t *testing.T) {
	var events providerEvents
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		routeRefreshEvents: events.hook,
	})
	handle := mintedRefreshHandle(t, harness)
	require.Equal(t, 200, harness.token(refreshTestForm(handle)).Status)

	// Model a lost rotation whose successor another process already committed: the
	// presented record is a predecessor again, carries the unconfirmed marker, and
	// its material must not be presented.
	predecessor := brokerRecord(t, harness, handle)
	predecessor.GraceExpiresAt = time.Time{}
	predecessor.RotationUnconfirmedAt = harness.clock.Now()
	_, err := harness.stores.RouteRefreshBroker.CompareAndSwap(context.Background(), predecessor, predecessor.Version)
	require.NoError(t, err)
	head := liveFamilyHead(mustListFamily(t, harness, predecessor.FamilyHash))
	require.NotNil(t, head)
	upstreamCalls := harness.fake.RefreshCallCount()

	served := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, served.Status)
	require.NotEqual(t, handle, refreshResponseHandle(t, served))
	require.Equal(t, upstreamCalls+1, harness.fake.RefreshCallCount(),
		"the served rotation is the head's, not the stale record's")
	require.Equal(t, head.EncryptedUpstreamRefreshToken,
		harness.fake.LastRefreshRequest().Get("refresh_token"),
		"the upstream must be presented the head's material, never the stale record's")

	verified := false
	for _, event := range events.snapshot() {
		if event.Reason == RouteRefreshReasonLineageVerified {
			verified = true
		}
	}
	require.True(t, verified, "the lineage-verified serve must be attributed")
	requireFamilyActive(t, harness, handle)
}

// TestLegacyAdoptionAmbiguousVerdictIsTransient pins the migration path's recovery
// gate: an unconfirmed attempt on a legacy head keeps the head and answers
// transiently instead of revoking a lineage that can no longer be migrated.
func TestLegacyAdoptionAmbiguousVerdictIsTransient(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	harness.rewriteBrokerRecord(t, handle, func(record *oauthstore.RouteRefreshBrokerRecord) {
		record.FamilyHash = ""
		record.ChainGeneration = 0
		record.RotationUnconfirmedAt = harness.clock.Now()
	})
	harness.scriptRefresh(func(context.Context) (*oauth.TokenSet, error) {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "refresh", "grant rejected")
	})

	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 503, response.Status)
	require.Equal(t, []string{"1"}, response.Headers["retry-after"])
}

// TestLegacyAdoptionIntentWriteFailureIsTransient pins the migration path's
// intent write: no upstream material is presented when the attempt cannot be
// recorded.
func TestLegacyAdoptionIntentWriteFailureIsTransient(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	harness.rewriteBrokerRecord(t, handle, func(record *oauthstore.RouteRefreshBrokerRecord) {
		record.FamilyHash = ""
		record.ChainGeneration = 0
	})
	harness.broker.compareAndSwapErr = errors.New("store unavailable")

	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 503, response.Status)
	require.Equal(t, 0, harness.fake.RefreshCallCount())
}

// baseBrokerOnly hides the transactional family capability, so a test can prove
// the sweeper refuses a store the facade would also refuse.
type baseBrokerOnly struct {
	oauthstore.RouteRefreshBrokerStore
}

// TestRefreshSweeperConstructionAndCallGuards pins the remaining fail-closed
// wiring: a store without the family capability, a sweeper without a clock (wall
// time is the documented default), and the argument guards on SweepFamily.
func TestRefreshSweeperConstructionAndCallGuards(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	policy := RouteRefreshPolicy{
		HandleTTL:        oauthstore.DefaultRouteRefreshBrokerTTL,
		GraceWindow:      DefaultRefreshGraceWindow,
		ReuseRateCeiling: MinRefreshReuseRateCeiling,
	}
	baseStores := harness.stores
	baseStores.RouteRefreshBroker = baseBrokerOnly{harness.stores.RouteRefreshBroker}
	_, err := NewRefreshSweeper(RefreshSweepConfig{
		Provider: harness.provider.current(),
		Stores:   baseStores,
		Policy:   policy,
	})
	require.Error(t, err)

	wallClock, err := NewRefreshSweeper(RefreshSweepConfig{
		Provider: harness.provider.current(),
		Stores:   harness.stores,
		Policy:   policy,
	})
	require.NoError(t, err)

	_, err = wallClock.SweepFamily(context.Background(), "")
	require.Error(t, err)
	_, err = (*RefreshSweeper)(nil).SweepFamily(context.Background(), "family")
	require.Error(t, err)
	//nolint:staticcheck // the nil-context guard is exactly what this asserts.
	_, err = wallClock.SweepFamily(nil, "family")
	require.NoError(t, err)
}

// TestRefreshSweeperCommitRaceTaxonomy pins the remaining commit-race classes: a
// successor that already exists is contention, a family binding mismatch is
// unreadable family state, and a family tombstone is the tombstone outcome.
func TestRefreshSweeperCommitRaceTaxonomy(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		err    error
		want   RefreshSweepOutcome
		reason string
	}{
		{"successor_exists", oauthstore.ErrBrokerSuccessorExists, RefreshSweepDeferred, RouteRefreshReasonLockContention},
		{"family_mismatch", oauthstore.ErrBrokerFamilyMismatch, RefreshSweepDeferred, RouteRefreshReasonFamilyStateUnavailable},
		{"legacy_lineage", oauthstore.ErrBrokerLegacyLineageUnsupported, RefreshSweepDeferred, RouteRefreshReasonFamilyStateUnavailable},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
			handle := mintedRefreshHandle(t, harness)
			familyHash := brokerRecord(t, harness, handle).FamilyHash
			harness.broker.rotateFamilyErr = testCase.err

			result, err := newSweeperForHarness(t, harness, nil).SweepFamily(context.Background(), familyHash)
			require.NoError(t, err)
			require.Equal(t, testCase.want, result.Outcome)
			require.Equal(t, testCase.reason, result.DeferredReason)
			requireFamilyActive(t, harness, handle)
		})
	}
}

// TestRefreshSweeperLockFailureTaxonomy pins the lock-failure classes that are
// neither contention nor a missing record.
func TestRefreshSweeperLockFailureTaxonomy(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		err    error
		reason string
	}{
		{"family_mismatch", oauthstore.ErrBrokerFamilyMismatch, RouteRefreshReasonFamilyStateUnavailable},
		{"legacy_lineage", oauthstore.ErrBrokerLegacyLineageUnsupported, RouteRefreshReasonFamilyStateUnavailable},
		{"expired", oauthstore.ErrBrokerExpired, ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
			handle := mintedRefreshHandle(t, harness)
			familyHash := brokerRecord(t, harness, handle).FamilyHash
			harness.broker.acquireLockFn = func(context.Context, string, string, int) (*oauthstore.RouteRefreshBrokerRecord, error) {
				return nil, testCase.err
			}

			result, err := newSweeperForHarness(t, harness, nil).SweepFamily(context.Background(), familyHash)
			require.NoError(t, err)
			if testCase.reason == "" {
				require.Equal(t, RefreshSweepNoLiveHead, result.Outcome)
				return
			}
			require.Equal(t, RefreshSweepDeferred, result.Outcome)
			require.Equal(t, testCase.reason, result.DeferredReason)
		})
	}
}

// TestTerminalRefreshEvidenceForAFamilyLessRecord pins the legacy branch: a record
// with no family cannot be family-revoked, so it is treated as its own head and the
// caller's revocation fails closed on the legacy path.
func TestTerminalRefreshEvidenceForAFamilyLessRecord(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	front := &frontChannelConfig{stores: harness.stores}
	require.Equal(t, terminalRefreshLiveHead,
		front.terminalRefreshEvidence(nil, &oauthstore.RouteRefreshBrokerRecord{HandleHash: "legacy"}))
	require.Equal(t, terminalRefreshUnverified, front.terminalRefreshEvidence(nil, nil))
}

// TestFailedTerminalRefreshGrantDefensiveBranches pins the classifier's two
// defensive halves directly, because the request-path loop resolves both before
// the classifier can see them: a verdict about superseded material (not revoked)
// is transient, and a verdict about an already-tombstoned record is the uniform
// terminal answer with no second revocation.
func TestFailedTerminalRefreshGrantDefensiveBranches(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	require.Equal(t, 200, harness.token(refreshTestForm(handle)).Status)

	predecessor := brokerRecord(t, harness, handle)
	predecessor.GraceExpiresAt = time.Time{}
	_, err := harness.stores.RouteRefreshBroker.CompareAndSwap(context.Background(), predecessor, predecessor.Version)
	require.NoError(t, err)

	front := &frontChannelConfig{stores: harness.stores}
	config := normalizedConfig{frontChannel: front}
	response, err := config.failedTerminalRefreshGrant(
		apptheoryContext(harness), predecessor, predecessor, oauth.ProviderInvalidGrant)
	require.NoError(t, err)
	require.Equal(t, 503, response.Status, "a verdict about superseded material is not family-terminal")
	requireFamilyActive(t, harness, handle)

	tombstoned := *predecessor
	tombstoned.Status = oauthstore.BrokerStatusRevoked
	response, err = config.failedTerminalRefreshGrant(
		apptheoryContext(harness), &tombstoned, &tombstoned, oauth.ProviderInvalidGrant)
	require.NoError(t, err)
	require.Equal(t, 400, response.Status)
}

// apptheoryContext returns a bare request context for a direct call to an
// internal helper. Its clock is wall time, which is past the zero marker, so the
// ambiguity horizon never masks the branch under test.
func apptheoryContext(_ *frontChannelHarness) *apptheory.Context {
	return &apptheory.Context{}
}

// TestRefreshGrantLockFailureClassesAreTransient pins the request path's
// fail-closed lock taxonomy: a store that cannot answer, or that reports a
// family binding problem, is retryable; only a revoked or missing record is the
// uniform terminal answer.
func TestRefreshGrantLockFailureClassesAreTransient(t *testing.T) {
	for _, err := range []error{
		oauthstore.ErrBrokerFamilyMismatch,
		oauthstore.ErrBrokerFamilyStateUnavailable,
	} {
		harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
		handle := mintedRefreshHandle(t, harness)
		harness.broker.acquireLockFn = func(context.Context, string, string, int) (*oauthstore.RouteRefreshBrokerRecord, error) {
			return nil, err
		}
		response := harness.token(refreshTestForm(handle))
		require.Equal(t, 503, response.Status)
		requireFamilyActive(t, harness, handle)
	}
}
