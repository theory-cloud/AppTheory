package mcpfacade

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
)

// TestRefreshSweeperReportsEveryDeferralAsStateFailure pins the rule that makes
// a sweeper observable at all: every deferred tick emits exactly one
// state_failure event carrying the deferred reason, including a family the
// sweeper could not read. A silent deferral is indistinguishable from a sweep
// that never ran, so a soak or alarm that counts route refresh events alone
// could not see an inert sweeper (issue #1283, found by the 2026-11-13 TMS
// refresh soak: every tick read due=1 rotated=0 deferred=1 with an empty event
// stream).
//
// The event carries no identity beyond the reason: the sweep defers before it
// resolves a record, so there is no handle or family hash to attribute it to,
// and none is invented.
func TestRefreshSweeperReportsEveryDeferralAsStateFailure(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		stage  func(t *testing.T, harness *frontChannelHarness)
		reason string
	}{
		{
			name: "unreadable_family",
			stage: func(_ *testing.T, harness *frontChannelHarness) {
				harness.broker.listFamilyErr = oauthstore.ErrBrokerFamilyStateUnavailable
			},
			reason: RouteRefreshReasonFamilyStateUnavailable,
		},
		{
			name: "unreadable_family_store_failure",
			stage: func(_ *testing.T, harness *frontChannelHarness) {
				harness.broker.listFamilyErr = errors.New("store unavailable")
			},
			reason: RouteRefreshReasonFamilyStateUnavailable,
		},
		{
			name: "lock_contention",
			stage: func(_ *testing.T, harness *frontChannelHarness) {
				harness.broker.acquireLockFn = func(context.Context, string, string, int) (*oauthstore.RouteRefreshBrokerRecord, error) {
					return nil, oauthstore.ErrBrokerLocked
				}
			},
			reason: RouteRefreshReasonLockContention,
		},
		{
			name: "rotation_intent_write_failure",
			stage: func(_ *testing.T, harness *frontChannelHarness) {
				harness.broker.compareAndSwapErr = errors.New("store unavailable")
			},
			reason: RouteRefreshReasonRewriteFailure,
		},
		{
			name: "upstream_rejected",
			stage: func(_ *testing.T, harness *frontChannelHarness) {
				harness.scriptRefresh(func(context.Context) (*oauth.TokenSet, error) {
					return nil, oauth.NewProviderError(oauth.ProviderTemporarilyUnavailable, "refresh", "upstream busy")
				})
			},
			reason: RouteRefreshReasonUpstreamRejected,
		},
		{
			name: "commit_race",
			stage: func(_ *testing.T, harness *frontChannelHarness) {
				harness.broker.rotateFamilyErr = errors.New("transaction unavailable")
			},
			reason: RouteRefreshReasonRewriteFailure,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := &eventRecorder{}
			harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
			handle := mintedRefreshHandle(t, harness)
			familyHash := brokerRecord(t, harness, handle).FamilyHash
			testCase.stage(t, harness)

			result, err := newSweeperForHarness(t, harness, recorder.add).SweepFamily(context.Background(), familyHash)
			require.NoError(t, err)
			require.Equal(t, RefreshSweepDeferred, result.Outcome)
			require.Equal(t, testCase.reason, result.DeferredReason)

			failures := make([]RouteRefreshEvent, 0, 1)
			for _, event := range recorder.all() {
				if event.Class == RouteRefreshEventStateFailure {
					failures = append(failures, event)
				}
			}
			require.Len(t, failures, 1, "every deferred tick reports exactly one state_failure event: %+v", recorder.all())
			require.Equal(t, testCase.reason, failures[0].Reason)
			// The deferral is reported, not attributed: no record was resolved.
			require.Empty(t, failures[0].HandleHash)
			require.Empty(t, failures[0].FamilyHash)
			require.Empty(t, failures[0].SuccessorHandleHash)
			require.False(t, failures[0].At.IsZero(), "the event carries the tick's instant")

			// A deferral is never a family event.
			requireFamilyActive(t, harness, handle)
		})
	}
}

// TestRefreshSweeperReportsATerminalVerdictAsStateFailure pins the one
// non-deferred branch that also reports state_failure: the contract-terminal
// upstream verdict stays a report, never a sweep-driven revocation.
func TestRefreshSweeperReportsATerminalVerdictAsStateFailure(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	familyHash := brokerRecord(t, harness, handle).FamilyHash
	harness.scriptRefresh(func(context.Context) (*oauth.TokenSet, error) {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "refresh", "grant is terminal")
	})

	result, err := newSweeperForHarness(t, harness, recorder.add).SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepTerminalVerdict, result.Outcome)

	failure := recorder.requireClass(t, RouteRefreshEventStateFailure, "")
	require.Equal(t, RouteRefreshReasonUpstreamRejected, failure.Reason)
	require.Equal(t, string(oauth.ProviderInvalidGrant), failure.UpstreamClass)
	harness.clock.Advance(time.Second)
	requireFamilyActive(t, harness, handle)
}
