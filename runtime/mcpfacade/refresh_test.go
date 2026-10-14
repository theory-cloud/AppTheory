package mcpfacade

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
	"github.com/theory-cloud/apptheory/v6/testkit/oauthprovider"
)

const (
	// refreshTestVerifier is the PKCE verifier the harness's authorize leg pins.
	refreshTestVerifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"
	// refreshTestRedirectURI is the redirect URI the harness's client registered.
	refreshTestRedirectURI = "https://client.example/callback"
	// refreshTestOtherClientID is a second registered public client, used to prove
	// that a handle minted for one client is refused for another with the same
	// invalid_grant an unknown handle gets.
	refreshTestOtherClientID = "facade-client-2"
	// refreshTestBoundResource is the resource the harness's authorize leg binds.
	refreshTestBoundResource = frontTestBaseURL + "/acme/mcp"
)

// refreshTestCodeForm is the authorization_code exchange form the harness's
// authorize leg pins.
func refreshTestCodeForm(code string) url.Values {
	return url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {refreshTestVerifier},
		"redirect_uri":  {refreshTestRedirectURI},
		"client_id":     {frontTestClientID},
	}
}

// refreshTestForm is a refresh grant form for one handle presented by the
// harness's own client.
func refreshTestForm(handle string) url.Values {
	return url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {handle},
		"client_id":     {frontTestClientID},
	}
}

// refreshTestFormValue is refreshTestForm with one extra member set, so a row or
// a case can present a scope or a resource beside the handle.
func refreshTestFormValue(handle, name, value string) url.Values {
	form := refreshTestForm(handle)
	form.Set(name, value)
	return form
}

// refreshTestHandle reads the framework handle a token response handed the
// client.
func refreshTestHandle(t *testing.T, response apptheory.Response) string {
	t.Helper()
	var payload struct {
		RefreshToken string `json:"refresh_token"`
	}
	require.NoError(t, json.Unmarshal(response.Body, &payload))
	require.NotEmpty(t, payload.RefreshToken)
	return payload.RefreshToken
}

// refreshTestAccessToken reads the access token a token response returned.
func refreshTestAccessToken(t *testing.T, response apptheory.Response) string {
	t.Helper()
	var payload struct {
		AccessToken string `json:"access_token"`
	}
	require.NoError(t, json.Unmarshal(response.Body, &payload))
	require.NotEmpty(t, payload.AccessToken)
	return payload.AccessToken
}

// exchangeTheCode completes authorize, callback, and the code exchange, and
// returns the token response plus the redeemed facade code, so a refresh test
// starts from a genuinely minted handle.
func exchangeTheCode(t *testing.T, harness *frontChannelHarness) (apptheory.Response, string) {
	t.Helper()
	_, code := harness.authorizeAndCallback(refreshTestVerifier)
	response := harness.token(refreshTestCodeForm(code))
	require.Equal(t, 200, response.Status)
	return response, code
}

// mintedRefreshHandle runs the journey through the code exchange and returns the
// handle it minted.
func mintedRefreshHandle(t *testing.T, harness *frontChannelHarness) string {
	t.Helper()
	exchange, _ := exchangeTheCode(t, harness)
	return refreshTestHandle(t, exchange)
}

// brokerRecord reads the broker record a handle is keyed by.
func brokerRecord(t *testing.T, harness *frontChannelHarness, handle string) *oauthstore.RouteRefreshBrokerRecord {
	t.Helper()
	record, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(handle))
	require.NoError(t, err)
	return record
}

// registerOtherClient registers the second public client the other-client cases
// present their request as.
func registerOtherClient(t *testing.T, harness *frontChannelHarness) {
	t.Helper()
	require.NoError(t, harness.stores.Client.Put(context.Background(), &oauthstore.ClientRecord{
		ClientIDHash:            oauthstore.HashKey(refreshTestOtherClientID),
		ClientID:                refreshTestOtherClientID,
		RedirectURIs:            []string{refreshTestRedirectURI},
		TokenEndpointAuthMethod: "none",
	}))
}

// TestRefreshGrantDefaultsArePinned pins the brokered refresh framework defaults
// of operator ruling R3, so a change to any of them is a deliberate edit here
// rather than a silent behavior change. It also pins the two relationships the
// numbers have to satisfy: the coalesce wait cap must stay below the broker lock
// TTL (a waiter can never outlive and steal the lock it waits for), and the
// grace window must stay above that cap (a waiter that gives up inside the
// window still replays the successor on its next attempt).
func TestRefreshGrantDefaultsArePinned(t *testing.T) {
	require.Equal(t, 30*time.Second, refreshGraceWindow)
	require.Equal(t, 3*time.Second, refreshCoalesceWaitCap)
	require.Equal(t, 50*time.Millisecond, refreshCoalescePollInterval)
	require.Equal(t, 512, frontChannelMaxRefreshHandleBytes)
	require.Equal(t, 8, refreshRevokeChainLimit)
	require.Equal(t, 1, refreshRetryAfterSeconds)
	require.Less(t, refreshCoalesceWaitCap, oauthstore.DefaultRouteRefreshLockTTL)
	require.Greater(t, refreshGraceWindow, refreshCoalesceWaitCap)
}

// TestRefreshGrantRotatesTheHandleAndHidesUpstreamMaterial pins the happy
// rotation: the refresh answers 200 with the upstream access token byte-for-byte,
// a NEW framework handle, and no upstream refresh material and no id_token, and
// the presented record ends up holding the successor response as its grace body.
func TestRefreshGrantRotatesTheHandleAndHidesUpstreamMaterial(t *testing.T) {
	harness := newFrontChannelHarness(t)
	first := mintedRefreshHandle(t, harness)

	response := harness.token(refreshTestForm(first))
	require.Equal(t, 200, response.Status)
	body := string(response.Body)
	require.Contains(t, body, `"access_token":"`+frontTestRefreshAccessToken+`"`)
	require.Contains(t, body, `"token_type":"Bearer"`)
	require.Contains(t, body, `"scope":"`+frontTestRotatedUpstreamScope+`"`)
	require.NotContains(t, body, frontTestRefreshToken)
	require.NotContains(t, body, frontTestRotatedUpstreamRefreshToken)
	require.NotContains(t, body, frontTestRefreshIDToken)
	require.NotContains(t, body, "id_token")

	second := refreshTestHandle(t, response)
	require.NotEqual(t, first, second)

	successor := brokerRecord(t, harness, second)
	require.Equal(t, frontTestRotatedUpstreamRefreshToken, successor.EncryptedUpstreamRefreshToken)
	require.Equal(t, oauthstore.HashKey(frontTestRotatedUpstreamRefreshToken), successor.UpstreamRefreshTokenHash)
	require.Equal(t, oauthstore.BrokerStatusIssued, successor.Status)
	require.Equal(t, oauthstore.HashKey(frontTestClientID), successor.ClientIDHash)
	require.Equal(t, frontTestClientID, successor.UpstreamClientID)
	require.Equal(t, refreshTestBoundResource, successor.CanonicalResource)

	presented := brokerRecord(t, harness, first)
	require.Equal(t, oauthstore.BrokerStatusActive, presented.Status)
	require.Equal(t, string(response.Body), presented.EncryptedGraceRefreshResponse)
	require.Equal(t, harness.clock.Now().Add(refreshGraceWindow), presented.GraceExpiresAt)
	require.Empty(t, presented.RefreshLockOwner)
	require.True(t, presented.RefreshLockExpiresAt.IsZero())
}

// TestRefreshGrantMakesExactlyOneUpstreamCallPerRotation pins the single-flight
// upstream contract: the code exchange makes one token call, and each rotation
// makes exactly one more, presenting the recorded upstream material and the
// facade's own upstream client — never the framework handle.
func TestRefreshGrantMakesExactlyOneUpstreamCallPerRotation(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)
	require.Equal(t, 1, harness.fake.TokenCallCount())
	require.Equal(t, 0, harness.fake.RefreshCallCount())

	first := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, first.Status)
	require.Equal(t, 2, harness.fake.TokenCallCount())
	require.Equal(t, 1, harness.fake.RefreshCallCount())

	second := harness.token(refreshTestForm(refreshTestHandle(t, first)))
	require.Equal(t, 200, second.Status)
	require.Equal(t, 3, harness.fake.TokenCallCount())
	require.Equal(t, 2, harness.fake.RefreshCallCount())

	presented := harness.fake.LastRefreshRequest()
	require.Equal(t, frontTestRotatedUpstreamRefreshToken, presented.Get("refresh_token"))
	require.Equal(t, frontTestClientID, presented.Get("client_id"))

	// A grace replay makes no upstream call at all, so the count above is the
	// rotation count and not a call count.
	require.Equal(t, 200, harness.token(refreshTestForm(handle)).Status)
	require.Equal(t, 3, harness.fake.TokenCallCount())
	require.Equal(t, 2, harness.fake.RefreshCallCount())
}

// TestRefreshGrantReplaysTheSameSuccessorWithinTheGraceWindow pins the
// idempotent lost-response path: presenting the rotated handle again from the
// same client returns the identical status, headers, and body bytes, with no
// second upstream call, right up to the end of the window.
func TestRefreshGrantReplaysTheSameSuccessorWithinTheGraceWindow(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)

	first := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, first.Status)

	replayed := harness.token(refreshTestForm(handle))
	require.Equal(t, first.Status, replayed.Status)
	require.Equal(t, string(first.Body), string(replayed.Body))
	require.Equal(t, first.Headers["content-type"], replayed.Headers["content-type"])
	require.Equal(t, first.Headers["cache-control"], replayed.Headers["cache-control"])
	require.Equal(t, first.Headers["pragma"], replayed.Headers["pragma"])
	require.Equal(t, 1, harness.fake.RefreshCallCount())

	harness.clock.Advance(refreshGraceWindow - time.Second)
	justInside := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, justInside.Status)
	require.Equal(t, string(first.Body), string(justInside.Body))
	require.Equal(t, 1, harness.fake.RefreshCallCount())
}

// TestRefreshGrantAfterTheGraceWindowRevokesTheSuccessor pins reuse: presenting
// the rotated handle once the window has passed is refused with invalid_grant,
// the presented record is revoked, and the walk revokes the successor the
// rotation minted, so the successor handle is refused too.
func TestRefreshGrantAfterTheGraceWindowRevokesTheSuccessor(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)

	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)
	successor := refreshTestHandle(t, rotated)
	require.Equal(t, 1, harness.fake.RefreshCallCount())

	harness.clock.Advance(refreshGraceWindow + time.Second)
	reused := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, reused.Status)
	require.Contains(t, string(reused.Body), `"error":"invalid_grant"`)

	require.Equal(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, handle).Status)
	require.Equal(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, successor).Status)

	after := harness.token(refreshTestForm(successor))
	require.Equal(t, 400, after.Status)
	require.Contains(t, string(after.Body), `"error":"invalid_grant"`)
	require.Equal(t, 1, harness.fake.RefreshCallCount())
}

// TestRefreshGrantRefusalsAreOneInvalidGrantBody pins the no-oracle rule: an
// unknown handle, a revoked handle, and a handle presented by another registered
// client are one byte-identical invalid_grant response.
func TestRefreshGrantRefusalsAreOneInvalidGrantBody(t *testing.T) {
	unknownHarness := newFrontChannelHarness(t)
	unknownHandle, err := oauth.NewOpaqueToken()
	require.NoError(t, err)
	unknown := unknownHarness.token(refreshTestForm(unknownHandle))
	require.Equal(t, 400, unknown.Status)

	revokedHarness := newFrontChannelHarness(t)
	revokedHandle := mintedRefreshHandle(t, revokedHarness)
	_, err = revokedHarness.stores.RouteRefreshBroker.Revoke(context.Background(), oauthstore.HashKey(revokedHandle))
	require.NoError(t, err)
	revoked := revokedHarness.token(refreshTestForm(revokedHandle))
	require.Equal(t, 400, revoked.Status)

	otherHarness := newFrontChannelHarness(t)
	otherHandle := mintedRefreshHandle(t, otherHarness)
	registerOtherClient(t, otherHarness)
	form := refreshTestForm(otherHandle)
	form.Set("client_id", refreshTestOtherClientID)
	other := otherHarness.token(form)
	require.Equal(t, 400, other.Status)

	for index, response := range []apptheory.Response{unknown, revoked, other} {
		require.Equalf(t, 400, response.Status, "refusal %d", index)
		require.Containsf(t, string(response.Body), `"error":"invalid_grant"`, "refusal %d", index)
		require.Equalf(t, string(unknown.Body), string(response.Body), "refusal %d must be byte-identical", index)
	}
}

// TestRefreshGrantRefusesAHandleAtAnotherRoute pins the route binding of the
// broker record (DESIGN §7: the record binds the resource) against the real
// handlers, and pins that closing it does not open a handle-existence oracle: a
// handle minted at one route and presented at another route's token endpoint is
// refused with the SAME byte-identical invalid_grant an unknown handle gets,
// while the very same handle is still redeemable at the route it was minted for
// (so the refusal is the route and not a dead handle), and the tracked upstream
// refresh count proves the wrong-route attempt never reached the upstream.
func TestRefreshGrantRefusesAHandleAtAnotherRoute(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)

	unknown, err := oauth.NewOpaqueToken()
	require.NoError(t, err)
	unknownResponse := harness.token(refreshTestForm(unknown))
	require.Equal(t, 400, unknownResponse.Status)

	otherRoute := boundRouteEndpoint(t, boundRouteSecondRouteKey)
	before := harness.fake.RefreshCallCount()
	wrongRoute := harness.serve(
		"POST",
		boundRoutePath(t, otherRoute, mcproutes.EndpointPath.OAuthTokenPath),
		nil,
		[]byte(refreshTestForm(handle).Encode()),
	)
	require.Equal(t, 400, wrongRoute.Status)
	require.Contains(t, string(wrongRoute.Body), `"error":"invalid_grant"`)
	require.Equal(t, string(unknownResponse.Body), string(wrongRoute.Body),
		"a wrong-route handle must be the byte-identical unknown-handle refusal")
	require.Equal(t, before, harness.fake.RefreshCallCount(),
		"a wrong-route handle must not reach the upstream")

	ownRoute := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, ownRoute.Status)
	require.Equal(t, before+1, harness.fake.RefreshCallCount(),
		"the same handle must still be redeemable at the route it was minted for")
}

// TestRefreshGrantBindsScopeAndResource pins ruling R4: an absent scope or
// resource takes the recorded value, an exactly equal one is accepted, a subset
// (which the empty member expresses, because the granted set has one member) and
// a wider set are invalid_scope, and a mismatched resource is invalid_target.
func TestRefreshGrantBindsScopeAndResource(t *testing.T) {
	cases := []struct {
		name      string
		mutate    func(url.Values)
		wantError string
	}{
		{name: "absent_scope_and_resource_take_the_granted_values", mutate: func(url.Values) {}},
		{
			name: "exact_scope_and_resource_are_accepted",
			mutate: func(form url.Values) {
				form.Set("scope", frontTestRotatedUpstreamScope)
				form.Set("resource", refreshTestBoundResource)
			},
		},
		{name: "subset_scope_is_refused", mutate: func(form url.Values) { form.Set("scope", "") }, wantError: "invalid_scope"},
		{
			name:      "wider_scope_is_refused",
			mutate:    func(form url.Values) { form.Set("scope", frontTestRotatedUpstreamScope+" extra:scope") },
			wantError: "invalid_scope",
		},
		{
			name:      "mismatched_resource_is_refused",
			mutate:    func(form url.Values) { form.Set("resource", frontTestBaseURL+"/other/mcp") },
			wantError: "invalid_target",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newFrontChannelHarness(t)
			handle := mintedRefreshHandle(t, harness)
			form := refreshTestForm(handle)
			testCase.mutate(form)

			response := harness.token(form)
			if testCase.wantError == "" {
				require.Equal(t, 200, response.Status, string(response.Body))
				require.Contains(t, string(response.Body), `"access_token":"`+frontTestRefreshAccessToken+`"`)
				require.Equal(t, 1, harness.fake.RefreshCallCount())
				return
			}
			require.Equal(t, 400, response.Status, string(response.Body))
			require.Contains(t, string(response.Body), `"error":"`+testCase.wantError+`"`)
			// A refused request never reached the upstream, and the handle was not
			// rotated by it.
			require.Equal(t, 0, harness.fake.RefreshCallCount())
			require.Equal(t, oauthstore.BrokerStatusIssued, brokerRecord(t, harness, handle).Status)
		})
	}
}

// TestRefreshGrantBoundsThePresentedHandle pins the bound and the validation
// order of ruling R1: a missing, blank, or oversized handle is invalid_request
// before the client is even identified, while a well-formed handle with no
// client id is the client check's own invalid_client.
func TestRefreshGrantBoundsThePresentedHandle(t *testing.T) {
	harness := newFrontChannelHarness(t)
	oversized := strings.Repeat("a", frontChannelMaxRefreshHandleBytes+1)

	tooLong := harness.token(refreshTestForm(oversized))
	require.Equal(t, 400, tooLong.Status)
	require.Contains(t, string(tooLong.Body), `"error":"invalid_request"`)

	missing := harness.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {frontTestClientID}})
	require.Equal(t, 400, missing.Status)
	require.Equal(t, string(tooLong.Body), string(missing.Body))

	blank := harness.token(refreshTestForm(""))
	require.Equal(t, 400, blank.Status)
	require.Equal(t, string(tooLong.Body), string(blank.Body))

	// The bound is checked before the client lookup, so an oversized handle with
	// no client at all is still invalid_request ...
	noClient := harness.token(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {oversized}})
	require.Equal(t, 400, noClient.Status)
	require.Contains(t, string(noClient.Body), `"error":"invalid_request"`)

	// ... while a well-formed handle and no client is the client refusal.
	unidentified := harness.token(url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {strings.Repeat("a", 43)},
	})
	require.Equal(t, 400, unidentified.Status)
	require.Contains(t, string(unidentified.Body), `"error":"invalid_client"`)

	require.Equal(t, 0, harness.fake.RefreshCallCount())
}

// TestRefreshGrantReplayedCodeRevokesTheHandle pins journey step 9.1 / T2
// against the refresh grant: once the authorization code is replayed, the
// broker record the code minted is revoked, so the handle it had already rotated
// into the client's hands is refused.
func TestRefreshGrantReplayedCodeRevokesTheHandle(t *testing.T) {
	harness := newFrontChannelHarness(t)
	exchange, code := exchangeTheCode(t, harness)
	handle := refreshTestHandle(t, exchange)

	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)

	replay := harness.token(refreshTestCodeForm(code))
	require.Equal(t, 400, replay.Status)
	require.Contains(t, string(replay.Body), `"error":"invalid_grant"`)

	require.Equal(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, handle).Status)

	after := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, after.Status)
	require.Contains(t, string(after.Body), `"error":"invalid_grant"`)
	require.Equal(t, 1, harness.fake.RefreshCallCount())
}

// TestRefreshGrantConcurrentCallersReceiveOneSuccessor pins single-flight under
// concurrency: sixteen simultaneous presentations of one handle produce exactly
// one upstream refresh call, and every caller receives the same successor body
// bytes — the winner's response or the grace replay of it.
func TestRefreshGrantConcurrentCallersReceiveOneSuccessor(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)
	form := []byte(refreshTestForm(handle).Encode())

	const callers = 16
	statuses := make([]int, callers)
	bodies := make([][]byte, callers)
	var group sync.WaitGroup
	start := make(chan struct{})
	for index := 0; index < callers; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			<-start
			response := harness.serve("POST", harness.path(mcproutes.EndpointPath.OAuthTokenPath), nil, form)
			statuses[index] = response.Status
			bodies[index] = response.Body
		}(index)
	}
	close(start)
	group.Wait()

	require.Equal(t, 1, harness.fake.RefreshCallCount())
	for index := 0; index < callers; index++ {
		require.Equalf(t, 200, statuses[index], "caller %d body %s", index, bodies[index])
		require.Equalf(t, string(bodies[0]), string(bodies[index]), "caller %d must receive the winner's successor body", index)
	}
	require.Contains(t, string(bodies[0]), `"access_token":"`+frontTestRefreshAccessToken+`"`)
	// The successor handle the callers were all served is a framework handle, not
	// the handle they presented.
	require.NotEqual(t, handle, refreshTestHandle(t, apptheory.Response{Body: bodies[0]}))
}

// TestRefreshGrantConcurrentReuseAfterGraceRevokesOnce pins that reuse detection
// is safe under concurrency: once the grace window has passed, every concurrent
// presenter of the rotated handle is refused with invalid_grant, no upstream call
// is made, and the whole grant — the presented record and the successor it names
// — ends revoked. Revocation is idempotent, so more than one caller may perform
// it; the contract is that no caller is served and no caller can act on
// unrevoked state.
func TestRefreshGrantConcurrentReuseAfterGraceRevokesOnce(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)
	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)
	successor := refreshTestHandle(t, rotated)
	harness.clock.Advance(refreshGraceWindow + time.Second)

	form := []byte(refreshTestForm(handle).Encode())
	const callers = 16
	statuses := make([]int, callers)
	bodies := make([][]byte, callers)
	var group sync.WaitGroup
	start := make(chan struct{})
	for index := 0; index < callers; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			<-start
			response := harness.serve("POST", harness.path(mcproutes.EndpointPath.OAuthTokenPath), nil, form)
			statuses[index] = response.Status
			bodies[index] = response.Body
		}(index)
	}
	close(start)
	group.Wait()

	for index := 0; index < callers; index++ {
		require.Equalf(t, 400, statuses[index], "caller %d body %s", index, bodies[index])
		require.Containsf(t, string(bodies[index]), `"error":"invalid_grant"`, "caller %d", index)
		require.Equalf(t, string(bodies[0]), string(bodies[index]), "caller %d must receive the same refusal", index)
	}
	require.Equal(t, 1, harness.fake.RefreshCallCount())
	require.Equal(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, handle).Status)
	require.Equal(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, successor).Status)
}

// TestRefreshGrantLockContentionAnswersRetryable pins the coalesce wait cap: a
// caller that cannot take a lock another caller holds answers 503
// temporarily_unavailable with a Retry-After, makes no upstream call, and waits
// the whole cap first. This test takes about three seconds, because the cap is
// real elapsed time and the point is that the caller waits it rather than
// sampling less than it.
func TestRefreshGrantLockContentionAnswersRetryable(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)
	record := brokerRecord(t, harness, handle)
	locked, err := harness.stores.RouteRefreshBroker.AcquireLock(
		context.Background(), oauthstore.HashKey(handle), "test-holder", record.Version)
	require.NoError(t, err)
	require.Equal(t, oauthstore.BrokerStatusRefreshing, locked.Status)

	start := time.Now()
	response := harness.token(refreshTestForm(handle))
	elapsed := time.Since(start)

	require.Equal(t, 503, response.Status)
	require.Contains(t, string(response.Body), `"error":"temporarily_unavailable"`)
	values := response.Headers["retry-after"]
	require.NotEmpty(t, values)
	seconds, err := strconv.Atoi(values[0])
	require.NoError(t, err)
	require.GreaterOrEqual(t, seconds, 1)
	require.GreaterOrEqual(t, elapsed, refreshCoalesceWaitCap)
	require.Less(t, elapsed, refreshCoalesceWaitCap+30*time.Second)
	require.Equal(t, 0, harness.fake.RefreshCallCount())

	// The caller that holds the lock is untouched by the waiter.
	held := brokerRecord(t, harness, handle)
	require.Equal(t, "test-holder", held.RefreshLockOwner)
}

// TestRefreshGrantVersionConflictRetryYields pins ADV-1146-3: a lock acquisition
// that fails with a version conflict is retried until the coalesce cap, and every
// retry waits one poll interval first. A store that keeps returning a stale
// version would otherwise re-poll in a tight spin for the whole cap; with the
// 50 ms poll interval the loop takes about cap/interval ≈ 60 iterations over three
// seconds, so a bounded iteration count and the measured minimum gap between
// attempts are what prove the wait rather than a spin. Removing the poll sleep
// fails this test (the count jumps by orders of magnitude) and drifting the
// interval moves the count out of the band, so the constant cannot change
// silently. It also doubles as the numeric pin of the poll interval, whose exact
// value the defaults test already pins.
func TestRefreshGrantVersionConflictRetryYields(t *testing.T) {
	harness := newFrontChannelHarness(t)
	handle := mintedRefreshHandle(t, harness)

	var mu sync.Mutex
	var attempts int
	var gaps []time.Duration
	var last time.Time
	harness.broker.acquireLockFn = func(
		context.Context, string, string, int,
	) (*oauthstore.RouteRefreshBrokerRecord, error) {
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		if !last.IsZero() {
			gaps = append(gaps, now.Sub(last))
		}
		last = now
		attempts++
		return nil, oauthstore.ErrBrokerVersionConflict
	}

	start := time.Now()
	response := harness.token(refreshTestForm(handle))
	elapsed := time.Since(start)

	require.Equal(t, 503, response.Status)
	require.Contains(t, string(response.Body), `"error":"temporarily_unavailable"`)
	require.GreaterOrEqual(t, elapsed, refreshCoalesceWaitCap)
	require.Equal(t, 0, harness.fake.RefreshCallCount())

	mu.Lock()
	got := attempts
	observed := append([]time.Duration(nil), gaps...)
	mu.Unlock()

	// cap/interval = 3 s / 50 ms = 60. A spin (no poll sleep) reaches this count
	// in microseconds and would be orders of magnitude larger, so the upper bound
	// is what the mutation proof rests on; the lower bound catches a drifted-up
	// interval.
	require.GreaterOrEqual(t, got, 35)
	require.LessOrEqual(t, got, 100)
	require.NotEmpty(t, observed)
	for _, gap := range observed {
		require.GreaterOrEqual(t, gap, refreshCoalescePollInterval,
			"every version-conflict re-poll must wait a poll interval")
	}
}

// TestRefreshGrantTerminalUpstreamFailureRevokes pins the terminal provider
// failure: the recorded upstream material is dead, so the facade answers
// invalid_grant and revokes the presented record, and a later attempt never
// reaches the upstream again.
func TestRefreshGrantTerminalUpstreamFailureRevokes(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		providerOptions: func(options *oauthprovider.Options) {
			options.RefreshTokenStatus = 400
			options.RefreshTokenBody = map[string]any{"error": "invalid_grant"}
		},
	})
	handle := mintedRefreshHandle(t, harness)

	response := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, response.Status)
	require.Contains(t, string(response.Body), `"error":"invalid_grant"`)
	require.Equal(t, 1, harness.fake.RefreshCallCount())
	require.Equal(t, oauthstore.BrokerStatusRevoked, brokerRecord(t, harness, handle).Status)

	after := harness.token(refreshTestForm(handle))
	require.Equal(t, 400, after.Status)
	require.Contains(t, string(after.Body), `"error":"invalid_grant"`)
	require.Equal(t, 1, harness.fake.RefreshCallCount())
}

// TestRefreshGrantTransientUpstreamFailureKeepsTheHandle pins the transient
// provider failure: the facade answers 503 temporarily_unavailable with a
// Retry-After, releases the lock and restores the record's status, and does not
// revoke the grant, so the very next attempt reaches the upstream again and
// rotates.
func TestRefreshGrantTransientUpstreamFailureKeepsTheHandle(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		providerOptions: func(options *oauthprovider.Options) {
			options.RefreshTokenStages = []oauthprovider.RefreshStage{{
				Status: 503,
				Body:   map[string]any{"error": "temporarily_unavailable"},
			}}
		},
	})
	handle := mintedRefreshHandle(t, harness)

	failed := harness.token(refreshTestForm(handle))
	require.Equal(t, 503, failed.Status)
	require.Contains(t, string(failed.Body), `"error":"temporarily_unavailable"`)
	require.Equal(t, []string{strconv.Itoa(refreshRetryAfterSeconds)}, failed.Headers["retry-after"])
	require.Equal(t, 1, harness.fake.RefreshCallCount())

	released := brokerRecord(t, harness, handle)
	require.Equal(t, oauthstore.BrokerStatusIssued, released.Status)
	require.Empty(t, released.RefreshLockOwner)
	require.True(t, released.RefreshLockExpiresAt.IsZero())

	recovered := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, recovered.Status)
	require.Contains(t, string(recovered.Body), `"access_token":"`+frontTestRefreshAccessToken+`"`)
	require.NotEqual(t, handle, refreshTestHandle(t, recovered))
	require.Equal(t, 2, harness.fake.RefreshCallCount())
	require.Equal(t, oauthstore.BrokerStatusActive, brokerRecord(t, harness, handle).Status)
}

// TestRefreshGrantResponsesNeverCarryUpstreamMaterial scans every response and
// every client-presented form of a whole refresh journey against the upstream
// material the fake served: the upstream refresh tokens, the upstream id_token,
// the PKCE verifier, the upstream code, and the client state never appear
// anywhere, the upstream access tokens appear only in the responses that
// deliberately return them to their owner, and the facade code appears only in
// the callback that delivers it.
func TestRefreshGrantResponsesNeverCarryUpstreamMaterial(t *testing.T) {
	harness := newFrontChannelHarness(t)

	authorize := harness.authorize(nil)
	require.Equal(t, 302, authorize.Status)
	callback := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {frontTestUpstreamCode},
		"state": {locationQuery(t, authorize).Get("state")},
		"iss":   {frontTestUpstreamIss},
	}, nil)
	require.Equal(t, 302, callback.Status)
	code := locationQuery(t, callback).Get("code")
	require.NotEmpty(t, code)

	exchangeForm := refreshTestCodeForm(code)
	exchange := harness.token(exchangeForm)
	require.Equal(t, 200, exchange.Status)
	handle := refreshTestHandle(t, exchange)

	rotated := harness.token(refreshTestForm(handle))
	require.Equal(t, 200, rotated.Status)
	grace := harness.token(refreshTestForm(handle))
	scopeRefused := harness.token(refreshTestFormValue(handle, "scope", frontTestRotatedUpstreamScope+" extra:scope"))
	resourceRefused := harness.token(refreshTestFormValue(handle, "resource", frontTestBaseURL+"/other/mcp"))
	oversized := harness.token(refreshTestForm(strings.Repeat("a", frontChannelMaxRefreshHandleBytes+1)))

	// The two access tokens the design delivers, and the only responses allowed to
	// carry each one.
	exchangedToken := refreshTestAccessToken(t, exchange)
	rotatedToken := refreshTestAccessToken(t, rotated)
	delivered := map[string]map[string]struct{}{
		exchangedToken: {"code_exchange": {}},
		rotatedToken:   {"refresh": {}, "grace_replay": {}},
	}

	responses := []struct {
		name     string
		response apptheory.Response
		codeOK   bool
		stateOK  bool
	}{
		{name: "authorize", response: authorize},
		{name: "callback", response: callback, codeOK: true, stateOK: true},
		{name: "code_exchange", response: exchange},
		{name: "refresh", response: rotated},
		{name: "grace_replay", response: grace},
		{name: "scope_refused", response: scopeRefused},
		{name: "resource_refused", response: resourceRefused},
		{name: "oversized_handle", response: oversized},
	}

	secrets := []string{
		frontTestRefreshToken,
		frontTestRotatedUpstreamRefreshToken,
		frontTestRefreshIDToken,
		"id_token",
		refreshTestVerifier,
		frontTestUpstreamCode,
	}
	for _, entry := range responses {
		scanned := responseScan(entry.response)
		for _, secret := range secrets {
			require.NotContainsf(t, scanned, secret, "%s response must not carry %q", entry.name, secret)
		}
		// The client's own state is returned to it by the callback that receives
		// it and by nothing else.
		if !entry.stateOK {
			require.NotContainsf(t, scanned, frontTestClientState, "%s response must not carry the client state", entry.name)
		}
		if !entry.codeOK {
			require.NotContainsf(t, scanned, code, "%s response must not carry the facade code", entry.name)
		}
		for token, names := range delivered {
			if _, ok := names[entry.name]; ok {
				continue
			}
			require.NotContainsf(t, scanned, token, "%s response must not carry an access token delivered elsewhere", entry.name)
		}
	}
	require.Contains(t, responseScan(exchange), exchangedToken)
	require.Contains(t, responseScan(rotated), rotatedToken)
	require.Contains(t, responseScan(grace), rotatedToken)

	// The client-presented forms carry the framework handle and nothing upstream.
	forms := []url.Values{exchangeForm, refreshTestForm(handle), refreshTestForm(refreshTestHandle(t, rotated))}
	for _, form := range forms {
		encoded := form.Encode()
		require.NotContains(t, encoded, frontTestRefreshToken)
		require.NotContains(t, encoded, frontTestRotatedUpstreamRefreshToken)
		require.NotContains(t, encoded, frontTestRefreshIDToken)
		require.NotContains(t, encoded, frontTestRefreshAccessToken)
	}

	// Positive control: the one form that must carry the upstream material — the
	// facade's own upstream refresh call — does, with the facade's own upstream
	// client, and never the framework handle the client presented.
	upstreamForm := harness.fake.LastRefreshRequest()
	require.Equal(t, frontTestRefreshToken, upstreamForm.Get("refresh_token"))
	require.Equal(t, frontTestClientID, upstreamForm.Get("client_id"))
	require.NotEqual(t, handle, upstreamForm.Get("refresh_token"))
}

// refreshGroup names the brokered refresh group the shared table carries,
// executed below through the real mounted token handler.
const refreshGroup = "refresh"

// refreshCaseCount is the number of refresh rows the shared fixture must carry; a
// change to the table must also be a deliberate edit in the Go, TypeScript, and
// Python loaders, so no runtime can silently execute a smaller table.
const refreshCaseCount = 15

// refreshConformanceDocument and refreshConformanceCase are the refresh rows.
// Each row names the scenario the loader implements after the common setup, and
// the response the real handler must answer with.
type refreshConformanceDocument struct {
	Cases []refreshConformanceCase `json:"cases"`
}

type refreshConformanceCase struct {
	ID               string   `json:"id"`
	Group            string   `json:"group"`
	Scenario         string   `json:"scenario"`
	ExpectStatus     int      `json:"expect_status"`
	ExpectError      string   `json:"expect_error"`
	ExpectRetryAfter bool     `json:"expect_retry_after"`
	ExpectAbsent     []string `json:"expect_absent"`
}

// TestRefreshGrantEnforcesTheSharedRefreshTable pins the brokered refresh grant
// to the shared cross-runtime table through the real token handler. Every row
// runs against a fresh mounted app and starts from the same setup — authorize,
// callback, and the code exchange — so each row presents a genuinely minted
// route handle rather than a seeded record.
func TestRefreshGrantEnforcesTheSharedRefreshTable(t *testing.T) {
	var document refreshConformanceDocument
	loadFacadeConformanceFixture(t, &document)

	rows := make([]refreshConformanceCase, 0, len(document.Cases))
	for _, row := range document.Cases {
		require.NotEmptyf(t, row.Group, "case %q must carry a group", row.ID)
		if row.Group == refreshGroup {
			rows = append(rows, row)
		}
	}
	require.Equalf(t, refreshCaseCount, len(rows), "loaded %d %q cases", len(rows), refreshGroup)

	executed := 0
	for _, row := range rows {
		executed++
		t.Run(row.ID, func(t *testing.T) {
			harness := newFrontChannelHarnessWith(t, refreshScenarioHarnessOptions(row.Scenario))
			response := refreshScenarioResponse(t, harness, row.Scenario)

			require.Equalf(t, row.ExpectStatus, response.Status, "row %q body %q", row.ID, response.Body)
			if row.ExpectError != "" {
				require.Containsf(t, string(response.Body), `"error":"`+row.ExpectError+`"`, "row %q", row.ID)
			}
			if row.ExpectRetryAfter {
				values := response.Headers["retry-after"]
				require.NotEmptyf(t, values, "row %q must carry a Retry-After header", row.ID)
				seconds, err := strconv.Atoi(values[0])
				require.NoErrorf(t, err, "row %q must carry a whole-second Retry-After", row.ID)
				require.GreaterOrEqualf(t, seconds, 1, "row %q", row.ID)
			}
			scanned := responseScan(response)
			for _, absent := range row.ExpectAbsent {
				require.NotContainsf(t, scanned, absent, "row %q must not carry %q", row.ID, absent)
			}
		})
	}

	require.Equalf(t, refreshCaseCount, executed, "executed %d %q cases", executed, refreshGroup)
}

// refreshScenarioHarnessOptions stages the fake upstream a row's scenario needs.
// Only the two upstream-failure scenarios need anything but the default fake.
func refreshScenarioHarnessOptions(scenario string) frontChannelHarnessOptions {
	switch scenario {
	case "upstream_terminal_failure":
		return frontChannelHarnessOptions{providerOptions: func(options *oauthprovider.Options) {
			options.RefreshTokenStatus = 400
			options.RefreshTokenBody = map[string]any{"error": "invalid_grant"}
		}}
	case "upstream_transient_failure":
		return frontChannelHarnessOptions{providerOptions: func(options *oauthprovider.Options) {
			options.RefreshTokenStatus = 503
			options.RefreshTokenBody = map[string]any{"error": "temporarily_unavailable"}
		}}
	default:
		return frontChannelHarnessOptions{}
	}
}

// refreshScenarioResponse performs the common setup and then the row's scenario,
// returning the response the row's expectation applies to.
func refreshScenarioResponse(
	t *testing.T,
	harness *frontChannelHarness,
	scenario string,
) apptheory.Response {
	t.Helper()
	exchange, code := exchangeTheCode(t, harness)
	handle := refreshTestHandle(t, exchange)

	switch scenario {
	case "happy_rotation":
		return harness.token(refreshTestForm(handle))
	case "reuse_within_grace_returns_same_tokens":
		first := harness.token(refreshTestForm(handle))
		require.Equal(t, 200, first.Status)
		replayed := harness.token(refreshTestForm(handle))
		require.Equal(t, string(first.Body), string(replayed.Body), "the grace replay must be byte-identical")
		return replayed
	case "reuse_after_grace_revokes":
		require.Equal(t, 200, harness.token(refreshTestForm(handle)).Status)
		harness.clock.Advance(refreshGraceWindow + time.Second)
		return harness.token(refreshTestForm(handle))
	case "unknown_handle":
		unknown, err := oauth.NewOpaqueToken()
		require.NoError(t, err)
		return harness.token(refreshTestForm(unknown))
	case "other_client_handle":
		registerOtherClient(t, harness)
		form := refreshTestForm(handle)
		form.Set("client_id", refreshTestOtherClientID)
		return harness.token(form)
	case "handle_at_another_route_refused":
		return harness.serve(
			"POST",
			boundRoutePath(t, boundRouteEndpoint(t, boundRouteSecondRouteKey), mcproutes.EndpointPath.OAuthTokenPath),
			nil,
			[]byte(refreshTestForm(handle).Encode()),
		)
	case "scope_subset_refused":
		return harness.token(refreshTestFormValue(handle, "scope", ""))
	case "scope_exact_accepted":
		return harness.token(refreshTestFormValue(handle, "scope", frontTestRotatedUpstreamScope))
	case "resource_mismatch_refused":
		return harness.token(refreshTestFormValue(handle, "resource", frontTestBaseURL+"/other/mcp"))
	case "resource_exact_accepted":
		return harness.token(refreshTestFormValue(handle, "resource", refreshTestBoundResource))
	case "oversized_handle_refused":
		return harness.token(refreshTestForm(strings.Repeat("a", frontChannelMaxRefreshHandleBytes+1)))
	case "missing_handle_refused":
		return harness.token(url.Values{"grant_type": {"refresh_token"}, "client_id": {frontTestClientID}})
	case "replayed_code_revokes_handle":
		require.Equal(t, 200, harness.token(refreshTestForm(handle)).Status)
		require.Equal(t, 400, harness.token(refreshTestCodeForm(code)).Status)
		return harness.token(refreshTestForm(handle))
	case "upstream_terminal_failure", "upstream_transient_failure":
		return harness.token(refreshTestForm(handle))
	default:
		t.Fatalf("unknown refresh scenario %q", scenario)
		return apptheory.Response{}
	}
}
