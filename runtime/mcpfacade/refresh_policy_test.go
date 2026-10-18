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
// requires an operator to attribute is emitted by the real request path.
func TestRouteRefreshTelemetryCoversTheTaxonomy(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{routeRefreshEvents: recorder.add})
	handle := mintedRefreshHandle(t, harness)

	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)

	harness.clock.Advance(DefaultRefreshGraceWindow - time.Second)
	grace := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, grace.Status)

	harness.clock.Advance(2 * time.Second)
	benign := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, benign.Status)
	require.NotContains(t, string(benign.Body), "refresh_token")

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
	reuse := recorder.requireClass(t, RouteRefreshEventReuse, RouteRefreshOutcomeAccessTokenOnly)
	require.Equal(t, 1, reuse.ChainDepth)
	require.Equal(t, oauthstore.BrokerStatusActive, reuse.StatusTo)

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
		refreshTestHandle(t, rotated),
	} {
		require.NotContainsf(t, string(encoded), secret, "telemetry must carry hashes, never raw material")
	}
}

// TestRouteRefreshTelemetryAttributesUpstreamRejection pins the upstream
// attribution class: a terminal upstream rejection revokes the presented record
// and reports the provider class.
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

// TestRouteRefreshLegacyRecordIsClassifiedStructurallyAndWalkRevoked pins the
// pre-policy default: a family-less, generation-0 rotated-away record is
// classified by the successor walk (not by arithmetic), serves the access token
// only once, and its second presentation revokes through the bounded walk
// because it has no family to revoke.
func TestRouteRefreshLegacyRecordIsClassifiedStructurallyAndWalkRevoked(t *testing.T) {
	recorder := &eventRecorder{}
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{routeRefreshEvents: recorder.add})
	successorHandle, err := newTestHandle()
	require.NoError(t, err)
	legacyHandle, err := newTestHandle()
	require.NoError(t, err)

	seedLegacyRotatedRecord(t, harness, legacyHandle, successorHandle)
	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)

	served := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 200, served.Status)
	require.Contains(t, string(served.Body), `"access_token":"legacy-access-token"`)
	require.NotContains(t, string(served.Body), "refresh_token")

	reuse := recorder.requireClass(t, RouteRefreshEventReuse, RouteRefreshOutcomeAccessTokenOnly)
	require.Equal(t, 1, reuse.ChainDepth)
	require.Zero(t, reuse.ChainGeneration)

	second := harness.token(refreshTestForm(legacyHandle))
	require.Equal(t, 400, second.Status)
	require.Contains(t, string(second.Body), `"error":"invalid_grant"`)
	revoked := recorder.requireClass(t, RouteRefreshEventReuse, RouteRefreshOutcomeRevokedWalk)
	require.Equal(t, 2, revoked.RevokedRecords)

	require.Equal(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, legacyHandle).Status)
	require.Equal(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, successorHandle).Status)
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

// TestRouteRefreshFamilyRevokeBeatsTheWalkLimit pins revoke-by-family: a chain
// longer than the eight-link successor walk is revoked completely, so a
// confirmed theft cannot leave live members behind.
func TestRouteRefreshFamilyRevokeBeatsTheWalkLimit(t *testing.T) {
	harness := newFrontChannelHarness(t)
	root := mintedRefreshHandle(t, harness)
	handles := []string{root}
	head := root
	for rotation := 0; rotation < refreshRevokeChainLimit+2; rotation++ {
		response := harness.token(refreshTestForm(head))
		require.Equalf(t, 200, response.Status, "rotation %d body %s", rotation, response.Body)
		head = refreshTestHandle(t, response)
		handles = append(handles, head)
	}
	require.Len(t, handles, refreshRevokeChainLimit+3)

	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
	reused := harness.token(refreshTestForm(root))
	require.Equal(t, 400, reused.Status)
	require.Contains(t, string(reused.Body), `"error":"invalid_grant"`)

	for _, handle := range handles {
		require.Equalf(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, handle).Status, "handle %s", handle)
	}
}

// TestRouteRefreshDepthOneIsBudgetedPerFamily pins the per-family repeat-rate
// ceiling: benign depth-1 serves are allowed up to the configured budget, and
// the next one is refused without revoking the family. Each cycle rotates the
// head, closes the predecessor's grace window, and presents the predecessor, so
// every serve is a distinct immediate-predecessor replay.
func TestRouteRefreshDepthOneIsBudgetedPerFamily(t *testing.T) {
	harness := newFrontChannelHarness(t)
	head := mintedRefreshHandle(t, harness)

	for served := 0; served < MinRefreshReuseRateCeiling; served++ {
		rotated := harness.token(refreshTestForm(head))
		require.Equalf(t, 200, rotated.Status, "rotation %d body %s", served, rotated.Body)
		predecessor := head
		head = refreshTestHandle(t, rotated)
		harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
		response := harness.token(refreshTestForm(predecessor))
		require.Equalf(t, 200, response.Status, "serve %d body %s", served, response.Body)
		require.NotContains(t, string(response.Body), "refresh_token")
	}

	rotated := harness.token(refreshTestForm(head))
	require.Equal(t, 200, rotated.Status)
	predecessor := head
	head = refreshTestHandle(t, rotated)
	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
	limited := harness.token(refreshTestForm(predecessor))
	require.Equal(t, 400, limited.Status)
	require.Contains(t, string(limited.Body), `"error":"invalid_grant"`)
	require.NotContains(t, string(limited.Body), "access_token")
	require.NotEqual(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, head).Status,
		"a rate-limited serve must not revoke the family")
}

// TestRouteRefreshHandleIsSingleUseBeyondGrace pins the once-per-handle bound:
// the first beyond-grace serve writes the marker under the lock, and a later
// presentation is theft class even after the rate window resets.
func TestRouteRefreshHandleIsSingleUseBeyondGrace(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)
	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)
	successor := refreshTestHandle(t, rotated)

	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)
	first := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, first.Status)
	record := brokerRecord(t, harness, handle)
	require.False(t, record.DepthOneServedAt.IsZero())

	// A second presentation is theft class even though the per-family budget has
	// barely been touched.
	second := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, second.Status)
	require.Equal(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, handle).Status)
	require.Equal(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, successor).Status)
}

// newTestHandle mints a route handle shaped exactly like the framework's own.
func newTestHandle() (string, error) {
	return oauth.NewOpaqueToken()
}

// TestRouteRefreshGraceBoundaryIsExclusive pins the boundary-inclusivity
// decision: a replay at exactly the grace deadline is beyond grace.
func TestRouteRefreshGraceBoundaryIsExclusive(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)
	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)

	harness.clock.Advance(DefaultRefreshGraceWindow)
	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, response.Status)
	require.NotContains(t, string(response.Body), "refresh_token",
		"a replay at exactly the grace deadline is beyond grace")
}

// TestRouteRefreshLockContentionOnDepthOneRetries pins that a busy record is
// retried inside the coalesce window before classification, so a concurrent
// rotation does not turn a benign presentation into an immediate refusal.
func TestRouteRefreshLockContentionOnDepthOneRetries(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)
	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)
	harness.clock.Advance(DefaultRefreshGraceWindow + time.Second)

	record := brokerRecord(t, harness, handle)
	_, err := harness.stores.RouteRefreshBroker.AcquireLock(
		context.Background(), record.HandleHash, "test-holder", record.Version)
	require.NoError(t, err)

	// The holder releases the lock after a moment, so the retrying caller
	// observes the unlocked record and serves it.
	go func() {
		time.Sleep(100 * time.Millisecond)
		held, getErr := harness.stores.RouteRefreshBroker.Get(context.Background(), record.HandleHash)
		if getErr != nil {
			return
		}
		held.RefreshLockOwner = ""
		held.RefreshLockExpiresAt = time.Time{}
		held.Status = oauthstore.BrokerStatusActive
		if _, swapErr := harness.stores.RouteRefreshBroker.CompareAndSwap(
			context.Background(), held, held.Version,
		); swapErr != nil {
			return
		}
	}()

	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, response.Status)
	require.NotContains(t, string(response.Body), "refresh_token")
}
