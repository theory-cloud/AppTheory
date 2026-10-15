package mcpfacade

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
	"github.com/theory-cloud/apptheory/v6/testkit/oauthprovider"
)

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
