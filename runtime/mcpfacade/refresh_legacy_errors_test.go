package mcpfacade

// The legacy-lineage migration is the one place the served policy reaches into
// data a previous release wrote, so its failure classes are pinned here: a
// terminal upstream rejection must revoke the adopted head and tell the client
// to re-authorize, a transient failure must release the lock and let the same
// presentation succeed, an unfollowable lineage must never reach the upstream,
// and a malformed stored link must not be guessed.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
	"github.com/theory-cloud/apptheory/v7/testkit/oauthprovider"
)

// TestLegacyAdoptionTerminalUpstreamFailureRevokesTheHead pins the only
// migration failure that ends the lineage: the upstream says the recorded grant
// is dead, so the head is revoked and the client gets invalid_grant — the one
// re-authorize signal.
func TestLegacyAdoptionTerminalUpstreamFailureRevokesTheHead(t *testing.T) {
	t.Parallel()
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		routeRefreshEvents: recorder.add,
		providerOptions: func(options *oauthprovider.Options) {
			options.RefreshTokenStatus = 400
			options.RefreshTokenBody = map[string]any{"error": "invalid_grant"}
		},
	})
	legacyHandle, err := newTestHandle()
	require.NoError(t, err)
	successorHandle, err := newTestHandle()
	require.NoError(t, err)
	seedLegacyRotatedRecord(t, harness, legacyHandle, successorHandle)
	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)

	refused := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 400, refused.Status)
	require.Contains(t, string(refused.Body), `"error":"invalid_grant"`)
	require.NotContains(t, string(refused.Body), "access_token")

	revoked, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(successorHandle))
	require.NoError(t, err)
	require.Equal(t, oauthstore.BrokerStatusRevoked, revoked.Status,
		"a terminally dead grant must not leave the adopted head live")

	event := recorder.requireClass(t, RouteRefreshEventUpstreamReauthRequired, "")
	require.Equal(t, RouteRefreshReasonUpstreamRejected, event.Reason)
	require.Equal(t, string(oauth.ProviderInvalidGrant), event.UpstreamClass)
}

// TestLegacyAdoptionTransientUpstreamFailureReleasesTheLock pins the retryable
// class: a transient upstream failure must not cost the client its lineage. The
// lock is released, the retry answers 503 with a Retry-After, and the very next
// presentation succeeds.
func TestLegacyAdoptionTransientUpstreamFailureReleasesTheLock(t *testing.T) {
	t.Parallel()
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		routeRefreshEvents: recorder.add,
		providerOptions: func(options *oauthprovider.Options) {
			options.RefreshTokenStages = []oauthprovider.RefreshStage{{
				Status: 503,
				Body:   map[string]any{"error": "temporarily_unavailable"},
			}}
		},
	})
	legacyHandle, err := newTestHandle()
	require.NoError(t, err)
	successorHandle, err := newTestHandle()
	require.NoError(t, err)
	seedLegacyRotatedRecord(t, harness, legacyHandle, successorHandle)
	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)

	retryable := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 503, retryable.Status, string(retryable.Body))
	require.Contains(t, string(retryable.Body), `"error":"temporarily_unavailable"`)
	require.Equal(t, "1", retryable.Headers["retry-after"][0])

	adopted := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 200, adopted.Status, string(adopted.Body))
	require.NotEmpty(t, refreshPayloadHandle(t, adopted))

	event := recorder.requireClass(t, RouteRefreshEventStateFailure, "")
	require.Equal(t, RouteRefreshReasonUpstreamRejected, event.Reason)
	require.Equal(t, string(oauth.ProviderTemporarilyUnavailable), event.UpstreamClass)
}

// TestLegacyAdoptionUpstreamErrorIsTheGatewayClass pins the distinction between
// an upstream that rejected the request shape and one that was merely down: the
// client sees 502 upstream_error, the lock is released, and the lineage stays
// migratable.
func TestLegacyAdoptionUpstreamErrorIsTheGatewayClass(t *testing.T) {
	t.Parallel()
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		routeRefreshEvents: recorder.add,
		providerOptions: func(options *oauthprovider.Options) {
			options.RefreshTokenStatus = 400
			options.RefreshTokenBody = map[string]any{"error": "unexpected_state"}
		},
	})
	legacyHandle, err := newTestHandle()
	require.NoError(t, err)
	successorHandle, err := newTestHandle()
	require.NoError(t, err)
	seedLegacyRotatedRecord(t, harness, legacyHandle, successorHandle)
	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)

	failed := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 502, failed.Status, string(failed.Body))
	require.Contains(t, string(failed.Body), `"error":"upstream_error"`)

	record, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(successorHandle))
	require.NoError(t, err)
	require.NotEqual(t, oauthstore.BrokerStatusRevoked, record.Status,
		"an upstream error must not revoke a lineage that may still be valid")

	event := recorder.requireClass(t, RouteRefreshEventStateFailure, "")
	require.Equal(t, string(oauth.ProviderUpstreamError), event.UpstreamClass)
}

// TestLegacyLineageCycleIsTerminal pins the corruption guard: two records that
// point at each other have no live head, so the migration refuses instead of
// looping or guessing.
func TestLegacyLineageCycleIsTerminal(t *testing.T) {
	t.Parallel()
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{routeRefreshEvents: recorder.add})
	first, err := newTestHandle()
	require.NoError(t, err)
	second, err := newTestHandle()
	require.NoError(t, err)
	seedLegacyLink(t, harness, first, second)
	seedLegacyLink(t, harness, second, first)

	refused := harness.token(refreshTestForm(first))
	require.Equal(t, 400, refused.Status)
	require.Contains(t, string(refused.Body), `"error":"invalid_grant"`)
	require.Zero(t, harness.fake.RefreshCallCount(), "a cycle must never reach the upstream")

	event := recorder.requireClass(t, RouteRefreshEventStateFailure, "")
	require.Equal(t, RouteRefreshReasonLegacyLineage, event.Reason)
}

// TestLegacySuccessorHandleRejectsMalformedBodies pins that the stored link is
// read strictly: an absent, unparseable, empty, or oversized handle is not
// guessed into a successor.
func TestLegacySuccessorHandleRejectsMalformedBodies(t *testing.T) {
	t.Parallel()
	cases := []string{
		"",
		"not json",
		`{"refresh_token":""}`,
		`{"refresh_token":"` + strings.Repeat("a", frontChannelMaxRefreshHandleBytes+1) + `"}`,
	}
	for _, body := range cases {
		if _, ok := legacySuccessorHandle(body); ok {
			t.Fatalf("legacySuccessorHandle(%q) accepted a malformed body", body)
		}
	}
	handle, ok := legacySuccessorHandle(`{"refresh_token":"next-handle"}`)
	require.True(t, ok)
	require.Equal(t, "next-handle", handle)
}

// seedLegacyLink places one family-less rotated-away record whose stored body
// names the next handle in the lineage.
func seedLegacyLink(t *testing.T, harness *frontChannelHarness, handle, next string) {
	t.Helper()
	seeder, ok := harness.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerSeeder)
	require.True(t, ok)
	body, err := json.Marshal(map[string]any{
		"access_token":  "legacy-access-token",
		"token_type":    "Bearer",
		"expires_in":    900,
		"refresh_token": next,
	})
	require.NoError(t, err)
	require.NoError(t, seeder.Put(context.Background(), &oauthstore.RouteRefreshBrokerRecord{
		HandleHash:                    oauthstore.HashKey(handle),
		Issuer:                        frontTestUpstreamIss,
		CanonicalResource:             refreshTestBoundResource,
		ClientIDHash:                  oauthstore.HashKey(frontTestClientID),
		SubjectIDHash:                 oauthstore.HashKey("user-1"),
		ScopeFingerprint:              facadeScopeFingerprint([]string{"mcp:tools"}),
		EncryptedUpstreamRefreshToken: frontTestRefreshToken,
		UpstreamRefreshTokenHash:      oauthstore.HashKey(frontTestRefreshToken),
		UpstreamClientID:              frontTestClientID,
		EncryptedGraceRefreshResponse: string(body),
		GraceExpiresAt:                harness.clock.Now(),
		Status:                        oauthstore.BrokerStatusActive,
	}))
}

// TestLegacyAdoptionRefusesARevokedHead pins the last walk failure: a lineage
// whose head is already revoked cannot be migrated back to life.
func TestLegacyAdoptionRefusesARevokedHead(t *testing.T) {
	t.Parallel()
	harness := newFrontChannelHarness(t)
	legacyHandle, err := newTestHandle()
	require.NoError(t, err)
	successorHandle, err := newTestHandle()
	require.NoError(t, err)
	seedLegacyRotatedRecord(t, harness, legacyHandle, successorHandle)
	head, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(successorHandle))
	require.NoError(t, err)
	head.Status = oauthstore.BrokerStatusRevoked
	_, err = harness.stores.RouteRefreshBroker.CompareAndSwap(context.Background(), head, head.Version)
	require.NoError(t, err)
	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)

	refused := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 400, refused.Status)
	require.Contains(t, string(refused.Body), `"error":"invalid_grant"`)
}
