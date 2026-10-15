package mcpfacade

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"sort"
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

	// The refresh grant's own upstream material. The fake serves these only for
	// grant_type=refresh_token, so a refresh that returned upstream material
	// instead of a framework handle is distinguishable from the code exchange,
	// and a response that leaked either value is observable.
	frontTestRotatedUpstreamRefreshToken = "upstream-refresh-token-rotated"
	frontTestRefreshAccessToken          = "upstream-rotated-access-token"
	frontTestRefreshIDToken              = "upstream-id-token-must-not-surface" // #nosec G101 -- a test fixture value asserted absent from every response, not a credential.
	frontTestRotatedUpstreamScope        = "mcp:tools"
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

	// failAuthorizationURL makes the AuthorizationURL builder fail, so a test can
	// drive the authorize leg's provider-call failure class.
	failAuthorizationURL bool
}

// AuthorizationURL fails when the harness was built with failAuthorizationURL
// and otherwise delegates to the real adapter.
func (p *mintingProvider) AuthorizationURL(req oauth.AuthorizationRequest) (string, error) {
	if p.failAuthorizationURL {
		return "", errors.New("mintingProvider: authorization URL unavailable")
	}
	return p.Provider.AuthorizationURL(req)
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

	// bearerValidator is the transport claims validator the harness installed,
	// when it installed one. The journey loader reuses it to prove an exchanged
	// access token is a genuine upstream-minted token.
	bearerValidator oauth.BearerTokenClaimsValidator
}

// frontChannelHarnessOptions tunes the harness a test starts. The zero value is
// the default harness every front-channel test uses.
type frontChannelHarnessOptions struct {
	// providerOptions mutates the fake upstream's options before it starts, so a
	// test can serve a grant-specific or failing token response.
	providerOptions func(*oauthprovider.Options)

	// issuerMode and registrationEndpointURL tune the facade the harness
	// registers. The zero issuerMode is the route mode every front-channel test
	// uses.
	issuerMode              mcproutes.IssuerMode
	registrationEndpointURL string

	// providerHints, when set, is installed as the front channel's app-supplied
	// provider-hint seam, so a test can drive a failing providerHints.
	providerHints func(*apptheory.Context) (map[string]string, error)

	// failAuthorizationURL makes the upstream provider's AuthorizationURL builder
	// fail, so a test can drive the authorize leg's provider-call failure class.
	failAuthorizationURL bool

	// transportPosture selects the transport posture the harness registers. The
	// zero value is the IAM posture every front-channel test uses; the shared
	// journey loader selects the runtime-bearer posture so its transport rows
	// exercise the real RFC 9728 middleware.
	transportPosture TransportPosture

	// requireBearerTokenFor maps the started fake upstream to the transport
	// claims validator the harness installs. It is a function because a validator
	// has to read the fake's key set and loopback-rewriting client, which only
	// exist once the fake has started.
	requireBearerTokenFor func(*oauthprovider.Server) *oauth.RequireBearerTokenOptions

	// mcpHandler, when set, replaces the harness's default 204 MCP handler; the
	// journey's valid-token row needs a handler that answers 200.
	mcpHandler apptheory.Handler

	// mcpInvocations, when set, counts every MCP handler invocation, so a
	// transport row can pin handler_invocations.
	mcpInvocations *int
}

// manualClockAdapter implements apptheory.Clock over the harness's ManualClock,
// so ctx.Now() is the same deterministic instant the stores observe: grace
// windows, record lifetimes, and rotation timestamps all move together when a
// test advances the clock.
type manualClockAdapter struct {
	clock *oauthstore.ManualClock
}

func (a manualClockAdapter) Now() time.Time { return a.clock.Now() }

// recordingBrokerStore decorates the reference broker store and records every
// handle it is seeded with, so a test can observe the record a callback opened
// without the front channel having to expose it.
type recordingBrokerStore struct {
	oauthstore.RouteRefreshBrokerStore
	oauthstore.RouteRefreshBrokerSeeder

	mu      sync.Mutex
	handles []string

	// acquireLockFn, when set, replaces the reference store's AcquireLock so a
	// test can stage the lock outcome (a version conflict, a held lock, a store
	// error) the in-memory store would only produce under a real concurrent race.
	// It is read through the store pointer the facade itself holds, so a test may
	// set it after the harness is built and the facade still observes it.
	acquireLockFn func(context.Context, string, string, int) (*oauthstore.RouteRefreshBrokerRecord, error)
}

func (s *recordingBrokerStore) Put(ctx context.Context, record *oauthstore.RouteRefreshBrokerRecord) error {
	s.mu.Lock()
	s.handles = append(s.handles, record.HandleHash)
	s.mu.Unlock()
	return s.RouteRefreshBrokerSeeder.Put(ctx, record)
}

func (s *recordingBrokerStore) AcquireLock(
	ctx context.Context,
	handleHash string,
	lockOwner string,
	expectedVersion int,
) (*oauthstore.RouteRefreshBrokerRecord, error) {
	if s.acquireLockFn != nil {
		return s.acquireLockFn(ctx, handleHash, lockOwner, expectedVersion)
	}
	return s.RouteRefreshBrokerStore.AcquireLock(ctx, handleHash, lockOwner, expectedVersion)
}

func (s *recordingBrokerStore) handleHashes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.handles...)
}

func newFrontChannelHarness(t *testing.T) *frontChannelHarness {
	t.Helper()
	return newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
}

func newFrontChannelHarnessWith(t *testing.T, options frontChannelHarnessOptions) *frontChannelHarness {
	t.Helper()
	if options.providerOptions == nil {
		options.providerOptions = func(*oauthprovider.Options) {}
	}
	clock := oauthstore.NewManualClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	var reference oauthstore.RouteRefreshBrokerStore = oauthstore.NewMemoryRouteRefreshBrokerStore(oauthstore.RouteRefreshBrokerStoreOptions{Now: clock.Now})
	seeder, ok := reference.(oauthstore.RouteRefreshBrokerSeeder)
	require.True(t, ok, "the reference broker store must implement the seeder")
	broker := &recordingBrokerStore{
		RouteRefreshBrokerStore:  reference,
		RouteRefreshBrokerSeeder: seeder,
	}
	stores := oauthstore.Stores{
		Transaction:        oauthstore.NewMemoryTransactionStore(oauthstore.TransactionStoreOptions{Now: clock.Now}),
		AuthorizationCode:  oauthstore.NewMemoryAuthorizationCodeStore(oauthstore.AuthorizationCodeStoreOptions{Now: clock.Now}),
		Client:             oauthstore.NewMemoryClientStore(oauthstore.ClientStoreOptions{Now: clock.Now}),
		RouteRefreshBroker: broker,
		RateLimit:          oauthstore.NewMemoryRateLimitStore(oauthstore.RateLimitStoreOptions{Now: clock.Now}),
	}

	fakeOptions := oauthprovider.Options{
		Issuer: frontTestUpstreamIss,
		TokenBody: map[string]any{
			"access_token":  "placeholder-upstream-access-token",
			"token_type":    "Bearer",
			"expires_in":    900,
			"refresh_token": frontTestRefreshToken,
			"scope":         "mcp:tools",
		},
		// The refresh grant gets its own response, so a facade that returned
		// upstream refresh material or an id_token instead of a framework handle
		// is observable in the body as well as in the call counts.
		RefreshTokenBody: map[string]any{
			"access_token":  frontTestRefreshAccessToken,
			"token_type":    "Bearer",
			"expires_in":    900,
			"refresh_token": frontTestRotatedUpstreamRefreshToken,
			"scope":         frontTestRotatedUpstreamScope,
			"id_token":      frontTestRefreshIDToken,
		},
	}
	options.providerOptions(&fakeOptions)
	fake := oauthprovider.NewServer(t, fakeOptions)
	adapter, err := oauth.NewAutheoryProvider(oauth.AutheoryProviderOptions{
		Issuer:            fake.Issuer(),
		ClientID:          frontTestClientID,
		HTTPClient:        fake.HTTPClient(),
		AllowPrivateHosts: true,
	})
	require.NoError(t, err)

	issuerMode := options.issuerMode
	if issuerMode == "" {
		issuerMode = mcproutes.IssuerModeRoute
	}
	transportPosture := options.transportPosture
	if transportPosture == "" {
		transportPosture = TransportPostureIAM
	}
	var requireBearerToken *oauth.RequireBearerTokenOptions
	if options.requireBearerTokenFor != nil {
		requireBearerToken = options.requireBearerTokenFor(fake)
	}
	mcpHandler := options.mcpHandler
	if mcpHandler == nil {
		mcpHandler = func(*apptheory.Context) (*apptheory.Response, error) { return apptheory.NoContent(), nil }
	}
	if options.mcpInvocations != nil {
		inner := mcpHandler
		counter := options.mcpInvocations
		mcpHandler = func(ctx *apptheory.Context) (*apptheory.Response, error) {
			*counter++
			return inner(ctx)
		}
	}
	kind := mcproutes.EndpointKindNamespace
	config := FacadeConfig{
		IssuerURL:               frontTestBaseURL + "/acme/mcp",
		JWKSURI:                 frontTestUpstreamIss + "/.well-known/jwks.json",
		IssuerMode:              issuerMode,
		RegistrationEndpointURL: options.registrationEndpointURL,
		URLMode:                 URLModePublicBaseURL,
		PublicBaseURL:           frontTestBaseURL,
		TransportPosture:        transportPosture,
		RequireBearerToken:      requireBearerToken,
		Scopes: map[mcproutes.EndpointKind][]string{
			mcproutes.EndpointKindNamespace:        {"mcp:tools"},
			mcproutes.EndpointKindPartnerNamespace: {"mcp:tools"},
			mcproutes.EndpointKindAgent:            {"mcp:tools"},
			mcproutes.EndpointKindPartnerAgent:     {"mcp:tools"},
		},
		MCPHandler: mcpHandler,
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
			failAuthorizationURL: options.failAuthorizationURL,
		},
		Stores:           stores,
		UpstreamClientID: frontTestClientID,
		UpstreamIssuer:   frontTestUpstreamIss,
		ProviderHints:    options.providerHints,
	}
	require.NoError(t, stores.Client.Put(context.Background(), &oauthstore.ClientRecord{
		ClientIDHash:            oauthstore.HashKey(frontTestClientID),
		ClientID:                frontTestClientID,
		RedirectURIs:            []string{"https://client.example/callback"},
		TokenEndpointAuthMethod: "none",
	}))

	app := apptheory.New(apptheory.WithClock(manualClockAdapter{clock: clock}))
	_, err = RegisterMCPFacade(app, config)
	require.NoError(t, err)
	harness := &frontChannelHarness{t: t, app: app, fake: fake, clock: clock, stores: stores, broker: broker, kind: kind}
	if requireBearerToken != nil {
		harness.bearerValidator = requireBearerToken.ClaimsValidator
	}
	return harness
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

// facadeConformanceFixture is the shared MCP auth facade conformance table,
// loaded from runtime/mcpfacade/ two levels below the module root.
const facadeConformanceFixture = "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-conformance.v1.json"

// redirectMatchGroup names the fixture group this loader executes.
const redirectMatchGroup = "redirect_match"

// redirectMatchCaseCount is the number of redirect_match rows the shared fixture
// must carry; a change to the table must also be a deliberate edit in the Go,
// TypeScript, and Python loaders, so no runtime can silently execute a smaller
// table.
const redirectMatchCaseCount = 11

// formParseGroup names the /token request-body rule group the same shared table
// carries, executed below through the real token handler.
const formParseGroup = "form_parse"

// formParseCaseCount is the number of form_parse rows the shared fixture must
// carry; a change to the table must also be a deliberate edit in the Go,
// TypeScript, and Python loaders, so no runtime can silently execute a smaller
// table.
const formParseCaseCount = 11

// formParseConformanceDocument and formParseCase are the form_parse rows: the
// small rows carry a literal body, and the bound rows carry a body_prefix padded
// with "a" out to exactly total_bytes.
type formParseConformanceDocument struct {
	Cases []formParseCase `json:"cases"`
}

type formParseCase struct {
	ID          string `json:"id"`
	Group       string `json:"group"`
	Body        string `json:"body"`
	BodyPrefix  string `json:"body_prefix"`
	TotalBytes  int    `json:"total_bytes"`
	ExpectError string `json:"expect_error"`
}

// requestBody builds the raw body the row presents.
func (row formParseCase) requestBody() []byte {
	if row.TotalBytes == 0 {
		return []byte(row.Body)
	}
	prefix := []byte(row.BodyPrefix)
	return append(prefix, bytes.Repeat([]byte("a"), row.TotalBytes-len(prefix))...)
}

// label keeps a failure message readable for a bound row, whose literal body is
// 16 KiB of padding.
func (row formParseCase) label() string {
	if row.TotalBytes == 0 {
		return row.Body
	}
	return row.BodyPrefix + "<pad>"
}

type redirectMatchConformanceDocument struct {
	Cases []redirectMatchCase `json:"cases"`
}

type redirectMatchCase struct {
	ID         string   `json:"id"`
	Group      string   `json:"group"`
	Registered []string `json:"registered"`
	Requested  string   `json:"requested"`
	Expect     string   `json:"expect"`
}

func loadFacadeConformanceFixture(t *testing.T, target any) {
	t.Helper()
	body, err := os.ReadFile(facadeConformanceFixture) // #nosec G304 -- path is a fixed test fixture path built from a constant directory.
	require.NoErrorf(t, err, "read shared fixture %s", facadeConformanceFixture)
	require.NoErrorf(t, json.Unmarshal(body, target), "decode shared fixture %s", facadeConformanceFixture)
}

// TestFrontChannelAuthorizeEnforcesTheSharedRedirectMatchTable pins the RFC 8252
// §7.3 loopback redirect rule to the shared cross-runtime table through the real
// /authorize handler: an accepted row reaches the upstream redirect (302) and a
// refused row renders the pre-redirect 400 error page with no Location, so the
// open-redirect defense is proven end to end rather than against the matcher
// alone.
func TestFrontChannelAuthorizeEnforcesTheSharedRedirectMatchTable(t *testing.T) {
	var document redirectMatchConformanceDocument
	loadFacadeConformanceFixture(t, &document)

	rows := make([]redirectMatchCase, 0, len(document.Cases))
	for _, row := range document.Cases {
		require.NotEmptyf(t, row.Group, "case %q must carry a group", row.ID)
		if row.Group == redirectMatchGroup {
			rows = append(rows, row)
		}
	}
	require.Equalf(t, redirectMatchCaseCount, len(rows), "loaded %d %q cases", len(rows), redirectMatchGroup)

	harness := newFrontChannelHarness(t)
	executed := 0
	for _, row := range rows {
		executed++
		t.Run(row.ID, func(t *testing.T) {
			clientID := "redirect-match-" + row.ID
			require.NoError(t, harness.stores.Client.Put(context.Background(), &oauthstore.ClientRecord{
				ClientIDHash:            oauthstore.HashKey(clientID),
				ClientID:                clientID,
				RedirectURIs:            append([]string(nil), row.Registered...),
				TokenEndpointAuthMethod: "none",
			}))

			response := harness.authorize(func(query url.Values) {
				query.Set("client_id", clientID)
				query.Set("redirect_uri", row.Requested)
			})

			switch row.Expect {
			case "accept":
				require.Equalf(t, 302, response.Status, "registered %v, requested %q", row.Registered, row.Requested)
			case "reject":
				require.Equalf(t, 400, response.Status, "registered %v, requested %q", row.Registered, row.Requested)
				require.Emptyf(t, locationOf(response), "registered %v, requested %q", row.Registered, row.Requested)
			default:
				t.Fatalf("unknown expect %q", row.Expect)
			}
		})
	}

	require.Equalf(t, redirectMatchCaseCount, executed, "executed %d %q cases", executed, redirectMatchGroup)
}

// TestFrontChannelTokenEnforcesTheSharedFormParseTable pins the one bounded,
// strict /token request-body rule to the shared cross-runtime table through the
// real handler: Go's url.ParseQuery is the reference, so a `;` separator or a
// malformed percent escape is invalid_request for the whole body, a repeat key
// keeps its first occurrence, and a raw body strictly larger than the 16384-byte
// framework bound fails closed before any parse.
func TestFrontChannelTokenEnforcesTheSharedFormParseTable(t *testing.T) {
	var document formParseConformanceDocument
	loadFacadeConformanceFixture(t, &document)

	rows := make([]formParseCase, 0, len(document.Cases))
	for _, row := range document.Cases {
		require.NotEmptyf(t, row.Group, "case %q must carry a group", row.ID)
		if row.Group == formParseGroup {
			rows = append(rows, row)
		}
	}
	require.Equalf(t, formParseCaseCount, len(rows), "loaded %d %q cases", len(rows), formParseGroup)

	harness := newFrontChannelHarness(t)
	executed := 0
	for _, row := range rows {
		executed++
		t.Run(row.ID, func(t *testing.T) {
			body := row.requestBody()
			if row.TotalBytes != 0 {
				require.Lenf(t, body, row.TotalBytes, "case %q must present exactly %d body bytes", row.ID, row.TotalBytes)
			}

			response := harness.serve("POST", harness.path(mcproutes.EndpointPath.OAuthTokenPath), nil, body)
			require.Equalf(t, 400, response.Status, "body %q", row.label())

			var payload struct {
				Error string `json:"error"`
			}
			require.NoErrorf(t, json.Unmarshal(response.Body, &payload), "decode %q response", row.ID)
			require.Equalf(t, row.ExpectError, payload.Error, "body %q", row.label())
		})
	}

	require.Equalf(t, formParseCaseCount, executed, "executed %d %q cases", executed, formParseGroup)
}

// authorizeProviderFailureGroup names the authorize leg's provider-call failure
// class group the same shared table carries, executed below through the real
// /authorize handler.
const authorizeProviderFailureGroup = "authorize_provider_failure"

// authorizeProviderFailureCaseCount is the number of authorize_provider_failure
// rows the shared fixture must carry; a change to the table must also be a
// deliberate edit in the Go, TypeScript, and Python loaders, so no runtime can
// silently execute a smaller table.
const authorizeProviderFailureCaseCount = 2

// authorizeProviderFailureConformanceDocument and authorizeProviderFailureCase
// are the authorize_provider_failure rows: fail selects which provider call the
// harness makes fail.
type authorizeProviderFailureConformanceDocument struct {
	Cases []authorizeProviderFailureCase `json:"cases"`
}

type authorizeProviderFailureCase struct {
	ID               string   `json:"id"`
	Group            string   `json:"group"`
	Fail             string   `json:"fail"`
	ExpectStatus     int      `json:"expect_status"`
	ExpectBodyHas    []string `json:"expect_body_has"`
	ExpectNoLocation bool     `json:"expect_no_location"`
}

// TestFrontChannelAuthorizeEnforcesTheSharedProviderFailureTable pins the
// authorize leg's provider-call failure class to the shared cross-runtime table
// through the real /authorize handler: a failing provider AuthorizationURL
// builder and a failing app-supplied providerHints each render the
// gateway-class 502 upstream_error error page with no Location, so the
// provider-call failure class is the same 502 as the callback's rather than the
// facade's own 400 vocabulary.
func TestFrontChannelAuthorizeEnforcesTheSharedProviderFailureTable(t *testing.T) {
	var document authorizeProviderFailureConformanceDocument
	loadFacadeConformanceFixture(t, &document)

	rows := make([]authorizeProviderFailureCase, 0, len(document.Cases))
	for _, row := range document.Cases {
		require.NotEmptyf(t, row.Group, "case %q must carry a group", row.ID)
		if row.Group == authorizeProviderFailureGroup {
			rows = append(rows, row)
		}
	}
	require.Equalf(t, authorizeProviderFailureCaseCount, len(rows), "loaded %d %q cases", len(rows), authorizeProviderFailureGroup)

	executed := 0
	for _, row := range rows {
		executed++
		t.Run(row.ID, func(t *testing.T) {
			harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
				failAuthorizationURL: row.Fail == "authorization_url",
				providerHints: func(*apptheory.Context) (map[string]string, error) {
					if row.Fail == "provider_hints" {
						return nil, errors.New("provider hints unavailable")
					}
					return nil, nil
				},
			})

			response := harness.authorize(nil)
			require.Equalf(t, row.ExpectStatus, response.Status, "fail %q", row.Fail)
			if row.ExpectNoLocation {
				require.Emptyf(t, locationOf(response), "fail %q must not redirect", row.Fail)
			}
			for _, want := range row.ExpectBodyHas {
				require.Containsf(t, string(response.Body), want, "fail %q", row.Fail)
			}
		})
	}

	require.Equalf(t, authorizeProviderFailureCaseCount, executed, "executed %d %q cases", executed, authorizeProviderFailureGroup)
}

// metadataRegistrationGroup names the group the same shared table carries that
// pins the advertised registration_endpoint to the mounted /register route.
const metadataRegistrationGroup = "metadata_registration"

// metadataRegistrationCaseCount is the number of metadata_registration rows the
// shared fixture must carry; a change to the table must also be a deliberate
// edit in the Go, TypeScript, and Python loaders, so no runtime can silently
// execute a smaller table.
const metadataRegistrationCaseCount = 6

// metadataRegistrationConformanceDocument and metadataRegistrationCase are the
// metadata_registration rows. `front_channel` and `register_handler` choose the
// facade shape, and `expect` names how the row's advertised value is derived:
// absent, the row's own configured URL, `<family issuer>/register`, or the
// route's derived `/register` URL.
type metadataRegistrationConformanceDocument struct {
	Cases []metadataRegistrationCase `json:"cases"`
}

type metadataRegistrationCase struct {
	ID                      string `json:"id"`
	Group                   string `json:"group"`
	IssuerMode              string `json:"issuer_mode"`
	FrontChannel            bool   `json:"front_channel"`
	RegisterHandler         bool   `json:"register_handler"`
	RegistrationEndpointURL string `json:"registration_endpoint_url"`
	Expect                  string `json:"expect"`
}

// metadataRegistrationEndpoint is the single route the group resolves, so a row
// exercises only the mount shape and the issuer mode.
func metadataRegistrationEndpoint() mcproutes.EndpointPath {
	return mcproutes.EndpointPath{Kind: mcproutes.EndpointKindNamespace, ClientNamespace: "acme"}
}

// newMetadataRegistrationApp mounts a facade for one row. The front-channel
// field set is attached only for the rows that ask for it, so the mounted
// /register route and the advertised member move together.
func newMetadataRegistrationApp(t *testing.T, row metadataRegistrationCase) *apptheory.App {
	t.Helper()
	if row.FrontChannel {
		return newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
			issuerMode:              mcproutes.IssuerMode(row.IssuerMode),
			registrationEndpointURL: row.RegistrationEndpointURL,
		}).app
	}
	config := validConfig(URLModePublicBaseURL)
	config.IssuerURL = frontTestBaseURL + "/acme/mcp"
	config.PublicBaseURL = frontTestBaseURL
	config.IssuerMode = mcproutes.IssuerMode(row.IssuerMode)
	config.RegistrationEndpointURL = row.RegistrationEndpointURL
	if row.RegisterHandler {
		config.RegisterHandler = kindHandlerFactory("register")
	}
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	_, err := RegisterMCPFacade(app, config)
	require.NoError(t, err)
	return app
}

// TestFrontChannelMetadataAdvertisesRegistrationExactlyWhileTheRouteIsMounted
// pins the advertised registration_endpoint to the mounted /register route
// through the real facade: the routed RFC 8414 document carries the member
// exactly when the front channel or an explicit register handler mounts the
// route, so a facade that mounts none never advertises a URL that 404s.
func TestFrontChannelMetadataAdvertisesRegistrationExactlyWhileTheRouteIsMounted(t *testing.T) {
	var document metadataRegistrationConformanceDocument
	loadFacadeConformanceFixture(t, &document)

	rows := make([]metadataRegistrationCase, 0, len(document.Cases))
	for _, row := range document.Cases {
		require.NotEmptyf(t, row.Group, "case %q must carry a group", row.ID)
		if row.Group == metadataRegistrationGroup {
			rows = append(rows, row)
		}
	}
	require.Equalf(t, metadataRegistrationCaseCount, len(rows), "loaded %d %q cases", len(rows), metadataRegistrationGroup)

	endpoint := metadataRegistrationEndpoint()
	discoveryPath := mustPath(t, endpoint.OAuthAuthorizationServerPath)
	registerPath := mustPath(t, endpoint.OAuthRegisterPath)

	executed := 0
	for _, row := range rows {
		executed++
		t.Run(row.ID, func(t *testing.T) {
			app := newMetadataRegistrationApp(t, row)
			response := serve(app, "GET", discoveryPath, nil)
			require.Equalf(t, 200, response.Status, "row %q", row.ID)

			var payload map[string]any
			require.NoErrorf(t, json.Unmarshal(response.Body, &payload), "row %q", row.ID)

			switch row.Expect {
			case "absent":
				_, present := payload["registration_endpoint"]
				require.Falsef(t, present, "row %q must omit registration_endpoint; the /register route is not mounted", row.ID)
			case "configured":
				require.Equalf(t, row.RegistrationEndpointURL, payload["registration_endpoint"], "row %q", row.ID)
			case "issuer_derived":
				require.Equalf(t, frontTestBaseURL+"/acme/mcp/register", payload["registration_endpoint"], "row %q", row.ID)
			case "route_derived":
				require.Equalf(t, frontTestBaseURL+registerPath, payload["registration_endpoint"], "row %q", row.ID)
			default:
				t.Fatalf("unknown expect %q", row.Expect)
			}
		})
	}

	require.Equalf(t, metadataRegistrationCaseCount, executed, "executed %d %q cases", executed, metadataRegistrationGroup)
}

// methodStatusGroup names the route-model method-mismatch group the same shared
// table carries, executed below through the real mounted app.
const methodStatusGroup = "method_status"

// methodStatusCaseCount is the number of method_status rows the shared fixture
// must carry; a change to the table must also be a deliberate edit in the Go,
// TypeScript, and Python loaders, so no runtime can silently execute a smaller
// table.
const methodStatusCaseCount = 10

// methodStatusConformanceDocument and methodStatusCase are the method_status
// rows: a mounted path with an unsupported method answers 405 with a sorted
// allow header, and a path that is not mounted at all answers 404 with no allow.
type methodStatusConformanceDocument struct {
	Cases []methodStatusCase `json:"cases"`
}

type methodStatusCase struct {
	ID           string   `json:"id"`
	Group        string   `json:"group"`
	Route        string   `json:"route"`
	Method       string   `json:"method"`
	ExpectStatus int      `json:"expect_status"`
	ExpectAllow  []string `json:"expect_allow"`
}

// methodStatusRoutePath resolves a row's route key to the concrete path the
// facade mounts, deriving every mounted path from the framework's route-algebra
// helpers rather than a hard-coded string. The unmounted_token and unknown keys
// are deliberately not mounted: the first is a bare MCP path with a trailing
// segment, and the second is a path no kind's pattern can match.
func (h *frontChannelHarness) methodStatusRoutePath(key string) string {
	h.t.Helper()
	switch key {
	case "mcp":
		return h.path(mcproutes.EndpointPath.MCPPath)
	case "token":
		return h.path(mcproutes.EndpointPath.OAuthTokenPath)
	case "authorize":
		return h.path(mcproutes.EndpointPath.OAuthAuthorizePath)
	case "callback":
		return mcproutes.DefaultCallbackPath
	case "discovery_canonical":
		return h.path(mcproutes.EndpointPath.OAuthAuthorizationServerPath)
	case "discovery_suffix":
		return h.path(mcproutes.EndpointPath.OAuthAuthorizationServerSuffixPath)
	case "protected_resource":
		return h.path(mcproutes.EndpointPath.ProtectedResourcePath)
	case "unmounted_token":
		return h.path(mcproutes.EndpointPath.MCPPath) + "/token"
	case "unknown":
		return "/unknown/mcp/path"
	default:
		h.t.Fatalf("unknown method_status route key %q", key)
		return ""
	}
}

// allowMethods returns the sorted methods the response's allow header lists, or
// an empty list when the header is absent or empty.
func allowMethods(response apptheory.Response) []string {
	values := response.Headers["allow"]
	if len(values) == 0 || strings.TrimSpace(values[0]) == "" {
		return []string{}
	}
	parts := strings.Split(values[0], ",")
	methods := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			methods = append(methods, trimmed)
		}
	}
	sort.Strings(methods)
	return methods
}

// TestFrontChannelMethodStatusEnforcesTheSharedTable pins the route-model
// method-mismatch contract to the shared cross-runtime table through the real
// mounted app: a mounted path with an unsupported method answers 405 with an
// allow header listing the permitted methods, and a path that is not mounted at
// all answers 404 with no allow header.
func TestFrontChannelMethodStatusEnforcesTheSharedTable(t *testing.T) {
	var document methodStatusConformanceDocument
	loadFacadeConformanceFixture(t, &document)

	rows := make([]methodStatusCase, 0, len(document.Cases))
	for _, row := range document.Cases {
		require.NotEmptyf(t, row.Group, "case %q must carry a group", row.ID)
		if row.Group == methodStatusGroup {
			rows = append(rows, row)
		}
	}
	require.Equalf(t, methodStatusCaseCount, len(rows), "loaded %d %q cases", len(rows), methodStatusGroup)

	harness := newFrontChannelHarness(t)
	executed := 0
	for _, row := range rows {
		executed++
		t.Run(row.ID, func(t *testing.T) {
			response := harness.serve(row.Method, harness.methodStatusRoutePath(row.Route), nil, nil)

			require.Equalf(t, row.ExpectStatus, response.Status, "route %q method %q", row.Route, row.Method)
			require.Equalf(t, row.ExpectAllow, allowMethods(response), "route %q method %q", row.Route, row.Method)
			if row.ExpectStatus == 404 {
				require.Emptyf(t, response.Headers["allow"], "route %q method %q must carry no allow header", row.Route, row.Method)
			}
		})
	}

	require.Equalf(t, methodStatusCaseCount, executed, "executed %d %q cases", executed, methodStatusGroup)
}

// boundRouteGroup names the route-binding group the shared table carries,
// executed below through the real mounted /register, /authorize, and /token
// handlers.
const boundRouteGroup = "bound_route"

// boundRouteCaseCount is the number of bound_route rows the shared fixture must
// carry; a change to the table must also be a deliberate edit in the Go,
// TypeScript, and Python loaders, so no runtime can silently execute a smaller
// table.
const boundRouteCaseCount = 5

// boundRouteUnknownClientID is a client id no bound_route row ever registers, so
// a refusal row can present the very same request for an unknown client and
// prove the two refusals are byte-identical (THREAT_MODEL cross-cutting: no
// oracle).
const boundRouteUnknownClientID = "bound-route-unknown-client"

// boundRouteRedirectURI is the redirect URI every bound_route client registers
// and presents.
const boundRouteRedirectURI = "https://client.example/callback"

// boundRouteDefaultRouteKey and boundRouteSecondRouteKey are the route keys the
// shared table names. The default key is the harness's own namespace route; the
// second key is a different mounted route whose advertising resource genuinely
// differs, so a bound-route comparison cannot pass by coinciding on one path.
const (
	boundRouteDefaultRouteKey = "namespace"
	boundRouteSecondRouteKey  = "agent"
)

// boundRouteConformanceDocument and boundRouteConformanceCase are the bound_route
// rows: which client is presented, the route key it was registered at, the route
// key it is presented at, the stage, and the status the real handler must answer
// with. A "dcr" row registers its client through the real POST .../register
// handler at registered_at; a "pre_registered" row presents the record the
// harness seeded directly in the client store, which carries no bound route.
type boundRouteConformanceDocument struct {
	Cases []boundRouteConformanceCase `json:"cases"`
}

type boundRouteConformanceCase struct {
	ID           string `json:"id"`
	Group        string `json:"group"`
	Client       string `json:"client"`
	RegisteredAt string `json:"registered_at"`
	PresentedAt  string `json:"presented_at"`
	Stage        string `json:"stage"`
	ExpectStatus int    `json:"expect_status"`
}

// boundRouteEndpoint resolves a row's route key to the concrete endpoint the
// loader serves it at, so every mounted path is derived from the framework's
// route algebra rather than a hard-coded string.
func boundRouteEndpoint(t *testing.T, key string) mcproutes.EndpointPath {
	t.Helper()
	switch key {
	case boundRouteDefaultRouteKey:
		return mcproutes.EndpointPath{Kind: mcproutes.EndpointKindNamespace, ClientNamespace: "acme"}
	case boundRouteSecondRouteKey:
		return mcproutes.EndpointPath{Kind: mcproutes.EndpointKindAgent, ClientNamespace: "acme", AgentID: "agent-1"}
	default:
		t.Fatalf("unknown bound_route route key %q", key)
		return mcproutes.EndpointPath{}
	}
}

// boundRoutePath derives one mounted path of an endpoint with a route-algebra
// helper.
func boundRoutePath(t *testing.T, endpoint mcproutes.EndpointPath, build func(mcproutes.EndpointPath) (string, error)) string {
	t.Helper()
	path, err := build(endpoint)
	require.NoError(t, err)
	return path
}

// boundRouteResource is the advertising route resource of an endpoint, derived
// exactly as the facade derives it: the route MCP path under the public base URL.
func boundRouteResource(t *testing.T, endpoint mcproutes.EndpointPath) string {
	t.Helper()
	mcpPath, err := endpoint.MCPPath()
	require.NoError(t, err)
	return frontTestBaseURL + mcpPath
}

// boundRouteAuthorizeQuery is the valid authorize request the rows present,
// carrying the presented route's own advertising resource.
func boundRouteAuthorizeQuery(t *testing.T, endpoint mcproutes.EndpointPath, clientID string) url.Values {
	t.Helper()
	verifier := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"
	challenge, err := oauth.PKCEChallengeS256(verifier)
	require.NoError(t, err)
	return url.Values{
		"client_id":             {clientID},
		"redirect_uri":          {boundRouteRedirectURI},
		"response_type":         {"code"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"state":                 {frontTestClientState},
		"resource":              {boundRouteResource(t, endpoint)},
	}
}

// boundRouteTokenForm is the code-exchange form the rows present, carrying the
// verifier and the redirect URI the authorize leg used.
func boundRouteTokenForm(clientID, code string) url.Values {
	return url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"},
		"redirect_uri":  {boundRouteRedirectURI},
		"client_id":     {clientID},
	}
}

// boundRouteRegister registers one client through the real POST .../register
// handler at the row's registered route and returns the server-assigned id.
func boundRouteRegister(t *testing.T, harness *frontChannelHarness, endpoint mcproutes.EndpointPath) string {
	t.Helper()
	body, err := json.Marshal(map[string]any{"redirect_uris": []string{boundRouteRedirectURI}})
	require.NoError(t, err)
	response := harness.serve("POST", boundRoutePath(t, endpoint, mcproutes.EndpointPath.OAuthRegisterPath), nil, body)
	require.Equal(t, 201, response.Status)
	var payload struct {
		ClientID string `json:"client_id"`
	}
	require.NoError(t, json.Unmarshal(response.Body, &payload))
	require.NotEmpty(t, payload.ClientID)
	return payload.ClientID
}

// boundRouteMintCode completes authorize plus callback at the registered route
// and returns the facade code, so a token row has a genuinely redeemable code
// minted for the client it presents.
func boundRouteMintCode(t *testing.T, harness *frontChannelHarness, endpoint mcproutes.EndpointPath, clientID string) string {
	t.Helper()
	authorizeResponse := harness.serve(
		"GET",
		boundRoutePath(t, endpoint, mcproutes.EndpointPath.OAuthAuthorizePath),
		boundRouteAuthorizeQuery(t, endpoint, clientID),
		nil,
	)
	require.Equal(t, 302, authorizeResponse.Status)
	callback := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {frontTestUpstreamCode},
		"state": {locationQuery(t, authorizeResponse).Get("state")},
		"iss":   {frontTestUpstreamIss},
	}, nil)
	require.Equal(t, 302, callback.Status)
	code := locationQuery(t, callback).Get("code")
	require.NotEmpty(t, code)
	return code
}

// TestFrontChannelEnforcesTheSharedBoundRouteTable pins THREAT_MODEL T5 and
// DESIGN §8.3 to the shared cross-runtime table through the real mounted
// handlers: a client registered through POST .../register is accepted only at the
// advertising route it registered at and is refused at any other mounted route
// with the same non-oracle invalid_client response an unknown client gets, while
// a pre-registered client whose record carries no bound route stays valid at
// every route.
func TestFrontChannelEnforcesTheSharedBoundRouteTable(t *testing.T) {
	var document boundRouteConformanceDocument
	loadFacadeConformanceFixture(t, &document)

	rows := make([]boundRouteConformanceCase, 0, len(document.Cases))
	for _, row := range document.Cases {
		require.NotEmptyf(t, row.Group, "case %q must carry a group", row.ID)
		if row.Group == boundRouteGroup {
			rows = append(rows, row)
		}
	}
	require.Equalf(t, boundRouteCaseCount, len(rows), "loaded %d %q cases", len(rows), boundRouteGroup)

	executed := 0
	for _, row := range rows {
		executed++
		t.Run(row.ID, func(t *testing.T) {
			harness := newFrontChannelHarness(t)
			registered := boundRouteEndpoint(t, row.RegisteredAt)
			presented := boundRouteEndpoint(t, row.PresentedAt)

			clientID := frontTestClientID
			switch row.Client {
			case "dcr":
				clientID = boundRouteRegister(t, harness, registered)
			case "pre_registered":
				// The harness already seeded this record with no bound route.
			default:
				t.Fatalf("unknown bound_route client %q", row.Client)
			}

			var response, unknown apptheory.Response
			switch row.Stage {
			case "authorize":
				path := boundRoutePath(t, presented, mcproutes.EndpointPath.OAuthAuthorizePath)
				response = harness.serve("GET", path, boundRouteAuthorizeQuery(t, presented, clientID), nil)
				unknown = harness.serve("GET", path, boundRouteAuthorizeQuery(t, presented, boundRouteUnknownClientID), nil)
			case "token":
				path := boundRoutePath(t, presented, mcproutes.EndpointPath.OAuthTokenPath)
				code := boundRouteMintCode(t, harness, registered, clientID)
				response = harness.serve("POST", path, nil, []byte(boundRouteTokenForm(clientID, code).Encode()))
				unknown = harness.serve("POST", path, nil, []byte(boundRouteTokenForm(boundRouteUnknownClientID, code).Encode()))
			default:
				t.Fatalf("unknown bound_route stage %q", row.Stage)
			}

			require.Equalf(t, row.ExpectStatus, response.Status, "row %q", row.ID)
			if row.ExpectStatus == 200 {
				require.Containsf(t, string(response.Body), `"access_token"`, "row %q must return a token", row.ID)
			}
			if row.ExpectStatus == 302 {
				require.NotEmptyf(t, locationOf(response), "row %q must redirect", row.ID)
			}
			if row.ExpectStatus != 400 {
				return
			}
			// A refusal is the same non-oracle invalid_client response an unknown
			// client gets at this very route: byte-identical body, no redirect, and
			// no mention of any route the client might have registered at.
			require.Equalf(t, 400, unknown.Status, "row %q unknown-client control", row.ID)
			require.Equalf(
				t,
				string(unknown.Body),
				string(response.Body),
				"row %q must be byte-identical to the unknown-client refusal",
				row.ID,
			)
			require.Emptyf(t, locationOf(response), "row %q must not redirect", row.ID)
			require.Containsf(t, string(response.Body), `"error":"invalid_client"`, "row %q", row.ID)
			require.NotContainsf(t, string(response.Body), "route", "row %q must not name a route", row.ID)
		})
	}

	require.Equalf(t, boundRouteCaseCount, executed, "executed %d %q cases", executed, boundRouteGroup)
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

// TestFrontChannelTokenRefusesAnUnsupportedGrant pins the dispatch boundary the
// refresh grant did not move: a grant type the facade does not serve is still
// refused with unsupported_grant_type. The refresh grant itself is covered by
// refresh_test.go.
func TestFrontChannelTokenRefusesAnUnsupportedGrant(t *testing.T) {
	harness := newFrontChannelHarness(t)
	response := harness.token(url.Values{
		"grant_type": {"client_credentials"},
		"client_id":  {frontTestClientID},
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
