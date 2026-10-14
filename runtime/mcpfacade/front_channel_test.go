package mcpfacade

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"sort"
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

// ---------------------------------------------------------------------------
// Shared journey table (contract-tests/fixtures/.../facade-journey.v1.json)
// ---------------------------------------------------------------------------

// facadeJourneyFixture is the shared MCP auth facade consumer-journey table,
// loaded from runtime/mcpfacade/ two levels below the module root.
const facadeJourneyFixture = "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-journey.v1.json"

// journeyGroup is the single group the journey table carries. The loader refuses
// any other group, so a stray row cannot be silently ignored.
const journeyGroup = "journey"

// journeyCaseCount is the number of journey rows the shared fixture must carry; a
// change to the table must also be a deliberate edit in the Go, TypeScript, and
// Python loaders, so no runtime can silently execute a shorter journey.
const journeyCaseCount = 26

const (
	// journeyRouteResource is the advertising resource of the namespace route the
	// journey world describes, equal to its route-mode issuer.
	journeyRouteResource = frontTestBaseURL + "/acme/mcp"
	// journeyMetadataURL is the route's RFC 9728 protected-resource metadata URL,
	// the value every transport challenge must name.
	journeyMetadataURL = frontTestBaseURL + "/.well-known/oauth-protected-resource/acme/mcp"
	// journeyWrongAudience is a route resource that is not the journey route's, so
	// the wrong-audience row presents a token bound elsewhere.
	journeyWrongAudience = frontTestBaseURL + "/other/mcp"
	// journeyUnknownClientID is a client id no journey row registers.
	journeyUnknownClientID = "unknown-client"
	// journeyVerifier is the S256 verifier every journey authorize and token step
	// pairs, matching the front-channel harness's own verifier.
	journeyVerifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"
	// journeyWrongVerifier is a verifier that does not hash to the challenge the
	// authorize step presented.
	journeyWrongVerifier = "WRONGVERIFIERWRONGVERIFIERWRONGVERIFIER1234567890"
)

// journeyConformanceDocument and journeyConformanceCase are the journey rows. A
// row names the harness action in stage and carries only the closed expectation
// vocabulary its stage understands, so one dispatcher per runtime executes every
// row without special cases per step.
type journeyConformanceDocument struct {
	Cases []journeyConformanceCase `json:"cases"`
}

type journeyConformanceCase struct {
	ID     string `json:"id"`
	Group  string `json:"group"`
	N      string `json:"n"`
	Stage  string `json:"stage"`
	Reason string `json:"reason"`

	// register
	Request            map[string]any `json:"request"`
	PrimeRegistrations int            `json:"prime_registrations"`
	ExpectBoundRoute   bool           `json:"expect_bound_route"`
	ExpectRetryAfter   bool           `json:"expect_retry_after"`

	// shared expectations
	ExpectStatus             int      `json:"expect_status"`
	ExpectBodyHas            []string `json:"expect_body_has"`
	ExpectBodyAbsent         []string `json:"expect_body_absent"`
	ExpectNoStore            bool     `json:"expect_no_store"`
	ExpectHandlerInvocations *int     `json:"expect_handler_invocations"`
	ExpectNoLocation         bool     `json:"expect_no_location"`
	ExpectError              string   `json:"expect_error"`
	ExpectAbsentFromLocation []string `json:"expect_absent_from_location"`

	// authorize
	Client                      string            `json:"client"`
	RedirectURI                 string            `json:"redirect_uri"`
	Omit                        []string          `json:"omit"`
	Set                         map[string]string `json:"set"`
	ExpectLocationHost          string            `json:"expect_location_host"`
	ExpectLocationQueryHas      []string          `json:"expect_location_query_has"`
	ExpectLocationQueryEquals   map[string]string `json:"expect_location_query_equals"`
	ExpectUpstreamStateDistinct bool              `json:"expect_upstream_state_distinct"`

	// callback
	Precondition                    string  `json:"precondition"`
	State                           string  `json:"state"`
	Code                            string  `json:"code"`
	Iss                             *string `json:"iss"`
	Terminal                        bool    `json:"terminal"`
	ExpectTransactionConsumed       *bool   `json:"expect_transaction_consumed"`
	ExpectUpstreamExchangeAttempted *bool   `json:"expect_upstream_exchange_attempted"`

	// token
	Mode                       string `json:"mode"`
	ExpectAccessTokenUnchanged bool   `json:"expect_access_token_unchanged"`
	ExpectRefreshHandleOpaque  bool   `json:"expect_refresh_handle_opaque"`
	ExpectRotatedHandle        bool   `json:"expect_rotated_handle"`
	ExpectBrokerRevoked        bool   `json:"expect_broker_revoked"`

	// transport
	Token                           string `json:"token"`
	ExpectChallengeResourceMetadata bool   `json:"expect_challenge_resource_metadata"`
	ExpectChallengeError            string `json:"expect_challenge_error"`
	ExpectChallengeScope            string `json:"expect_challenge_scope"`
}

func loadJourneyFixture(t *testing.T, target any) {
	t.Helper()
	body, err := os.ReadFile(facadeJourneyFixture) // #nosec G304 -- path is a fixed test fixture path built from a constant directory.
	require.NoErrorf(t, err, "read shared fixture %s", facadeJourneyFixture)
	require.NoErrorf(t, json.Unmarshal(body, target), "decode shared fixture %s", facadeJourneyFixture)
}

// journeySession is one harness plus the material a row's precondition mints, so
// no row hard-codes facade state.
type journeySession struct {
	harness       *frontChannelHarness
	invocations   *int
	upstreamState string
	facadeCode    string
	handle        string
	accessToken   string
}

// newJourneyHarness starts the journey harness: the front-channel harness with
// the runtime-bearer transport posture, a real JWKS claims validator over the
// fake upstream's key set, and an MCP handler that answers 200 and counts its
// invocations, so the journey's transport rows exercise the mounted facade's own
// transport middleware.
func newJourneyHarness(t *testing.T) (*frontChannelHarness, *int) {
	t.Helper()
	invocations := new(int)
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		transportPosture: TransportPostureRuntimeBearer,
		requireBearerTokenFor: func(fake *oauthprovider.Server) *oauth.RequireBearerTokenOptions {
			validator, err := oauth.NewJWKSValidator(oauth.JWKSValidatorOptions{
				Issuer:            frontTestUpstreamIss,
				JWKSURI:           fake.JWKSURL(),
				HTTPClient:        fake.HTTPClient(),
				AllowPrivateHosts: true,
				RequiredAudience:  journeyRequiredAudience,
				RequiredScopes:    journeyRequiredScopes,
			})
			require.NoError(t, err)
			return &oauth.RequireBearerTokenOptions{
				ResourceMetadataURL: journeyMetadataURL,
				ClaimsValidator:     validator,
				RequiredScopesFunc:  journeyRequiredScopes,
			}
		},
		mcpHandler:     func(*apptheory.Context) (*apptheory.Response, error) { return apptheory.Text(200, "mcp-ok"), nil },
		mcpInvocations: invocations,
	})
	return harness, invocations
}

// journeyRequiredAudience and journeyRequiredScopes are the route-derived
// audience and scope set the transport validator pins, matching the route the
// journey world describes.
func journeyRequiredAudience(*apptheory.Context) (string, error) { return journeyRouteResource, nil }

func journeyRequiredScopes(*apptheory.Context) ([]string, error) { return []string{"mcp:tools"}, nil }

// newJourneySession starts a journey harness and applies the row's declared
// precondition. Each row is executable in isolation: a row that needs facade
// material names the precondition that mints it, so dropping or reordering rows
// cannot silently weaken a later row.
func newJourneySession(t *testing.T, precondition string) *journeySession {
	t.Helper()
	harness, invocations := newJourneyHarness(t)
	session := &journeySession{harness: harness, invocations: invocations}
	if precondition == "" {
		return session
	}

	mintsAuthorize := precondition == "authorize" ||
		precondition == "authorize_consumed" ||
		strings.HasPrefix(precondition, "authorize_callback")
	if !mintsAuthorize {
		t.Fatalf("unknown journey precondition %q", precondition)
	}

	authorizeResponse := harness.authorize(nil)
	require.Equalf(t, 302, authorizeResponse.Status, "precondition %q authorize", precondition)
	session.upstreamState = locationQuery(t, authorizeResponse).Get("state")
	require.NotEmptyf(t, session.upstreamState, "precondition %q upstream state", precondition)
	if precondition == "authorize" {
		return session
	}

	callback := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {frontTestUpstreamCode},
		"state": {session.upstreamState},
		"iss":   {frontTestUpstreamIss},
	}, nil)
	require.Equalf(t, 302, callback.Status, "precondition %q callback", precondition)
	session.facadeCode = locationQuery(t, callback).Get("code")
	require.NotEmptyf(t, session.facadeCode, "precondition %q facade code", precondition)
	if precondition == "authorize_consumed" || precondition == "authorize_callback" {
		return session
	}

	exchange := harness.token(journeyTokenForm(session.facadeCode, journeyVerifier))
	require.Equalf(t, 200, exchange.Status, "precondition %q exchange", precondition)
	session.accessToken = journeyTokenField(t, exchange, "access_token")
	session.handle = journeyTokenField(t, exchange, "refresh_token")
	if precondition == "authorize_callback_exchange" {
		return session
	}

	replay := harness.token(journeyTokenForm(session.facadeCode, journeyVerifier))
	require.Equalf(t, 400, replay.Status, "precondition %q replay", precondition)
	return session
}

// journeyTokenForm is the full RFC 6749 §4.1.3 authorization_code grant the token
// rows present.
func journeyTokenForm(code, verifier string) url.Values {
	return url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {verifier},
		"redirect_uri":  {"https://client.example/callback"},
		"client_id":     {frontTestClientID},
	}
}

// journeyTokenField reads one string member of a token response body.
func journeyTokenField(t *testing.T, response apptheory.Response, field string) string {
	t.Helper()
	var payload map[string]any
	require.NoErrorf(t, json.Unmarshal(response.Body, &payload), "token response must be a JSON object")
	value, ok := payload[field].(string)
	require.Truef(t, ok, "token response member %s must be a string", field)
	require.NotEmptyf(t, value, "token response must carry %s", field)
	return value
}

// journeyTransportToken mints the token a transport row presents. The fault
// tokens are minted by the fake's own key, so only the pinned claim differs and
// the refusal cannot come from a bad signature.
func journeyTransportToken(t *testing.T, harness *frontChannelHarness, token string) string {
	t.Helper()
	claims := func(audience, scope string, expiresIn int) oauthprovider.Claims {
		return oauthprovider.Claims{
			Issuer:          frontTestUpstreamIss,
			Audience:        audience,
			AuthorizedParty: frontTestClientID,
			Subject:         "user-1",
			Scope:           scope,
			ExpiresIn:       expiresIn,
		}
	}
	switch token {
	case "wrong_audience":
		return harness.fake.MintAccessToken(claims(journeyWrongAudience, "mcp:tools", 900))
	case "expired":
		return harness.fake.MintAccessToken(claims(journeyRouteResource, "mcp:tools", -60))
	case "insufficient_scope":
		return harness.fake.MintAccessToken(claims(journeyRouteResource, "mcp:read", 900))
	default:
		t.Fatalf("unknown journey transport token %q", token)
		return ""
	}
}

// TestFrontChannelExecutesTheSharedJourneyTable pins the whole minimal non-TMS
// consumer journey to the shared cross-runtime table through the real mounted
// routes: every step of MINIMAL_CONSUMER.md is one data row, and the Go,
// TypeScript, and Python loaders each execute all of them, so the journey is
// executed from shared data rather than narrated.
func TestFrontChannelExecutesTheSharedJourneyTable(t *testing.T) {
	var document journeyConformanceDocument
	loadJourneyFixture(t, &document)

	rows := make([]journeyConformanceCase, 0, len(document.Cases))
	for _, row := range document.Cases {
		require.NotEmptyf(t, row.Group, "case %q must carry a group", row.ID)
		require.Equalf(
			t,
			journeyGroup,
			row.Group,
			"case %q carries group %q; the journey loader executes only %q",
			row.ID,
			row.Group,
			journeyGroup,
		)
		rows = append(rows, row)
	}
	require.Equalf(t, journeyCaseCount, len(rows), "loaded %d %q cases", len(rows), journeyGroup)

	executed := 0
	for _, row := range rows {
		executed++
		t.Run(row.ID, func(t *testing.T) {
			switch row.Stage {
			case "transport":
				executeJourneyTransportRow(t, row)
			case "protected_resource":
				executeJourneyMetadataRow(t, row, false)
			case "authorization_server_metadata":
				executeJourneyMetadataRow(t, row, true)
			case "register":
				executeJourneyRegisterRow(t, row)
			case "authorize":
				executeJourneyAuthorizeRow(t, row)
			case "callback":
				executeJourneyCallbackRow(t, row)
			case "token":
				executeJourneyTokenRow(t, row)
			default:
				t.Fatalf("row %q carries unknown stage %q", row.ID, row.Stage)
			}
		})
	}

	require.Equalf(t, journeyCaseCount, executed, "executed %d %q cases", executed, journeyGroup)
}

// executeJourneyTransportRow presents the row's bearer token at the mounted
// transport route and pins the denied or admitted class with the challenge the
// middleware renders.
func executeJourneyTransportRow(t *testing.T, row journeyConformanceCase) {
	t.Helper()
	session := newJourneySession(t, row.Precondition)
	harness := session.harness

	headers := map[string][]string{}
	switch row.Token {
	case "none":
	case "valid":
		require.NotEmptyf(t, session.accessToken, "row %q needs the precondition's exchange", row.ID)
		headers["authorization"] = []string{"Bearer " + session.accessToken}
	case "wrong_audience", "expired", "insufficient_scope":
		headers["authorization"] = []string{"Bearer " + journeyTransportToken(t, harness, row.Token)}
	default:
		t.Fatalf("row %q carries unknown token %q", row.ID, row.Token)
	}

	response := harness.app.Serve(context.Background(), apptheory.Request{
		Method:  "POST",
		Path:    harness.path(mcproutes.EndpointPath.MCPPath),
		Headers: headers,
		Body:    []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`),
	})

	require.Equalf(t, row.ExpectStatus, response.Status, "row %q", row.ID)
	switch {
	case row.ExpectChallengeResourceMetadata:
		require.Equalf(
			t,
			[]string{oauth.ProtectedResourceWWWAuthenticate(journeyMetadataURL)},
			response.Headers["www-authenticate"],
			"row %q must carry the RFC 9728 discovery challenge",
			row.ID,
		)
	case row.ExpectChallengeError != "":
		require.Equalf(
			t,
			[]string{oauth.InsufficientScopeWWWAuthenticate([]string{row.ExpectChallengeScope}, journeyMetadataURL)},
			response.Headers["www-authenticate"],
			"row %q must carry the RFC 6750 insufficient_scope challenge",
			row.ID,
		)
	default:
		require.Emptyf(t, response.Headers["www-authenticate"], "row %q must advertise no challenge", row.ID)
	}
	if row.ExpectHandlerInvocations != nil {
		require.Equalf(t, *row.ExpectHandlerInvocations, *session.invocations, "row %q handler invocations", row.ID)
	}
}

// executeJourneyMetadataRow serves the row's discovery document and pins its
// body members and uncacheability.
func executeJourneyMetadataRow(t *testing.T, row journeyConformanceCase, authorizationServer bool) {
	t.Helper()
	session := newJourneySession(t, row.Precondition)
	build := mcproutes.EndpointPath.ProtectedResourcePath
	if authorizationServer {
		build = mcproutes.EndpointPath.OAuthAuthorizationServerPath
	}

	response := session.harness.serve("GET", session.harness.path(build), nil, nil)
	require.Equalf(t, row.ExpectStatus, response.Status, "row %q", row.ID)

	body := string(response.Body)
	for _, token := range row.ExpectBodyHas {
		require.Containsf(t, body, token, "row %q body", row.ID)
	}
	if row.ExpectNoStore {
		require.Equalf(t, []string{"no-store"}, response.Headers["cache-control"], "row %q", row.ID)
	}
}

// executeJourneyRegisterRow registers through the real mounted handler. The row
// runs against its own registration bucket, so the rate-limited row's own request
// is the first refusal rather than a count that depends on earlier rows.
func executeJourneyRegisterRow(t *testing.T, row journeyConformanceCase) {
	t.Helper()
	harness, _ := newJourneyHarness(t)
	path := harness.path(mcproutes.EndpointPath.OAuthRegisterPath)

	var body []byte
	if row.Request != nil {
		encoded, err := json.Marshal(row.Request)
		require.NoErrorf(t, err, "row %q must serialize", row.ID)
		body = encoded
	}
	for attempt := 0; attempt < row.PrimeRegistrations; attempt++ {
		primed := harness.serve("POST", path, nil, []byte(`{"redirect_uris":["https://client.example/callback"]}`))
		require.Equalf(t, 201, primed.Status, "row %q priming attempt %d", row.ID, attempt+1)
	}

	response := harness.serve("POST", path, nil, body)
	require.Equalf(t, row.ExpectStatus, response.Status, "row %q", row.ID)

	scanned := string(response.Body)
	for _, token := range row.ExpectBodyHas {
		require.Containsf(t, scanned, token, "row %q body", row.ID)
	}
	if row.ExpectNoStore {
		require.Equalf(t, []string{"no-store"}, response.Headers["cache-control"], "row %q", row.ID)
		require.Equalf(t, []string{"no-cache"}, response.Headers["pragma"], "row %q", row.ID)
	}
	if row.ExpectRetryAfter {
		values := response.Headers["retry-after"]
		require.NotEmptyf(t, values, "row %q must carry a retry-after header", row.ID)
		seconds, err := strconv.Atoi(values[0])
		require.NoErrorf(t, err, "row %q must carry a whole-second retry-after header", row.ID)
		require.GreaterOrEqualf(t, seconds, 1, "row %q must not ask for a retry sooner than one second", row.ID)
	}
	if row.ExpectBoundRoute {
		var payload struct {
			ClientID string `json:"client_id"`
		}
		require.NoErrorf(t, json.Unmarshal(response.Body, &payload), "row %q must return a JSON object body", row.ID)
		require.NotEmptyf(t, payload.ClientID, "row %q must mint a client id", row.ID)
		record, err := harness.stores.Client.Get(context.Background(), oauthstore.HashKey(payload.ClientID))
		require.NoErrorf(t, err, "row %q must persist the registered client", row.ID)
		require.Equalf(t, journeyRouteResource, record.BoundRoute, "row %q must bind the client to the advertising route", row.ID)
	}
}

// executeJourneyAuthorizeRow serves the row's authorize request, omitting and
// overriding exactly the parameters the row names so the expected outcome is the
// only reachable one.
func executeJourneyAuthorizeRow(t *testing.T, row journeyConformanceCase) {
	t.Helper()
	session := newJourneySession(t, row.Precondition)
	harness := session.harness

	clientID := frontTestClientID
	if row.Client == "unknown" {
		clientID = journeyUnknownClientID
	}
	challenge, err := oauth.PKCEChallengeS256(journeyVerifier)
	require.NoError(t, err)
	query := url.Values{
		"client_id":             {clientID},
		"redirect_uri":          {"https://client.example/callback"},
		"response_type":         {"code"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"state":                 {frontTestClientState},
		"resource":              {journeyRouteResource},
	}
	if row.RedirectURI != "" {
		query.Set("redirect_uri", row.RedirectURI)
	}
	for _, key := range row.Omit {
		query.Del(key)
	}
	for key, value := range row.Set {
		query.Set(key, value)
	}

	response := harness.serve("GET", harness.path(mcproutes.EndpointPath.OAuthAuthorizePath), query, nil)
	require.Equalf(t, row.ExpectStatus, response.Status, "row %q", row.ID)

	location := locationOf(response)
	if row.ExpectNoLocation {
		require.Emptyf(t, location, "row %q must not redirect", row.ID)
	}
	if row.ExpectError != "" {
		require.Truef(
			t,
			locationQuery(t, response).Get("error") == row.ExpectError ||
				strings.Contains(string(response.Body), `"error":"`+row.ExpectError+`"`),
			"row %q must answer error %q; location %q body %q",
			row.ID,
			row.ExpectError,
			location,
			string(response.Body),
		)
	}
	if row.ExpectLocationHost != "" {
		require.Truef(
			t,
			strings.HasPrefix(location, row.ExpectLocationHost+"/"),
			"row %q location %q must be beneath %s",
			row.ID,
			location,
			row.ExpectLocationHost,
		)
	}
	queryResult := locationQuery(t, response)
	for _, key := range row.ExpectLocationQueryHas {
		require.Truef(t, queryResult.Has(key), "row %q location must carry %s", row.ID, key)
	}
	for key, value := range row.ExpectLocationQueryEquals {
		require.Equalf(t, value, queryResult.Get(key), "row %q location %s", row.ID, key)
	}
	if row.ExpectUpstreamStateDistinct {
		upstreamState := queryResult.Get("state")
		require.NotEmptyf(t, upstreamState, "row %q must mint an upstream state", row.ID)
		require.NotEqualf(t, frontTestClientState, upstreamState, "row %q must mint an upstream state distinct from the client's", row.ID)
	}
}

// executeJourneyCallbackRow serves the row's upstream return and pins the class:
// a completed redirect, or a refusal that consumed nothing and exchanged nothing.
func executeJourneyCallbackRow(t *testing.T, row journeyConformanceCase) {
	t.Helper()
	session := newJourneySession(t, row.Precondition)
	harness := session.harness

	state := row.State
	if state == "precondition" {
		state = session.upstreamState
		require.NotEmptyf(t, state, "row %q needs the precondition's upstream state", row.ID)
	}
	code := row.Code
	if code == "upstream" {
		code = frontTestUpstreamCode
	}
	query := url.Values{"code": {code}, "state": {state}}
	if row.Iss != nil {
		query.Set("iss", *row.Iss)
	}

	before := harness.fake.TokenCallCount()
	response := harness.serve("GET", mcproutes.DefaultCallbackPath, query, nil)

	require.Equalf(t, row.ExpectStatus, response.Status, "row %q", row.ID)
	location := locationOf(response)
	if row.ExpectNoLocation {
		require.Emptyf(t, location, "row %q must not redirect", row.ID)
	}
	scanned := string(response.Body)
	for _, token := range row.ExpectBodyHas {
		require.Containsf(t, scanned, token, "row %q body", row.ID)
	}
	if row.ExpectLocationHost != "" {
		require.Truef(
			t,
			strings.HasPrefix(location, row.ExpectLocationHost+"/"),
			"row %q location %q must be beneath %s",
			row.ID,
			location,
			row.ExpectLocationHost,
		)
	}
	queryResult := locationQuery(t, response)
	for _, key := range row.ExpectLocationQueryHas {
		require.Truef(t, queryResult.Has(key), "row %q location must carry %s", row.ID, key)
	}
	for key, value := range row.ExpectLocationQueryEquals {
		require.Equalf(t, value, queryResult.Get(key), "row %q location %s", row.ID, key)
	}
	if len(row.ExpectAbsentFromLocation) > 0 {
		leaked := responseScan(response)
		for _, token := range row.ExpectAbsentFromLocation {
			require.NotContainsf(t, leaked, token, "row %q must not leak %s anywhere in the response", row.ID, token)
		}
	}
	if row.ExpectHandlerInvocations != nil {
		require.Equalf(t, *row.ExpectHandlerInvocations, *session.invocations, "row %q handler invocations", row.ID)
	}
	if row.ExpectUpstreamExchangeAttempted != nil && !*row.ExpectUpstreamExchangeAttempted {
		require.Equalf(t, before, harness.fake.TokenCallCount(), "row %q must attempt no upstream exchange", row.ID)
	}
	if row.ExpectTransactionConsumed != nil && !*row.ExpectTransactionConsumed {
		retry := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
			"code":  {code},
			"state": {state},
			"iss":   {frontTestUpstreamIss},
		}, nil)
		require.Equalf(t, 302, retry.Status, "row %q must leave the transaction unconsumed for a correct retry", row.ID)
		require.NotEmptyf(t, locationQuery(t, retry).Get("code"), "row %q must complete on the retry", row.ID)
	}
	if row.Terminal {
		require.Equalf(t, 400, response.Status, "row %q: a consumed state is terminal", row.ID)
		require.Emptyf(t, location, "row %q: a consumed state must not redirect", row.ID)
		require.Equalf(t, before, harness.fake.TokenCallCount(), "row %q: a consumed state must never re-exchange", row.ID)
	}
}

// executeJourneyTokenRow presents the row's token request and pins the returned
// material: the upstream access token unchanged, an opaque rotating handle, and
// no upstream refresh token or id_token.
func executeJourneyTokenRow(t *testing.T, row journeyConformanceCase) {
	t.Helper()
	session := newJourneySession(t, row.Precondition)
	harness := session.harness

	var response apptheory.Response
	switch row.Mode {
	case "exchange":
		response = harness.token(journeyTokenForm(session.facadeCode, journeyVerifier))
	case "replay":
		response = harness.token(journeyTokenForm(session.facadeCode, journeyVerifier))
	case "wrong_verifier":
		response = harness.token(journeyTokenForm(session.facadeCode, journeyWrongVerifier))
	case "refresh", "revoked_refresh":
		require.NotEmptyf(t, session.handle, "row %q needs the precondition's handle", row.ID)
		response = harness.token(url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {session.handle},
			"client_id":     {frontTestClientID},
		})
	default:
		t.Fatalf("row %q carries unknown token mode %q", row.ID, row.Mode)
	}

	require.Equalf(t, row.ExpectStatus, response.Status, "row %q", row.ID)
	scanned := string(response.Body)
	for _, token := range row.ExpectBodyHas {
		require.Containsf(t, scanned, token, "row %q body", row.ID)
	}
	for _, token := range row.ExpectBodyAbsent {
		require.NotContainsf(t, scanned, token, "row %q must not carry %s", row.ID, token)
	}
	if row.ExpectError != "" {
		require.Containsf(t, scanned, `"error":"`+row.ExpectError+`"`, "row %q", row.ID)
	}
	if row.ExpectAccessTokenUnchanged {
		accessToken := journeyTokenField(t, response, "access_token")
		if row.Mode == "refresh" {
			require.Equalf(
				t,
				frontTestRefreshAccessToken,
				accessToken,
				"row %q must return the upstream refresh access token byte-for-byte",
				row.ID,
			)
		} else {
			_, err := harness.bearerValidator(nil, accessToken)
			require.NoErrorf(t, err, "row %q must return the upstream-minted access token unchanged", row.ID)
		}
	}
	if row.ExpectRefreshHandleOpaque {
		handle := journeyTokenField(t, response, "refresh_token")
		require.NotEqualf(t, frontTestRefreshToken, handle, "row %q must not hand back the upstream refresh token", row.ID)
	}
	if row.ExpectRotatedHandle {
		handle := journeyTokenField(t, response, "refresh_token")
		require.NotEqualf(t, session.handle, handle, "row %q must rotate the route handle", row.ID)
	}
	if row.ExpectBrokerRevoked {
		record, err := harness.stores.RouteRefreshBroker.Get(context.Background(), oauthstore.HashKey(session.handle))
		require.NoErrorf(t, err, "row %q", row.ID)
		require.Equalf(
			t,
			oauthstore.BrokerStatusRevoked,
			record.Status,
			"row %q must revoke the broker record the code minted",
			row.ID,
		)
	}
	if row.ExpectHandlerInvocations != nil {
		require.Equalf(t, *row.ExpectHandlerInvocations, *session.invocations, "row %q handler invocations", row.ID)
	}
}

// ---------------------------------------------------------------------------
// Shared threat-controls table
// (contract-tests/fixtures/.../facade-threat-controls.v1.json)
// ---------------------------------------------------------------------------

// mcpAuthFacadeFixtureDir is the directory the shared MCP auth facade tables
// live in, two levels below the module root, shared by the threat-controls
// checker so every pinned table is located exactly as the journey and
// conformance loaders locate theirs.
const mcpAuthFacadeFixtureDir = "../../contract-tests/fixtures/routing/mcp-auth-facade/"

// facadeThreatControlsFixture is the shared threat-control pinning table.
const facadeThreatControlsFixture = mcpAuthFacadeFixtureDir + "facade-threat-controls.v1.json"

// threatControlsGroup is the single group the threat-controls table carries. The
// checker refuses any other group, so a stray row cannot be silently ignored.
const threatControlsGroup = "threat_controls"

// threatControlsCaseCount is the number of threat rows the shared fixture must
// carry; a change to the table must also be a deliberate edit in the Go,
// TypeScript, and Python checkers, so no runtime can silently check fewer rows.
const threatControlsCaseCount = 11

// threatPinSource is one entry of the closed pin vocabulary: the fixture a pin
// source names, and the row shapes that fixture is looked up in.
type threatPinSource struct {
	File       string
	ByCaseID   bool
	ByCaseName bool
	ByKey      bool
}

// threatPinSources is the closed pin vocabulary every threat-controls pin source
// must belong to. Each entry names a table in the corpus and how a pin's row is
// resolved inside it: a cases[].id, a cases[].name, or a dotted key path.
var threatPinSources = map[string]threatPinSource{
	"journey":              {File: "facade-journey.v1.json", ByCaseID: true, ByKey: true},
	"conformance":          {File: "facade-conformance.v1.json", ByCaseID: true},
	"route_model":          {File: "facade-route-model.v1.json", ByKey: true},
	"transport_posture":    {File: "facade-transport-posture.v1.json", ByKey: true},
	"jwks_validator":       {File: "jwks-validator.v1.json", ByCaseName: true},
	"discovery_bootstrap":  {File: "discovery-bootstrap.v1.json", ByCaseName: true, ByKey: true},
	"provider_conformance": {File: "facade-provider-conformance.v1.json", ByCaseID: true},
	"store_conformance":    {File: "facade-store-conformance.v1.json", ByCaseID: true},
	"route_challenge":      {File: "route-challenge.v1.json", ByKey: true},
}

// threatControlsDocument and threatControlCase are the threat-controls rows: one
// row per threat (T1-T11), each naming the attack class, the control, the
// fixture-backed pins that resolve to executed rows, and the pin strings that
// name no corpus row (a design statement or the conformance kit's own harness).
type threatControlsDocument struct {
	ID          string              `json:"id"`
	Kind        string              `json:"kind"`
	Status      string              `json:"status"`
	Description string              `json:"description"`
	Cases       []threatControlCase `json:"cases"`
}

type threatControlCase struct {
	ID                string      `json:"id"`
	Group             string      `json:"group"`
	Threat            string      `json:"threat"`
	Control           string      `json:"control"`
	Pins              []threatPin `json:"pins"`
	NativePins        []string    `json:"native_pins"`
	SourcePins        []string    `json:"source_pins"`
	RuntimeExecutable bool        `json:"runtime_executable"`
	CDKVisible        bool        `json:"cdk_visible"`
}

type threatPin struct {
	Source string `json:"source"`
	Row    string `json:"row"`
}

func loadThreatControlsFixture(t *testing.T) threatControlsDocument {
	t.Helper()
	body, err := os.ReadFile(facadeThreatControlsFixture) // #nosec G304 -- path is a fixed test fixture path built from a constant directory.
	require.NoErrorf(t, err, "read shared fixture %s", facadeThreatControlsFixture)
	var document threatControlsDocument
	require.NoErrorf(t, json.Unmarshal(body, &document), "decode shared fixture %s", facadeThreatControlsFixture)
	return document
}

// TestFrontChannelThreatControlsResolveAgainstThePinnedTables proves every
// threat row's pin resolves to an executed row in the table it names, so the
// shared threat-controls table is bidirectional: dropping a referenced row fails
// the check, and adding a pin that resolves to nothing fails it too.
func TestFrontChannelThreatControlsResolveAgainstThePinnedTables(t *testing.T) {
	document := loadThreatControlsFixture(t)
	require.Equal(t, "mcp.auth.facade.threat_controls", document.ID)
	require.Equal(t, "conformance", document.Kind)
	require.NotEmpty(t, document.Status, "the threat-controls table must carry a status")
	require.NotEmpty(t, document.Description, "the threat-controls table must carry a description")

	documents := map[string]map[string]any{}
	loadPinnedTable := func(source string) map[string]any {
		if doc, ok := documents[source]; ok {
			return doc
		}
		path := mcpAuthFacadeFixtureDir + threatPinSources[source].File
		body, err := os.ReadFile(path) // #nosec G304 -- path is a fixed test fixture path built from a constant directory.
		require.NoErrorf(t, err, "read pinned fixture %s", path)
		var doc map[string]any
		require.NoErrorf(t, json.Unmarshal(body, &doc), "decode pinned fixture %s", path)
		documents[source] = doc
		return doc
	}

	// resolves reports whether the pin's row is a real id, name, or key inside the
	// table its source names.
	resolves := func(sourceKey, row string) bool {
		source := threatPinSources[sourceKey]
		table := loadPinnedTable(sourceKey)
		if source.ByCaseID || source.ByCaseName {
			caseEntries, entriesOK := table["cases"].([]any)
			if !entriesOK {
				return false
			}
			for _, entry := range caseEntries {
				fields, ok := entry.(map[string]any)
				if !ok {
					continue
				}
				if source.ByCaseID {
					if id, idOK := fields["id"].(string); idOK && id != "" && id == row {
						return true
					}
				}
				if source.ByCaseName {
					if name, nameOK := fields["name"].(string); nameOK && name != "" && name == row {
						return true
					}
				}
			}
		}
		if !source.ByKey {
			return false
		}
		var current any = table
		for _, part := range strings.Split(row, ".") {
			fields, ok := current.(map[string]any)
			if !ok {
				return false
			}
			next, ok := fields[part]
			if !ok {
				return false
			}
			current = next
		}
		return current != nil
	}

	rows := make([]threatControlCase, 0, len(document.Cases))
	for _, row := range document.Cases {
		require.NotEmptyf(t, row.Group, "case %q must carry a group", row.ID)
		require.Equalf(
			t,
			threatControlsGroup,
			row.Group,
			"case %q carries group %q; the threat-controls checker reads only %q",
			row.ID,
			row.Group,
			threatControlsGroup,
		)
		rows = append(rows, row)
	}
	require.Equalf(t, threatControlsCaseCount, len(rows), "loaded %d %q cases", len(rows), threatControlsGroup)

	checked := 0
	for _, row := range rows {
		checked++
		t.Run(row.ID, func(t *testing.T) {
			require.NotEmptyf(t, row.Threat, "case %q must name the attack class", row.ID)
			require.NotEmptyf(t, row.Control, "case %q must name the framework control", row.ID)
			require.NotEmptyf(t, row.SourcePins, "case %q must preserve the pin strings it was lifted from", row.ID)
			if row.RuntimeExecutable {
				require.NotEmptyf(
					t,
					row.Pins,
					"case %q is runtime_executable but carries no fixture-backed pin",
					row.ID,
				)
			}
			for _, pin := range row.Pins {
				source, ok := threatPinSources[pin.Source]
				require.Truef(
					t,
					ok,
					"case %q pin source %q is outside the closed pin vocabulary",
					row.ID,
					pin.Source,
				)
				require.Truef(
					t,
					resolves(pin.Source, pin.Row),
					"case %q pin %s:%s does not resolve inside %s",
					row.ID,
					pin.Source,
					pin.Row,
					source.File,
				)
			}
		})
	}
	require.Equalf(t, threatControlsCaseCount, checked, "checked %d %q cases", checked, threatControlsGroup)
}
