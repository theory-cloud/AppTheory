package mcpfacade

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
)

// newSweeperForHarness builds the exported sweeper over the harness's real
// stores and provider — the same broker, the same family state, and the same
// upstream the mounted request path uses.
func newSweeperForHarness(t *testing.T, harness *frontChannelHarness, events RouteRefreshEventHook) *RefreshSweeper {
	t.Helper()
	policy := RouteRefreshPolicy{
		HandleTTL:        oauthstore.DefaultRouteRefreshBrokerTTL,
		GraceWindow:      DefaultRefreshGraceWindow,
		ReuseRateCeiling: MinRefreshReuseRateCeiling,
		RefreshBudget:    DefaultRefreshBudget,
	}
	sweeper, err := NewRefreshSweeper(RefreshSweepConfig{
		Provider: harness.provider.current(),
		Stores:   harness.stores,
		Policy:   policy,
		Events:   events,
		Now:      harness.clock.Now,
	})
	require.NoError(t, err)
	return sweeper
}

// TestRefreshSweeperRotatesTheFamilyHead drives the exported entrypoint through
// its real surface: one sweep rotates the family's live head, and the
// request-path presentation of the now-predecessor handle is served from the
// stored successor body. No family effect, no second upstream call, and the
// client keeps working.
func TestRefreshSweeperRotatesTheFamilyHead(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	familyHash := brokerRecord(t, harness, handle).FamilyHash
	require.NotEmpty(t, familyHash)

	sweeper := newSweeperForHarness(t, harness, nil)
	result, err := sweeper.SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepRotated, result.Outcome, "deferred reason: %s class: %s", result.DeferredReason, result.UpstreamClass)
	require.Equal(t, oauthstore.HashKey(handle), result.PresentedHandleHash)
	require.NotEmpty(t, result.SuccessorHandleHash)
	require.Equal(t, 2, result.ChainGeneration)
	require.Equal(t, 1, harness.fake.RefreshCallCount())

	// The request path presents the rotated-away handle: the stored successor body
	// is replayed, so the client is served without a second upstream rotation.
	served := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, served.Status)
	require.Equal(t, result.SuccessorHandleHash, oauthstore.HashKey(refreshResponseHandle(t, served)))
	require.Equal(t, 1, harness.fake.RefreshCallCount())
	requireFamilyActive(t, harness, handle)
}

// TestRefreshSweeperDefersWhileTheLockIsHeld pins the first clause of the
// concurrency contract: a lock the sweep cannot take is a deferred tick, not an
// error, not an upstream call, and not a family event.
func TestRefreshSweeperDefersWhileTheLockIsHeld(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	familyHash := brokerRecord(t, harness, handle).FamilyHash

	record := brokerRecord(t, harness, handle)
	_, err := harness.stores.RouteRefreshBroker.AcquireLock(
		context.Background(), oauthstore.HashKey(handle), "request-path-owner", record.Version)
	require.NoError(t, err)

	sweeper := newSweeperForHarness(t, harness, nil)
	result, err := sweeper.SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepDeferred, result.Outcome)
	require.Equal(t, RouteRefreshReasonLockContention, result.DeferredReason)
	require.Equal(t, 0, harness.fake.RefreshCallCount())
	requireFamilyActive(t, harness, handle)
	require.Len(t, mustListFamily(t, harness, familyHash), 1, "a deferred sweep mints nothing")
}

// TestRefreshSweeperDefersOnAVersionConflict covers the second lock clause: a head
// whose version moved between the read and the lock is a deferred tick.
func TestRefreshSweeperDefersOnAVersionConflict(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	familyHash := brokerRecord(t, harness, handle).FamilyHash

	harness.broker.acquireLockFn = func(context.Context, string, string, int) (*oauthstore.RouteRefreshBrokerRecord, error) {
		return nil, oauthstore.ErrBrokerVersionConflict
	}
	sweeper := newSweeperForHarness(t, harness, nil)
	result, err := sweeper.SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepDeferred, result.Outcome)
	require.Equal(t, RouteRefreshReasonLockContention, result.DeferredReason)
	require.Equal(t, 0, harness.fake.RefreshCallCount())
	requireFamilyActive(t, harness, handle)
}

// TestRefreshSweeperNeverRevokesOnATerminalVerdict pins the fourth clause: a
// contract-terminal upstream verdict observed by the sweep is reported and the
// family is left intact. The next request-path presentation then renders the
// verdict through the lineage-verified path, so revocation and its receipt stay
// on one surface.
func TestRefreshSweeperNeverRevokesOnATerminalVerdict(t *testing.T) {
	events := &providerEvents{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		routeRefreshEvents: events.hook,
	})
	handle := mintedRefreshHandle(t, harness)
	familyHash := brokerRecord(t, harness, handle).FamilyHash
	harness.scriptRefresh(func(context.Context) (*oauth.TokenSet, error) {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "refresh", "grant rejected")
	})

	sweeper := newSweeperForHarness(t, harness, events.hook)
	result, err := sweeper.SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepTerminalVerdict, result.Outcome)
	require.Equal(t, string(oauth.ProviderInvalidGrant), result.UpstreamClass)
	requireFamilyActive(t, harness, handle)
	requireNoTerminalEvent(t, events.snapshot())

	// The sweep's rotation intent is the ambiguity evidence the request path reads.
	require.False(t, brokerRecord(t, harness, handle).RotationUnconfirmedAt.IsZero())

	inside := harness.token(refreshTestForm(handle))
	require.Equal(t, 503, inside.Status, "a sweep-observed verdict is not terminal evidence on its own")
	requireFamilyActive(t, harness, handle)

	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
	terminal := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, terminal.Status)
	requireFamilyRevoked(t, harness, handle)
}

// TestRefreshSweeperRacingTheRequestPathIsNeverFamilyAffecting exercises the race
// contract both orders through the real exported entrypoint and the real mounted
// request path. A sweep-driven rotation and a request-path rotation on the SAME
// family resolve transient (deferred, grace replay, or rotated-from-head) in
// either order; neither ever revokes the family and no client request receives a
// terminal verdict.
func TestRefreshSweeperRacingTheRequestPathIsNeverFamilyAffecting(t *testing.T) {
	for _, order := range []string{"sweep-first", "request-first", "concurrent"} {
		t.Run(order, func(t *testing.T) {
			harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
			handle := mintedRefreshHandle(t, harness)
			familyHash := brokerRecord(t, harness, handle).FamilyHash
			sweeper := newSweeperForHarness(t, harness, nil)

			switch order {
			case "sweep-first":
				result, err := sweeper.SweepFamily(context.Background(), familyHash)
				require.NoError(t, err)
				require.Equal(t, RefreshSweepRotated, result.Outcome)
				served := harness.token(refreshTestForm(handle))
				require.Equal(t, 200, served.Status)
				require.Equal(t, result.SuccessorHandleHash, oauthstore.HashKey(refreshResponseHandle(t, served)))

				// A second sweep rotates the new head; the handle the client now holds
				// keeps working.
				result, err = sweeper.SweepFamily(context.Background(), familyHash)
				require.NoError(t, err)
				require.Equal(t, RefreshSweepRotated, result.Outcome)
				again := harness.token(refreshTestForm(result.RotatedHandle(t, harness)))
				require.Equal(t, 200, again.Status)
			case "request-first":
				first := harness.token(refreshTestForm(handle))
				require.Equal(t, 200, first.Status)
				successor := refreshResponseHandle(t, first)

				result, err := sweeper.SweepFamily(context.Background(), familyHash)
				require.NoError(t, err)
				require.Equal(t, RefreshSweepRotated, result.Outcome)
				require.Equal(t, oauthstore.HashKey(successor), result.PresentedHandleHash)

				// The successor the client holds is now the sweep's predecessor: the
				// grace window serves it, and past the window the new head is rotated.
				served := harness.token(refreshTestForm(successor))
				require.Equal(t, 200, served.Status)
				harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
				afterGrace := harness.token(refreshTestForm(successor))
				require.Equal(t, 200, afterGrace.Status)
			case "concurrent":
				// Each iteration can wait out the request path's coalesce cap against
				// a sweep-held lock, so keep the race short and repeat it rather than
				// making the suite slow.
				for iteration := 0; iteration < 3; iteration++ {
					var (
						waitGroup    sync.WaitGroup
						sweepResult  RefreshSweepResult
						sweepErr     error
						refreshReply = make(chan int, 1)
					)
					waitGroup.Add(2)
					go func() {
						defer waitGroup.Done()
						sweepResult, sweepErr = sweeper.SweepFamily(context.Background(), familyHash)
					}()
					go func() {
						defer waitGroup.Done()
						refreshReply <- harness.token(refreshTestForm(handle)).Status
					}()
					waitGroup.Wait()
					require.NoError(t, sweepErr)
					require.Contains(t,
						[]RefreshSweepOutcome{RefreshSweepRotated, RefreshSweepDeferred},
						sweepResult.Outcome)
					status := <-refreshReply
					require.Contains(t, []int{200, 503}, status,
						"a request racing a sweep must be served or told to retry, never refused terminally")
					requireFamilyActive(t, harness, handle)
				}
			}
			requireFamilyActive(t, harness, handle)
		})
	}
}

// TestRefreshSweeperRejectsIncompleteConfiguration pins the fail-closed wiring: a
// sweeper without a provider, without the broker's transactional family
// capability, or with an invalid policy is a construction error, never a
// degraded runtime.
func TestRefreshSweeperRejectsIncompleteConfiguration(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	valid := RefreshSweepConfig{
		Provider: harness.provider.current(),
		Stores:   harness.stores,
		Policy: RouteRefreshPolicy{
			HandleTTL:        oauthstore.DefaultRouteRefreshBrokerTTL,
			ReuseRateCeiling: MinRefreshReuseRateCeiling,
		},
	}

	missingProvider := valid
	missingProvider.Provider = nil
	_, err := NewRefreshSweeper(missingProvider)
	require.Error(t, err)

	missingStores := valid
	missingStores.Stores = oauthstore.Stores{}
	_, err = NewRefreshSweeper(missingStores)
	require.Error(t, err)

	invalidPolicy := valid
	invalidPolicy.Policy = RouteRefreshPolicy{}
	_, err = NewRefreshSweeper(invalidPolicy)
	require.Error(t, err)

	_, err = NewRefreshSweeper(valid)
	require.NoError(t, err)
}

// RotatedHandle returns the handle a rotation minted. The sweep result carries
// hashes, never handles, so a row that needs to present the successor reads it
// from the stored record the family now heads.
func (result RefreshSweepResult) RotatedHandle(t *testing.T, harness *frontChannelHarness) string {
	t.Helper()
	family, ok := harness.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	require.True(t, ok)
	records, err := family.ListFamily(context.Background(), result.FamilyHash)
	require.NoError(t, err)
	head := liveFamilyHead(records)
	require.NotNil(t, head)
	require.Equal(t, result.SuccessorHandleHash, head.HandleHash)
	// The re-armed grace body carries the successor handle back to the client.
	predecessor, err := harness.stores.RouteRefreshBroker.Get(context.Background(), result.PresentedHandleHash)
	require.NoError(t, err)
	handle, ok := legacySuccessorHandle(predecessor.EncryptedGraceRefreshResponse)
	require.True(t, ok)
	return handle
}
