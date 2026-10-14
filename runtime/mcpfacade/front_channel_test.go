package mcpfacade

import (
	"context"
	"encoding/json"
	"net/url"
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
	frontTestBaseURL      = "https://mcp.example.com"
	frontTestUpstreamIss  = "https://id.example.com"
	frontTestClientID     = "facade-client-1"
	frontTestUpstreamCode = "upstream-authorization-code"
	frontTestRefreshToken = "upstream-refresh-token-value"
	frontTestClientState  = "client-state-1"
)

// mintingProvider wraps the real Autheory adapter. Every leg is the adapter
// over the fake provider's loopback HTTP except ExchangeCode, which first runs
// the adapter's real server-side exchange (so the upstream form and client are
// genuinely presented and recorded) and then returns a token set whose access
// token the fake signs, so the facade's JWKS validation of the exchanged token
// is exercised against a real signature.
type mintingProvider struct {
	oauth.Provider
	server *oauthprovider.Server
	claims oauthprovider.Claims
}

func (p *mintingProvider) ExchangeCode(ctx context.Context, req oauth.CodeExchangeRequest) (*oauth.TokenSet, error) {
	if _, err := p.Provider.ExchangeCode(ctx, req); err != nil {
		return nil, err
	}
	return &oauth.TokenSet{
		AccessToken:  p.server.MintAccessToken(p.claims),
		RefreshToken: frontTestRefreshToken,
		TokenType:    "Bearer",
		ExpiresIn:    900,
		Scope:        "mcp:tools",
	}, nil
}

type frontChannelHarness struct {
	t      *testing.T
	app    *apptheory.App
	fake   *oauthprovider.Server
	clock  *oauthstore.ManualClock
	stores oauthstore.Stores
	broker *recordingBrokerStore
	kind   mcproutes.EndpointKind
}

// recordingBrokerStore decorates the reference broker store and records every
// handle it is seeded with, so a test can observe the record a callback opened
// without the front channel having to expose it.
type recordingBrokerStore struct {
	oauthstore.RouteRefreshBrokerStore
	oauthstore.RouteRefreshBrokerSeeder

	mu      sync.Mutex
	handles []string
}

func (s *recordingBrokerStore) Put(ctx context.Context, record *oauthstore.RouteRefreshBrokerRecord) error {
	s.mu.Lock()
	s.handles = append(s.handles, record.HandleHash)
	s.mu.Unlock()
	return s.RouteRefreshBrokerSeeder.Put(ctx, record)
}

func (s *recordingBrokerStore) handleHashes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.handles...)
}

func newFrontChannelHarness(t *testing.T) *frontChannelHarness {
	t.Helper()
	clock := oauthstore.NewManualClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	broker := &recordingBrokerStore{
		RouteRefreshBrokerStore:  oauthstore.NewMemoryRouteRefreshBrokerStore(oauthstore.RouteRefreshBrokerStoreOptions{Now: clock.Now}),
		RouteRefreshBrokerSeeder: nil,
	}
	broker.RouteRefreshBrokerSeeder = broker.RouteRefreshBrokerStore.(oauthstore.RouteRefreshBrokerSeeder)
	stores := oauthstore.Stores{
		Transaction:        oauthstore.NewMemoryTransactionStore(oauthstore.TransactionStoreOptions{Now: clock.Now}),
		AuthorizationCode:  oauthstore.NewMemoryAuthorizationCodeStore(oauthstore.AuthorizationCodeStoreOptions{Now: clock.Now}),
		Client:             oauthstore.NewMemoryClientStore(oauthstore.ClientStoreOptions{Now: clock.Now}),
		RouteRefreshBroker: broker,
		RateLimit:          oauthstore.NewMemoryRateLimitStore(oauthstore.RateLimitStoreOptions{Now: clock.Now}),
	}

	fake := oauthprovider.NewServer(t, oauthprovider.Options{
		Issuer: frontTestUpstreamIss,
		TokenBody: map[string]any{
			"access_token":  "placeholder-upstream-access-token",
			"token_type":    "Bearer",
			"expires_in":    900,
			"refresh_token": frontTestRefreshToken,
			"scope":         "mcp:tools",
		},
	})
	adapter, err := oauth.NewAutheoryProvider(oauth.AutheoryProviderOptions{
		Issuer:            fake.Issuer(),
		ClientID:          frontTestClientID,
		HTTPClient:        fake.HTTPClient(),
		AllowPrivateHosts: true,
	})
	require.NoError(t, err)

	kind := mcproutes.EndpointKindNamespace
	config := FacadeConfig{
		IssuerURL:        frontTestBaseURL + "/acme/mcp",
		JWKSURI:          frontTestUpstreamIss + "/.well-known/jwks.json",
		IssuerMode:       mcproutes.IssuerModeRoute,
		URLMode:          URLModePublicBaseURL,
		PublicBaseURL:    frontTestBaseURL,
		TransportPosture: TransportPostureIAM,
		Scopes: map[mcproutes.EndpointKind][]string{
			mcproutes.EndpointKindNamespace:        {"mcp:tools"},
			mcproutes.EndpointKindPartnerNamespace: {"mcp:tools"},
			mcproutes.EndpointKindAgent:            {"mcp:tools"},
			mcproutes.EndpointKindPartnerAgent:     {"mcp:tools"},
		},
		MCPHandler: func(*apptheory.Context) (*apptheory.Response, error) { return apptheory.NoContent(), nil },
		Provider: &mintingProvider{
			Provider: adapter,
			server:   fake,
			claims: oauthprovider.Claims{
				Issuer:          frontTestUpstreamIss,
				Audience:        frontTestBaseURL + "/acme/mcp",
				AuthorizedParty: frontTestClientID,
				Subject:         "user-1",
				Scope:           "mcp:tools",
				ExpiresIn:       900,
			},
		},
		Stores:           stores,
		UpstreamClientID: frontTestClientID,
		UpstreamIssuer:   frontTestUpstreamIss,
	}
	require.NoError(t, stores.Client.Put(context.Background(), &oauthstore.ClientRecord{
		ClientIDHash:            oauthstore.HashKey(frontTestClientID),
		ClientID:                frontTestClientID,
		RedirectURIs:            []string{"https://client.example/callback"},
		TokenEndpointAuthMethod: "none",
	}))

	app := apptheory.New()
	_, err = RegisterMCPFacade(app, config)
	require.NoError(t, err)
	return &frontChannelHarness{t: t, app: app, fake: fake, clock: clock, stores: stores, broker: broker, kind: kind}
}

func (h *frontChannelHarness) endpoint() mcproutes.EndpointPath {
	return mcproutes.EndpointPath{Kind: h.kind, ClientNamespace: "acme"}
}

func (h *frontChannelHarness) path(build func(mcproutes.EndpointPath) (string, error)) string {
	h.t.Helper()
	path, err := build(h.endpoint())
	require.NoError(h.t, err)
	return path
}

func (h *frontChannelHarness) serve(method, path string, query url.Values, body []byte) apptheory.Response {
	h.t.Helper()
	request := apptheory.Request{Method: method, Path: path}
	if query != nil {
		request.Query = query
	}
	request.Body = body
	return h.app.Serve(context.Background(), request)
}

// authorize runs one authorizing request and returns the response.
func (h *frontChannelHarness) authorize(mutate func(url.Values)) apptheory.Response {
	h.t.Helper()
	verifier := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"
	challenge, err := oauth.PKCEChallengeS256(verifier)
	require.NoError(h.t, err)
	query := url.Values{
		"client_id":             {frontTestClientID},
		"redirect_uri":          {"https://client.example/callback"},
		"response_type":         {"code"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"state":                 {frontTestClientState},
		"resource":              {frontTestBaseURL + "/acme/mcp"},
	}
	if mutate != nil {
		mutate(query)
	}
	return h.serve("GET", h.path(mcproutes.EndpointPath.OAuthAuthorizePath), query, nil)
}

// authorizeAndCallback completes authorize + callback and returns the callback
// response, so a token step has a real facade code to redeem.
func (h *frontChannelHarness) authorizeAndCallback(verifier string) (apptheory.Response, string) {
	h.t.Helper()
	authorizeResponse := h.authorize(nil)
	require.Equal(h.t, 302, authorizeResponse.Status)
	upstreamState := locationQuery(h.t, authorizeResponse).Get("state")

	callback := h.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {frontTestUpstreamCode},
		"state": {upstreamState},
		"iss":   {frontTestUpstreamIss},
	}, nil)
	require.Equal(h.t, 302, callback.Status)
	code := locationQuery(h.t, callback).Get("code")
	require.NotEmpty(h.t, code)
	return callback, code
}

func (h *frontChannelHarness) token(form url.Values) apptheory.Response {
	h.t.Helper()
	return h.serve("POST", h.path(mcproutes.EndpointPath.OAuthTokenPath), nil, []byte(form.Encode()))
}

func locationOf(response apptheory.Response) string {
	values := response.Headers["location"]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func locationQuery(t require.TestingT, response apptheory.Response) url.Values {
	location := locationOf(response)
	if location == "" {
		return url.Values{}
	}
	parsed, err := url.Parse(location)
	require.NoError(t, err)
	return parsed.Query()
}

func responseScan(response apptheory.Response) string {
	scanned := locationOf(response) + "\n"
	for _, values := range response.Headers {
		scanned += strings.Join(values, "\n") + "\n"
	}
	return scanned + string(response.Body)
}

// brokerHandleHash derives the broker store key of the record a token response
// handed the client: the record is keyed by hash(route handle), and the client's
// refresh_token is that handle.
func brokerHandleHash(t *testing.T, tokenResponse apptheory.Response) string {
	t.Helper()
	var payload struct {
		RefreshToken string `json:"refresh_token"`
	}
	require.NoError(t, json.Unmarshal(tokenResponse.Body, &payload))
	require.NotEmpty(t, payload.RefreshToken)
	return oauthstore.HashKey(payload.RefreshToken)
}

// TestFrontChannelAuthorizeRedirectsUpstreamWithTheFacadesOwnMaterial pins
// DESIGN §8.1 / journey step 5 / T4: the browser is sent to the upstream
// authorize endpoint with the facade's own client, callback, S256 challenge,
// resource, and a fresh upstream state distinct from the client's state.
func TestFrontChannelAuthorizeRedirectsUpstreamWithTheFacadesOwnMaterial(t *testing.T) {
	harness := newFrontChannelHarness(t)
	response := harness.authorize(nil)
	require.Equal(t, 302, response.Status)

	location := locationOf(response)
	require.True(t, strings.HasPrefix(location, frontTestUpstreamIss+"/"), location)
	query := locationQuery(t, response)
	require.Equal(t, frontTestClientID, query.Get("client_id"))
	require.Equal(t, frontTestBaseURL+"/_oauth/mcp/callback", query.Get("redirect_uri"))
	require.Equal(t, "S256", query.Get("code_challenge_method"))
	require.NotEmpty(t, query.Get("code_challenge"))
	require.Equal(t, frontTestBaseURL+"/acme/mcp", query.Get("resource"))
	require.NotEqual(t, frontTestClientState, query.Get("state"))
	require.NotEqual(t, "", query.Get("state"))
}

// TestFrontChannelAuthorizeRejectsUnknownClientAndRedirectWithoutRedirect pins
// T1: both pre-redirect-URI failures render a 400 error page and never redirect.
func TestFrontChannelAuthorizeRejectsUnknownClientAndRedirectWithoutRedirect(t *testing.T) {
	harness := newFrontChannelHarness(t)

	unknown := harness.authorize(func(query url.Values) { query.Set("client_id", "unknown-client") })
	require.Equal(t, 400, unknown.Status)
	require.Empty(t, locationOf(unknown))
	require.Contains(t, string(unknown.Body), `"error":"invalid_client"`)

	unmatched := harness.authorize(func(query url.Values) { query.Set("redirect_uri", "https://evil.example/cb") })
	require.Equal(t, 400, unmatched.Status)
	require.Empty(t, locationOf(unmatched))
}

// TestFrontChannelAuthorizeRequiresFreshS256PKCE pins T3: an absent challenge
// and a plain challenge are both refused, and the refusal is a redirect because
// the redirect URI has already been validated.
func TestFrontChannelAuthorizeRequiresFreshS256PKCE(t *testing.T) {
	harness := newFrontChannelHarness(t)

	missing := harness.authorize(func(query url.Values) {
		query.Del("code_challenge")
		query.Del("code_challenge_method")
	})
	require.Equal(t, 302, missing.Status)
	require.Equal(t, "invalid_request", locationQuery(t, missing).Get("error"))

	plain := harness.authorize(func(query url.Values) {
		query.Set("code_challenge", "plain-challenge-value")
		query.Set("code_challenge_method", "plain")
	})
	require.Equal(t, 302, plain.Status)
	require.Equal(t, "invalid_request", locationQuery(t, plain).Get("error"))
}

// TestFrontChannelAuthorizeRejectsWrongResource pins T7: a resource that is not
// the route resource is refused before any upstream call.
func TestFrontChannelAuthorizeRejectsWrongResource(t *testing.T) {
	harness := newFrontChannelHarness(t)
	response := harness.authorize(func(query url.Values) { query.Set("resource", frontTestBaseURL+"/other/mcp") })
	require.Equal(t, 302, response.Status)
	require.Equal(t, "invalid_target", locationQuery(t, response).Get("error"))
}

// TestFrontChannelCallbackCompletesTheJourneyAndHidesUpstreamMaterial pins
// journey step 6 / T6 / T10: the callback returns the client to its redirect URI
// with a facade code, the client's own state, and the route issuer, and the
// redirect carries no upstream code, refresh token, or id_token.
func TestFrontChannelCallbackCompletesTheJourneyAndHidesUpstreamMaterial(t *testing.T) {
	harness := newFrontChannelHarness(t)
	callback, _ := harness.authorizeAndCallback("")
	require.Equal(t, frontTestBaseURL+"/acme/mcp", locationQuery(t, callback).Get("iss"))
	require.Equal(t, frontTestClientState, locationQuery(t, callback).Get("state"))

	scanned := responseScan(callback)
	require.NotContains(t, scanned, frontTestUpstreamCode)
	require.NotContains(t, scanned, frontTestRefreshToken)
	require.NotContains(t, scanned, "id_token")
	require.Equal(t, 1, harness.fake.TokenCallCount())
}

// TestFrontChannelCallbackRejectsIssMismatchBeforeConsumingOrExchanging pins T4
// and DESIGN §8.2: a valid facade-minted state and upstream code presented with
// a mismatched iss is refused without consuming the transaction or attempting
// the exchange, so the same state still completes a correct callback afterwards.
func TestFrontChannelCallbackRejectsIssMismatchBeforeConsumingOrExchanging(t *testing.T) {
	harness := newFrontChannelHarness(t)
	authorizeResponse := harness.authorize(nil)
	state := locationQuery(t, authorizeResponse).Get("state")

	mismatch := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {frontTestUpstreamCode},
		"state": {state},
		"iss":   {"https://evil.example"},
	}, nil)
	require.Equal(t, 400, mismatch.Status)
	require.Empty(t, locationOf(mismatch))
	require.Equal(t, 0, harness.fake.TokenCallCount())

	// The transaction was not consumed: the same state still completes.
	retry := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {frontTestUpstreamCode},
		"state": {state},
		"iss":   {frontTestUpstreamIss},
	}, nil)
	require.Equal(t, 302, retry.Status)
	require.NotEmpty(t, locationQuery(t, retry).Get("code"))
}

// TestFrontChannelCallbackRejectsAbsentIss pins T4: an absent iss is rejected in
// the same class as a mismatch, before the transaction is consumed.
func TestFrontChannelCallbackRejectsAbsentIss(t *testing.T) {
	harness := newFrontChannelHarness(t)
	authorizeResponse := harness.authorize(nil)
	state := locationQuery(t, authorizeResponse).Get("state")

	response := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {frontTestUpstreamCode},
		"state": {state},
	}, nil)
	require.Equal(t, 400, response.Status)
	require.Empty(t, locationOf(response))
	require.Equal(t, 0, harness.fake.TokenCallCount())
}

// TestFrontChannelCallbackRejectsForgedAndReplayedState pins T10: a state the
// facade never minted is refused, and a state already consumed is terminal and
// never re-exchanges.
func TestFrontChannelCallbackRejectsForgedAndReplayedState(t *testing.T) {
	harness := newFrontChannelHarness(t)

	forged := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {"attacker-code"},
		"state": {"attacker-state"},
		"iss":   {frontTestUpstreamIss},
	}, nil)
	require.Equal(t, 400, forged.Status)
	require.Empty(t, locationOf(forged))
	require.Equal(t, 0, harness.fake.TokenCallCount())

	authorizeResponse := harness.authorize(nil)
	state := locationQuery(t, authorizeResponse).Get("state")
	first := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {frontTestUpstreamCode},
		"state": {state},
		"iss":   {frontTestUpstreamIss},
	}, nil)
	require.Equal(t, 302, first.Status)
	require.Equal(t, 1, harness.fake.TokenCallCount())

	replayed := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {"c"},
		"state": {state},
		"iss":   {frontTestUpstreamIss},
	}, nil)
	require.Equal(t, 400, replayed.Status)
	require.Empty(t, locationOf(replayed))
	require.Equal(t, 1, harness.fake.TokenCallCount())
}

// TestFrontChannelTokenCodeExchangeReturnsTheOpaqueHandleAndTheUnmodifiedToken
// pins journey step 7 / T6: the response carries the upstream access token
// byte-for-byte, an opaque refresh handle that is not the upstream refresh
// token, and no id_token.
func TestFrontChannelTokenCodeExchangeReturnsTheOpaqueHandleAndTheUnmodifiedToken(t *testing.T) {
	harness := newFrontChannelHarness(t)
	_, code := harness.authorizeAndCallback("")
	minted := harness.fake.MintAccessToken(oauthprovider.Claims{
		Issuer:          frontTestUpstreamIss,
		Audience:        frontTestBaseURL + "/acme/mcp",
		AuthorizedParty: frontTestClientID,
		Subject:         "user-1",
		Scope:           "mcp:tools",
		ExpiresIn:       900,
	})

	response := harness.token(url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"},
		"redirect_uri":  {"https://client.example/callback"},
		"client_id":     {frontTestClientID},
	})
	require.Equal(t, 200, response.Status)
	body := string(response.Body)
	require.Contains(t, body, `"access_token":"`+minted+`"`)
	require.Contains(t, body, `"refresh_token":"`)
	require.NotContains(t, body, frontTestRefreshToken)
	require.NotContains(t, body, "id_token")
	require.Contains(t, body, `"token_type":"Bearer"`)
}

// TestFrontChannelTokenReplayRevokesTheBrokerRecord pins T2 / R1: the first
// exchange wins, a replay returns invalid_grant and revokes the broker record
// the code minted.
func TestFrontChannelTokenReplayRevokesTheBrokerRecord(t *testing.T) {
	harness := newFrontChannelHarness(t)
	_, code := harness.authorizeAndCallback("")
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"},
		"redirect_uri":  {"https://client.example/callback"},
		"client_id":     {frontTestClientID},
	}
	first := harness.token(form)
	require.Equal(t, 200, first.Status)

	handleHash := brokerHandleHash(t, first)

	replay := harness.token(form)
	require.Equal(t, 400, replay.Status)
	require.Contains(t, string(replay.Body), `"error":"invalid_grant"`)

	record, err := harness.stores.RouteRefreshBroker.Get(context.Background(), handleHash)
	require.NoError(t, err)
	require.Equal(t, oauthstore.BrokerStatusRevoked, record.Status)
}

// TestFrontChannelTokenRejectsWrongVerifierAndUnknownCode pins T3/T2: a wrong
// verifier and an unknown code are the same invalid_grant response, so the
// response is not an oracle.
func TestFrontChannelTokenRejectsWrongVerifierAndUnknownCode(t *testing.T) {
	harness := newFrontChannelHarness(t)
	_, code := harness.authorizeAndCallback("")
	base := url.Values{
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {"https://client.example/callback"},
		"client_id":     {frontTestClientID},
		"code_verifier": {"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"},
	}

	wrongVerifier := base
	wrongVerifier.Set("code", code)
	wrongVerifier.Set("code_verifier", "WRONGVERIFIERWRONGVERIFIERWRONGVERIFIER1234567890")
	wrong := harness.token(wrongVerifier)
	require.Equal(t, 400, wrong.Status)
	require.Contains(t, string(wrong.Body), `"error":"invalid_grant"`)

	unknown := base
	unknown.Set("code", "never-minted-code")
	unknownResponse := harness.token(unknown)
	require.Equal(t, 400, unknownResponse.Status)
	require.Equal(t, string(wrong.Body), string(unknownResponse.Body))
}

// TestFrontChannelTokenRejectsCodeIssuedToAnotherClient pins the client binding:
// a code minted for one registered client cannot be redeemed by another, even
// though both are registered and present the same redirect URI.
func TestFrontChannelTokenRejectsCodeIssuedToAnotherClient(t *testing.T) {
	harness := newFrontChannelHarness(t)
	require.NoError(t, harness.stores.Client.Put(context.Background(), &oauthstore.ClientRecord{
		ClientIDHash:            oauthstore.HashKey("other-client"),
		ClientID:                "other-client",
		RedirectURIs:            []string{"https://client.example/callback"},
		TokenEndpointAuthMethod: "none",
	}))
	_, code := harness.authorizeAndCallback("")

	response := harness.token(url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"},
		"redirect_uri":  {"https://client.example/callback"},
		"client_id":     {"other-client"},
	})
	require.Equal(t, 400, response.Status)
	require.Contains(t, string(response.Body), `"error":"invalid_grant"`)
}

// TestFrontChannelTokenRefusesRefreshGrantUntilM3c pins the refresh ruling: the
// token response issues the refresh handle but the refresh_token grant answers
// unsupported_grant_type until the brokered refresh milestone lands.
func TestFrontChannelTokenRefusesRefreshGrantUntilM3c(t *testing.T) {
	harness := newFrontChannelHarness(t)
	response := harness.token(url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {"whatever-handle"},
		"client_id":     {frontTestClientID},
	})
	require.Equal(t, 400, response.Status)
	require.Contains(t, string(response.Body), `"error":"unsupported_grant_type"`)
}

// TestFrontChannelCodeExpiryBurnsThenReplays pins T2/R1: the first consume of an
// expired code burns it and returns invalid_grant, and the later consume is a
// replay that revokes the broker record.
func TestFrontChannelCodeExpiryBurnsThenReplays(t *testing.T) {
	harness := newFrontChannelHarness(t)
	_, code := harness.authorizeAndCallback("")
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"},
		"redirect_uri":  {"https://client.example/callback"},
		"client_id":     {frontTestClientID},
	}
	harness.clock.Advance(2 * time.Minute)

	expired := harness.token(form)
	require.Equal(t, 400, expired.Status)
	require.Contains(t, string(expired.Body), `"error":"invalid_grant"`)

	handles := harness.broker.handleHashes()
	require.Len(t, handles, 1)

	replay := harness.token(form)
	require.Equal(t, 400, replay.Status)
	record, err := harness.stores.RouteRefreshBroker.Get(context.Background(), handles[0])
	require.NoError(t, err)
	require.Equal(t, oauthstore.BrokerStatusRevoked, record.Status)
}

// TestFrontChannelConcurrentCodeRedemptionHasExactlyOneWinner pins T2 under
// concurrency: of many simultaneous redemptions of one code exactly one wins,
// and the losing replays revoke the broker record.
func TestFrontChannelConcurrentCodeRedemptionHasExactlyOneWinner(t *testing.T) {
	harness := newFrontChannelHarness(t)
	_, code := harness.authorizeAndCallback("")
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"},
		"redirect_uri":  {"https://client.example/callback"},
		"client_id":     {frontTestClientID},
	}.Encode()

	const callers = 8
	statuses := make([]int, callers)
	var wait sync.WaitGroup
	start := make(chan struct{})
	for index := 0; index < callers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			statuses[index] = harness.serve("POST", harness.path(mcproutes.EndpointPath.OAuthTokenPath), nil, []byte(form)).Status
		}(index)
	}
	close(start)
	wait.Wait()

	winners := 0
	for _, status := range statuses {
		if status == 200 {
			winners++
		} else {
			require.Equal(t, 400, status)
		}
	}
	require.Equal(t, 1, winners)

	handles := harness.broker.handleHashes()
	require.Len(t, handles, 1)
	record, err := harness.stores.RouteRefreshBroker.Get(context.Background(), handles[0])
	require.NoError(t, err)
	require.Equal(t, oauthstore.BrokerStatusRevoked, record.Status)
}
