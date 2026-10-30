package mcpfacade

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
	"github.com/theory-cloud/apptheory/v6/testkit/oauthprovider"
)

// eventRecorder captures the route refresh telemetry the facade emits.
type eventRecorder struct {
	mu     sync.Mutex
	events []RouteRefreshEvent
}

func (r *eventRecorder) add(_ context.Context, event RouteRefreshEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *eventRecorder) all() []RouteRefreshEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RouteRefreshEvent(nil), r.events...)
}

func (r *eventRecorder) find(class RouteRefreshEventClass, outcome string) (RouteRefreshEvent, bool) {
	for _, event := range r.all() {
		if event.Class == class && (outcome == "" || event.Outcome == outcome) {
			return event, true
		}
	}
	return RouteRefreshEvent{}, false
}

func (r *eventRecorder) requireClass(t *testing.T, class RouteRefreshEventClass, outcome string) RouteRefreshEvent {
	t.Helper()
	event, ok := r.find(class, outcome)
	require.Truef(t, ok, "no %q event with outcome %q in %+v", class, outcome, r.all())
	return event
}

// TestRouteRefreshTelemetryCoversTheTaxonomy pins that every class the policy
// requires an operator to attribute is emitted by the real request path, and
// that a beyond-grace presentation is reuse that revokes the family rather than
// serving a token.
func TestRouteRefreshTelemetryCoversTheTaxonomy(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{routeRefreshEvents: recorder.add})
	handle := mintedRefreshHandle(t, harness)

	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)
	successor := refreshTestHandle(t, rotated)

	harness.clock.Advance(DefaultRefreshGraceWindow - time.Second)
	grace := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, grace.Status)

	harness.clock.Advance(2 * time.Second)
	reuse := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, reuse.Status)
	require.Contains(t, string(reuse.Body), `"error":"invalid_grant"`)
	for _, absent := range []string{"access_token", "refresh_token", "id_token"} {
		require.NotContains(t, string(reuse.Body), absent)
	}

	unknown, err := newTestHandle()
	require.NoError(t, err)
	absent := harness.token(refreshTestForm(unknown))
	require.Equal(t, 400, absent.Status)

	issued := recorder.requireClass(t, RouteRefreshEventIssued, "")
	require.NotEmpty(t, issued.HandleHash)
	require.Equal(t, issued.HandleHash, issued.FamilyHash)
	require.Equal(t, refreshChainRootGeneration, issued.ChainGeneration)

	recorder.requireClass(t, RouteRefreshEventLockAcquired, "")
	refreshed := recorder.requireClass(t, RouteRefreshEventRefreshed, "")
	require.Equal(t, refreshChainRootGeneration+1, refreshed.ChainGeneration)
	require.NotEmpty(t, refreshed.SuccessorHandleHash)

	recorder.requireClass(t, RouteRefreshEventGraceServed, "")
	reuseEvent := recorder.requireClass(t, RouteRefreshEventReuse, RouteRefreshOutcomeRevokedFamily)
	require.Equal(t, RouteRefreshReasonRotatedReuse, reuseEvent.Reason)
	require.GreaterOrEqual(t, reuseEvent.RevokedRecords, 1)
	require.Equal(t, facadeErrorInvalidGrant, reuseEvent.ErrorCode)
	require.Equal(t, oauthstore.BrokerStatusRevoked, reuseEvent.StatusTo)

	absentEvent := recorder.requireClass(t, RouteRefreshEventValidationRejected, "")
	foundAbsent := false
	for _, event := range recorder.all() {
		if event.Reason == RouteRefreshReasonRecordAbsent {
			require.Equal(t, RouteRefreshExpirySignalAbsent, event.ExpirySignal)
			foundAbsent = true
		}
	}
	require.True(t, foundAbsent, "expected a record_absent validation event")
	require.NotEmpty(t, absentEvent)

	// The family tombstone covers the minted successor even though the reuse
	// presentation was of the predecessor.
	requireFamilyRevoked(t, harness, successor)

	// No event may carry raw credential or handle material, only hashes.
	encoded, err := json.Marshal(recorder.all())
	require.NoError(t, err)
	for _, secret := range []string{
		frontTestRefreshToken,
		frontTestRefreshAccessToken,
		frontTestRotatedUpstreamRefreshToken,
		frontTestRotatedUpstreamScope,
		frontTestRefreshIDToken,
		handle,
		successor,
	} {
		require.NotContainsf(t, string(encoded), secret, "telemetry must carry hashes, never raw material")
	}
}

// TestRouteRefreshTelemetryAttributesUpstreamRejection pins the upstream
// attribution class: a terminal upstream rejection revokes the family and
// reports the provider class.
func TestRouteRefreshTelemetryAttributesUpstreamRejection(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		routeRefreshEvents: recorder.add,
		providerOptions: func(options *oauthprovider.Options) {
			options.RefreshTokenStatus = 400
			options.RefreshTokenBody = map[string]any{"error": "invalid_grant"}
		},
	})
	handle := mintedRefreshHandle(t, harness)
	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, response.Status)
	require.Contains(t, string(response.Body), `"error":"invalid_grant"`)

	event := recorder.requireClass(t, RouteRefreshEventUpstreamReauthRequired, "")
	require.Equal(t, "invalid_grant", event.UpstreamClass)
	require.Equal(t, oauthstore.BrokerStatusRevoked, event.StatusTo)
	requireFamilyRevoked(t, harness, handle)
}

// TestRouteRefreshExpiryIsAttributable pins the store's internal
// expiry-versus-absence signal: both render the same client body, and telemetry
// tells them apart.
func TestRouteRefreshExpiryIsAttributable(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{routeRefreshEvents: recorder.add})
	handle := mintedRefreshHandle(t, harness)

	harness.clock.Advance(oauthstore.DefaultRouteRefreshBrokerTTL + time.Second)
	expired := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, expired.Status)
	require.Contains(t, string(expired.Body), `"error":"invalid_grant"`)

	unknown, err := newTestHandle()
	require.NoError(t, err)
	absent := harness.token(refreshTestForm(unknown))
	require.Equal(t, 400, absent.Status)
	require.Equal(t, string(expired.Body), string(absent.Body), "the client body must not distinguish expiry from absence")

	expiredSignal := false
	absentSignal := false
	for _, event := range recorder.all() {
		if event.Class != RouteRefreshEventValidationRejected {
			continue
		}
		switch event.Reason {
		case RouteRefreshReasonRecordExpired:
			require.Equal(t, RouteRefreshExpirySignalExpired, event.ExpirySignal)
			expiredSignal = true
		case RouteRefreshReasonRecordAbsent:
			require.Equal(t, RouteRefreshExpirySignalAbsent, event.ExpirySignal)
			absentSignal = true
		}
	}
	require.True(t, expiredSignal, "expected an expired attribution")
	require.True(t, absentSignal, "expected an absent attribution")
}

// TestRouteRefreshLegacyRecordFailsClosed pins the pre-policy rule: a
// family-less record is unsupported for ordinary rotation. It is refused before
// any upstream call, serves no credential material, is not normalized, and
// leaves the successor untouched. Migration or reauthorization is required.
func TestRouteRefreshLegacyRecordFailsClosed(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{routeRefreshEvents: recorder.add})
	successorHandle, err := newTestHandle()
	require.NoError(t, err)
	legacyHandle, err := newTestHandle()
	require.NoError(t, err)

	seedLegacyRotatedRecord(t, harness, legacyHandle, successorHandle)
	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)

	refused := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 400, refused.Status)
	require.Contains(t, string(refused.Body), `"error":"invalid_grant"`)
	for _, absent := range []string{"access_token", "refresh_token", "id_token"} {
		require.NotContains(t, string(refused.Body), absent)
	}

	stateFailure := recorder.requireClass(t, RouteRefreshEventValidationRejected, "")
	require.Equal(t, RouteRefreshReasonLegacyLineage, stateFailure.Reason)

	// The legacy record is neither normalized nor revoked, and its successor is
	// untouched: no false revocation claim is made.
	legacy, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(legacyHandle))
	require.NoError(t, err)
	require.Empty(t, legacy.FamilyHash)
	require.Zero(t, legacy.ChainGeneration)
	require.Equal(t, oauthstore.BrokerStatusActive, legacy.Status)
	successor, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(successorHandle))
	require.NoError(t, err)
	require.Equal(t, oauthstore.BrokerStatusActive, successor.Status)
}

// seedLegacyRotatedRecord places a pre-policy rotated-away handle and its live
// successor directly in the broker store, the shape a deployment cutover hands
// the facade. Both records carry generation 0 and no family hash.
func seedLegacyRotatedRecord(t *testing.T, harness *frontChannelHarness, legacyHandle, successorHandle string) {
	t.Helper()
	seeder, ok := harness.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerSeeder)
	require.True(t, ok, "the reference broker store must implement the seeder")
	body, err := json.Marshal(map[string]any{
		"access_token":  "legacy-access-token",
		"token_type":    "Bearer",
		"expires_in":    900,
		"refresh_token": successorHandle,
	})
	require.NoError(t, err)
	require.NoError(t, seeder.Put(context.Background(), &oauthstore.RouteRefreshBrokerRecord{
		HandleHash:                    oauthstore.HashKey(legacyHandle),
		Issuer:                        frontTestUpstreamIss,
		CanonicalResource:             refreshTestBoundResource,
		ClientIDHash:                  oauthstore.HashKey(frontTestClientID),
		SubjectIDHash:                 oauthstore.HashKey("user-1"),
		ScopeFingerprint:              facadeScopeFingerprint([]string{"mcp:tools"}),
		EncryptedUpstreamRefreshToken: frontTestRefreshToken,
		UpstreamRefreshTokenHash:      oauthstore.HashKey(frontTestRefreshToken),
		UpstreamClientID:              frontTestClientID,
		EncryptedGraceRefreshResponse: string(body),
		Status:                        oauthstore.BrokerStatusActive,
	}))
	// The record is rotated already: its grace window closed at the seed instant.
	record, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(legacyHandle))
	require.NoError(t, err)
	record.GraceExpiresAt = harness.clock.Now()
	_, err = harness.stores.RouteRefreshBroker.CompareAndSwap(context.Background(), record, record.Version)
	require.NoError(t, err)

	require.NoError(t, seeder.Put(context.Background(), &oauthstore.RouteRefreshBrokerRecord{
		HandleHash:                    oauthstore.HashKey(successorHandle),
		Issuer:                        frontTestUpstreamIss,
		CanonicalResource:             refreshTestBoundResource,
		ClientIDHash:                  oauthstore.HashKey(frontTestClientID),
		SubjectIDHash:                 oauthstore.HashKey("user-1"),
		ScopeFingerprint:              facadeScopeFingerprint([]string{"mcp:tools"}),
		EncryptedUpstreamRefreshToken: frontTestRotatedUpstreamRefreshToken,
		UpstreamRefreshTokenHash:      oauthstore.HashKey(frontTestRotatedUpstreamRefreshToken),
		UpstreamClientID:              frontTestClientID,
		Status:                        oauthstore.BrokerStatusActive,
	}))
}

// TestRouteRefreshFamilyRevokeBeatsTheEightLinkBudget pins revoke-by-family: a
// chain longer than the removed eight-link successor walk is revoked completely,
// so a confirmed theft cannot leave a live head behind.
func TestRouteRefreshFamilyRevokeBeatsTheEightLinkBudget(t *testing.T) {
	harness := newFrontChannelHarness(t)
	root := mintedRefreshHandle(t, harness)
	handles := []string{root}
	head := root
	const rotations = 11
	for rotation := 0; rotation < rotations; rotation++ {
		response := harness.token(refreshTestForm(head))
		require.Equalf(t, 200, response.Status, "rotation %d body %s", rotation, response.Body)
		head = refreshTestHandle(t, response)
		handles = append(handles, head)
	}
	require.Len(t, handles, rotations+1)

	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
	reused := harness.token(refreshTestForm(root))
	require.Equal(t, 400, reused.Status)
	require.Contains(t, string(reused.Body), `"error":"invalid_grant"`)

	// Every handle of the family, including the live head, is revoked by the
	// tombstone: a read reports ErrBrokerRevoked and cannot be locked or rotated.
	for _, handle := range handles {
		requireFamilyRevoked(t, harness, handle)
	}
}

// TestRouteRefreshFirstBeyondGracePresentationRevokesFamily pins the removal of
// the access-token-only serve: the FIRST beyond-grace presentation is reuse.
func TestRouteRefreshFirstBeyondGracePresentationRevokesFamily(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{routeRefreshEvents: recorder.add})
	handle := mintedRefreshHandle(t, harness)
	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)
	successor := refreshTestHandle(t, rotated)

	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
	first := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, first.Status)
	require.Contains(t, string(first.Body), `"error":"invalid_grant"`)
	require.NotContains(t, string(first.Body), "access_token")
	require.NotContains(t, string(first.Body), "refresh_token")

	requireFamilyRevoked(t, harness, handle)
	requireFamilyRevoked(t, harness, successor)
	recorder.requireClass(t, RouteRefreshEventReuse, RouteRefreshOutcomeRevokedFamily)

	second := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, second.Status)
	require.Equal(t, string(first.Body), string(second.Body), "repeated reuse stays the uniform invalid_grant")
}

// newTestHandle mints a route handle shaped exactly like the framework's own.
func newTestHandle() (string, error) {
	return oauth.NewOpaqueToken()
}

// TestRouteRefreshGraceBoundaryIsExclusive pins the boundary-inclusivity
// decision: a replay at exactly the grace deadline is beyond grace and is reused
// without any credential material.
func TestRouteRefreshGraceBoundaryIsExclusive(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)
	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)

	harness.clock.Advance(DefaultRefreshGraceWindow)
	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, response.Status)
	require.Contains(t, string(response.Body), `"error":"invalid_grant"`)
	require.NotContains(t, string(response.Body), "access_token")
	require.NotContains(t, string(response.Body), "refresh_token")
}

// TestRouteRefreshFamilyRevocationIsLinearizable pins both interleavings at the
// facade: a revocation before a rotation mints nothing, and a rotation before a
// revocation leaves the successor unusable.
func TestRouteRefreshFamilyRevocationIsLinearizable(t *testing.T) {
	t.Run("revocation_before_rotation", func(t *testing.T) {
		harness := newFrontChannelHarness(t)
		handle := mintedRefreshHandle(t, harness)
		record := brokerRecord(t, harness, handle)
		locked, err := harness.stores.RouteRefreshBroker.AcquireLock(
			context.Background(), record.HandleHash, "test-holder", record.Version)
		require.NoError(t, err)
		familyStore, ok := harness.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
		require.True(t, ok)
		_, err = familyStore.RevokeFamily(context.Background(), record.FamilyHash)
		require.NoError(t, err)

		successorKey := oauthstore.HashKey("late-successor")
		_, err = familyStore.RotateFamily(context.Background(), oauthstore.RouteRefreshFamilyRotation{
			PresentedHandleHash: locked.HandleHash,
			LockOwner:           locked.RefreshLockOwner,
			ExpectedVersion:     locked.Version,
			Successor: &oauthstore.RouteRefreshBrokerRecord{
				HandleHash:        successorKey,
				FamilyHash:        record.FamilyHash,
				ChainGeneration:   record.ChainGeneration + 1,
				Issuer:            record.Issuer,
				CanonicalResource: record.CanonicalResource,
				ClientIDHash:      record.ClientIDHash,
				SubjectIDHash:     record.SubjectIDHash,
				ScopeFingerprint:  record.ScopeFingerprint,
				UpstreamClientID:  record.UpstreamClientID,
				Status:            oauthstore.BrokerStatusIssued,
			},
		})
		require.ErrorIs(t, err, oauthstore.ErrBrokerRevoked)
		_, err = harness.stores.RouteRefreshBroker.Get(context.Background(), successorKey)
		require.ErrorIs(t, err, oauthstore.ErrBrokerNotFound)
	})

	t.Run("rotation_before_revocation", func(t *testing.T) {
		harness := newFrontChannelHarness(t)
		handle := mintedRefreshHandle(t, harness)
		rotated := harness.token(refreshTestForm(handle))
		require.Equal(t, 200, rotated.Status)
		successor := refreshTestHandle(t, rotated)
		record := brokerRecord(t, harness, handle)
		familyStore, ok := harness.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
		require.True(t, ok)
		_, err := familyStore.RevokeFamily(context.Background(), record.FamilyHash)
		require.NoError(t, err)
		requireFamilyRevoked(t, harness, successor)
	})
}

// requireFamilyRevoked asserts a handle is covered by its family tombstone.
func requireFamilyRevoked(t *testing.T, harness *frontChannelHarness, handle string) {
	t.Helper()
	_, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(handle))
	require.ErrorIs(t, err, oauthstore.ErrBrokerRevoked)
}
