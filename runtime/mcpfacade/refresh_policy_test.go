package mcpfacade

import (
	"context"
	"encoding/json"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v7/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
	"github.com/theory-cloud/apptheory/v7/runtime/refusal"
	"github.com/theory-cloud/apptheory/v7/testkit/oauthprovider"
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
// that a stale predecessor presentation is reported as reuse with the additive
// rotated_from_head outcome while the family stays live.
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
	require.Equal(t, 200, reuse.Status, string(reuse.Body))

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
	require.NotEmpty(t, refreshed.SuccessorHandleHash)

	recorder.requireClass(t, RouteRefreshEventGraceServed, "")
	reuseEvent := recorder.requireClass(t, RouteRefreshEventReuse, RouteRefreshOutcomeRotatedFromHead)
	require.Equal(t, RouteRefreshReasonStalePredecessor, reuseEvent.Reason)
	require.Zero(t, reuseEvent.RevokedRecords)
	require.NotEqual(t, oauthstore.BrokerStatusRevoked, reuseEvent.StatusTo)
	require.Equal(t, oauthstore.HashKey(handle), reuseEvent.HandleHash)

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

	// The family survived the stale presentation: every member is still usable.
	requireFamilyActive(t, harness, handle)
	requireFamilyActive(t, harness, successor)

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

// TestRouteRefreshLegacyRecordIsAdoptedInCode pins the migration rule: a
// family-less v6.4.0-era lineage is not refused. The facade follows the stored
// successor link to the live head, rotates that head's current upstream
// material into a fresh generation-1 family, and hands the client working
// credentials with no manual data operation. A sibling presentation of the same
// old handle then finds the family through the re-armed link instead of minting
// a second one.
func TestRouteRefreshLegacyRecordIsAdoptedInCode(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{routeRefreshEvents: recorder.add})
	successorHandle, err := newTestHandle()
	require.NoError(t, err)
	legacyHandle, err := newTestHandle()
	require.NoError(t, err)

	seedLegacyRotatedRecord(t, harness, legacyHandle, successorHandle)
	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)

	adopted := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 200, adopted.Status, string(adopted.Body))
	require.NotEmpty(t, refreshPayloadAccessToken(t, adopted))
	require.Equal(t, frontTestRotatedUpstreamRefreshToken, harness.fake.LastRefreshRequest().Get("refresh_token"),
		"the migration must refresh the live head's material, never the rotated-away record's")
	require.Equal(t, 1, harness.fake.RefreshCallCount())

	root := refreshPayloadHandle(t, adopted)
	rootRecord, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(root))
	require.NoError(t, err)
	require.Equal(t, rootRecord.HandleHash, rootRecord.FamilyHash)
	require.Equal(t, refreshChainRootGeneration, rootRecord.ChainGeneration)

	event := recorder.requireClass(t, RouteRefreshEventRefreshed, "")
	require.Equal(t, RouteRefreshReasonLegacyLineageAdopted, event.Reason)

	// The new family rotates normally.
	next := harness.token(refreshTestForm(root))
	require.Equal(t, 200, next.Status)
	require.NotEqual(t, root, refreshPayloadHandle(t, next))

	// A sibling presentation of the same legacy handle is served by the same
	// family: the head's re-armed body names the new root, so the walk lands there.
	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
	sibling := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 200, sibling.Status, string(sibling.Body))
	siblingRecord, err := harness.stores.RouteRefreshBroker.Get(
		context.Background(), oauthstore.HashKey(refreshPayloadHandle(t, sibling)))
	require.NoError(t, err)
	require.Equal(t, rootRecord.FamilyHash, siblingRecord.FamilyHash,
		"a sibling migration must not mint a second family")
}

// TestRouteRefreshLegacyLineageWithABrokenLinkIsTerminal pins the one migration
// failure: when the stored successor link cannot be followed there is no record
// whose material is known to be current, so the facade refuses instead of
// guessing and risking an upstream reuse revocation.
func TestRouteRefreshLegacyLineageWithABrokenLinkIsTerminal(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{routeRefreshEvents: recorder.add})
	legacyHandle, err := newTestHandle()
	require.NoError(t, err)
	seeder, ok := harness.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerSeeder)
	require.True(t, ok)
	body, err := json.Marshal(map[string]any{
		"access_token":  "legacy-access-token",
		"token_type":    "Bearer",
		"expires_in":    900,
		"refresh_token": "a-successor-that-is-not-stored",
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
		GraceExpiresAt:                harness.clock.Now(),
		Status:                        oauthstore.BrokerStatusActive,
	}))

	refused := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 400, refused.Status)
	require.Contains(t, string(refused.Body), `"error":"invalid_grant"`)
	require.NotContains(t, string(refused.Body), "access_token")
	require.Zero(t, harness.fake.RefreshCallCount(), "an unfollowable link must not reach the upstream")

	event := recorder.requireClass(t, RouteRefreshEventStateFailure, "")
	require.Equal(t, RouteRefreshReasonLegacyLineage, event.Reason)
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

// TestRouteRefreshStalePredecessorAfterManyRotationsServesTheHead pins that a
// long chain is not a reason to refuse: a handle eleven rotations behind the
// head is still a client with a stale stored copy, so the head is rotated and
// the client is served. Every member of the family stays live.
func TestRouteRefreshStalePredecessorAfterManyRotationsServesTheHead(t *testing.T) {
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
	served := harness.token(refreshTestForm(root))
	require.Equal(t, 200, served.Status, string(served.Body))
	require.NotEmpty(t, refreshPayloadAccessToken(t, served))
	require.Equal(t, rotations+1, harness.fake.RefreshCallCount(),
		"the stale presentation is one rotation of the live head, from its current material")

	for _, handle := range handles {
		requireFamilyActive(t, harness, handle)
	}
}

// TestRouteRefreshFirstBeyondGracePresentationServesFreshCredentials pins that
// the FIRST beyond-grace presentation of a rotated handle is served from the
// live head rather than revoked, and that the family stays live across repeats.
func TestRouteRefreshFirstBeyondGracePresentationServesFreshCredentials(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{routeRefreshEvents: recorder.add})
	handle := mintedRefreshHandle(t, harness)
	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)
	successor := refreshTestHandle(t, rotated)

	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
	first := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, first.Status, string(first.Body))
	require.NotEmpty(t, refreshPayloadAccessToken(t, first))
	require.NotEmpty(t, refreshTestHandle(t, first))

	requireFamilyActive(t, harness, handle)
	requireFamilyActive(t, harness, successor)
	recorder.requireClass(t, RouteRefreshEventReuse, RouteRefreshOutcomeRotatedFromHead)

	second := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, second.Status)
	require.Equal(t, string(first.Body), string(second.Body),
		"a repeated stale presentation inside the re-armed window is the same stored body")
}

// newTestHandle mints a route handle shaped exactly like the framework's own.
func newTestHandle() (string, error) {
	return oauth.NewOpaqueToken()
}

// TestRouteRefreshGraceBoundaryIsExclusive pins the boundary-inclusivity
// decision: a presentation at exactly the grace deadline is not a replay, so it
// does not receive the stored body; it is served by rotating the head and
// returns different credentials. The client is never refused.
func TestRouteRefreshGraceBoundaryIsExclusive(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)
	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)
	successor := refreshTestHandle(t, rotated)

	harness.clock.Advance(DefaultRefreshGraceWindow)
	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, response.Status)
	require.NotEqual(t, successor, refreshTestHandle(t, response),
		"at the deadline the stored successor is not replayed")
	require.Equal(t, 2, harness.fake.RefreshCallCount())
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

// requireFamilyActive asserts a handle is still stored and not revoked, so the
// family survived whatever presentation the test just made.
func requireFamilyActive(t *testing.T, harness *frontChannelHarness, handle string) {
	t.Helper()
	record, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(handle))
	require.NoError(t, err)
	require.NotEqual(t, oauthstore.BrokerStatusRevoked, record.Status)
}

// TestFacadeRefusalsAreObservable pins the facade half of the refusal contract:
// a 400 the front channel renders carries one structured event naming the
// client-facing error code, and a served request carries none.
func TestFacadeRefusalsAreObservable(t *testing.T) {
	var events []refusal.Event
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		refusalHook: func(_ context.Context, event refusal.Event) { events = append(events, event) },
	})
	handle := mintedRefreshHandle(t, harness)
	unknown, err := newTestHandle()
	require.NoError(t, err)

	refused := harness.token(refreshTestForm(unknown))
	require.Equal(t, 400, refused.Status)
	require.Len(t, events, 1)
	event := events[0]
	require.Equal(t, refusal.ClassFacade, event.Class)
	require.Equal(t, "invalid_grant", event.Reason)
	require.Equal(t, 400, event.Status)
	require.Equal(t, "invalid_grant", event.ErrorCode)
	require.Equal(t, "POST", event.Method)
	require.Equal(t, harness.path(mcproutes.EndpointPath.OAuthTokenPath), event.Path)

	events = nil
	require.Equal(t, 200, harness.token(refreshTestForm(handle)).Status)
	require.Empty(t, events, "a served request must not report a refusal")

	// The unsupported-grant class is attributed to its own code, not folded into
	// invalid_grant.
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {frontTestClientID}}
	unsupported := harness.serve("POST", harness.path(mcproutes.EndpointPath.OAuthTokenPath), nil, []byte(form.Encode()))
	require.Equal(t, 400, unsupported.Status)
	require.Len(t, events, 1)
	require.Equal(t, "unsupported_grant_type", events[0].Reason)
}
