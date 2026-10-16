package mcpfacade

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	"github.com/theory-cloud/apptheory/v6/testkit/oauthprovider"
)

// ---------------------------------------------------------------------------
// Shared SecureApp mount table
// (contract-tests/fixtures/.../facade-conformance.v1.json, group secure_app_mount)
// ---------------------------------------------------------------------------

// secureAppMountGroup names the SecureApp seam group the shared table carries,
// executed below through the really-mounted SecureApp.
const secureAppMountGroup = "secure_app_mount"

// secureAppMountCaseCount is the number of secure_app_mount rows the shared
// fixture must carry; a change to the table must also be a deliberate edit in
// the Go, TypeScript, and Python loaders, so no runtime can silently execute a
// smaller table.
const secureAppMountCaseCount = 41

const (
	// secureMountRouteResource is the advertising resource of the namespace route
	// the rows exercise, equal to its route-mode issuer.
	secureMountRouteResource = frontTestBaseURL + "/acme/mcp"
	// secureMountResourceMetadataURL is that route's RFC 9728 protected-resource
	// metadata URL, the value every transport challenge must name.
	secureMountResourceMetadataURL = frontTestBaseURL + "/.well-known/oauth-protected-resource/acme/mcp"
	// secureMountScope is the route-derived scope set the transport validator and
	// the RFC 6750 remediation challenge both pin, matching the harness's facade.
	secureMountScope = "mcp:tools"

	// secureMountVerifier is the S256 verifier the harness's authorize leg pins,
	// and secureMountRedirectURI is the redirect URI its client registered.
	secureMountVerifier    = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"
	secureMountRedirectURI = "https://client.example/callback"

	// secureMountSessionHeader and secureMountSessionValue are the application's
	// own credential: the counting resolver admits exactly the request that
	// presents them, so every other request resolves to a nil principal.
	secureMountSessionHeader = "x-tms-session"
	secureMountSessionValue  = "valid"
	// secureMountAuthorizationHeader carries the transport bearer token.
	secureMountAuthorizationHeader = "authorization"
	// secureMountIdentity is the principal the application's resolver returns.
	secureMountIdentity = "tms-operator"

	// secureMountAuditPath is the application's own authenticated route, mounted
	// beside the facade, standing in for TMS's non-MCP families; secureMountAuditBody
	// is what it answers, so a 200 proves the non-facade handler genuinely ran.
	secureMountAuditPath = "/internal/audit"
	secureMountAuditBody = "audit-ok"
	// secureMountUndeclaredPath is a path no mount declares.
	secureMountUndeclaredPath = "/internal/undeclared"

	// secureMountMCPBody is a minimal MCP request body, and
	// secureMountMCPHandlerBody is what the journey's MCP handler answers.
	secureMountMCPBody           = `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
	secureMountMCPHandlerBody    = "mcp-ok"
	secureMountInsufficientScope = "mcp:read"
)

// secureAppMountConformanceDocument and secureAppMountCase are the
// secure_app_mount rows. A row names its scenario and carries only the closed
// expectation vocabulary that scenario understands: the authority table as data
// for "posture", a really-mounted request and what it must make the app do for
// "request", and the two registrars' inventories for "inventory_parity".
// secureAppMountConformanceDocument is the shared table's raw rows: the
// secure_app_mount rows are decoded one by one, because a `request` member that
// is an object belongs to another group of the same table.
type secureAppMountConformanceDocument struct {
	Cases []json.RawMessage `json:"cases"`
}

type secureAppMountCase struct {
	ID       string `json:"id"`
	Group    string `json:"group"`
	Scenario string `json:"scenario"`

	// posture
	TransportPosture string `json:"transport_posture"`
	FrontChannel     bool   `json:"front_channel"`
	Route            string `json:"route"`
	Method           string `json:"method"`
	ExpectPresent    bool   `json:"expect_present"`
	ExpectPosture    string `json:"expect_posture"`

	// request
	Request                         string `json:"request"`
	ExpectStatus                    int    `json:"expect_status"`
	ExpectChallengeResourceMetadata bool   `json:"expect_challenge_resource_metadata"`
	ExpectChallengeScope            string `json:"expect_challenge_scope"`
	ExpectHandlerInvocations        *int   `json:"expect_handler_invocations"`
	ExpectResolverInvocations       *int   `json:"expect_resolver_invocations"`
	ExpectPolicyHookInvocations     *int   `json:"expect_policy_hook_invocations"`

	// PolicyHook selects how the application's own policy hook answers: the zero
	// value allows (the allow-policy every other request row pins), and "deny"
	// denies with PolicyHookCode, so a row can pin a FACADE route against the
	// policy hook's own denial rather than the transport gate's.
	PolicyHook     string `json:"policy_hook"`
	PolicyHookCode string `json:"policy_hook_code"`

	// inventory_parity
	ExpectEqual             bool   `json:"expect_equal"`
	IssuerMode              string `json:"issuer_mode"`
	RootAuthorizationServer bool   `json:"root_authorization_server"`
}

// TestSecureAppMountEnforcesTheSharedTable pins the SecureApp seam to the shared
// cross-runtime table through the really-mounted SecureApp: every posture row
// asserts the authority table as data, every request row drives the mounted app,
// and every inventory_parity row proves the two registrars agree. The Go,
// TypeScript, and Python loaders each execute all of the rows.
func TestSecureAppMountEnforcesTheSharedTable(t *testing.T) {
	var document secureAppMountConformanceDocument
	loadFacadeConformanceFixture(t, &document)

	rows := make([]secureAppMountCase, 0, len(document.Cases))
	for _, raw := range document.Cases {
		var row secureAppMountCase
		if decodeFacadeConformanceCase(t, raw, secureAppMountGroup, &row) {
			rows = append(rows, row)
		}
	}
	require.Equalf(t, secureAppMountCaseCount, len(rows), "loaded %d %q cases", len(rows), secureAppMountGroup)

	executed := 0
	for _, row := range rows {
		executed++
		t.Run(row.ID, func(t *testing.T) {
			switch row.Scenario {
			case "posture":
				executeSecureMountPostureRow(t, row)
			case "request":
				executeSecureMountRequestRow(t, row)
			case "inventory_parity":
				executeSecureMountInventoryParityRow(t, row)
			default:
				t.Fatalf("row %q carries unknown scenario %q", row.ID, row.Scenario)
			}
		})
	}

	require.Equalf(t, secureAppMountCaseCount, executed, "executed %d %q cases", executed, secureAppMountGroup)
}

// ---------------------------------------------------------------------------
// posture rows: the authority table as data
// ---------------------------------------------------------------------------

// executeSecureMountPostureRow proves the row's route declares the row's posture
// on the really-mounted SecureApp, for every route family the returned inventory
// carries, and that the mount declares exactly the routes that inventory
// describes, so an extra posture-bearing route cannot hide behind the presence
// assertions.
func executeSecureMountPostureRow(t *testing.T, row secureAppMountCase) {
	t.Helper()
	secure, inventory := newSecureMountApp(t, row)

	for _, path := range secureMountPosturePaths(t, inventory, row.Route) {
		if row.ExpectPresent {
			secureMountAssertDeclaredPosture(t, secure, row, path)
			continue
		}
		require.Falsef(t, secureMountDeclares(secure, row.Method, path), "row %q must not mount %s %s", row.ID, row.Method, path)
	}

	require.Equalf(
		t,
		secureMountExpectedRouteCount(inventory, row.FrontChannel),
		len(secure.Routes()),
		"row %q must mount exactly the routes its inventory describes, each with a declared posture",
		row.ID,
	)
}

// secureMountAssertDeclaredPosture pins one route of a present row: the mount
// must declare the route at all, with the posture the row names.
func secureMountAssertDeclaredPosture(t *testing.T, secure *apptheory.SecureApp, row secureAppMountCase, path string) {
	t.Helper()
	expected := secureMountPosture(t, row.ExpectPosture)
	posture, present := secureMountDeclaredPosture(secure, row.Method, path)
	require.Truef(t, present, "row %q must mount %s %s", row.ID, row.Method, path)
	require.Equalf(t, expected, posture, "row %q must declare %q for %s %s", row.ID, expected, row.Method, path)
}

// secureMountPosture maps a row's expect_posture to the closed posture
// vocabulary the SecureApp reports.
func secureMountPosture(t *testing.T, expect string) apptheory.AuthPostureKind {
	t.Helper()
	switch expect {
	case "public":
		return apptheory.AuthPosturePublic
	case "authenticated":
		return apptheory.AuthPostureAuthenticated
	default:
		t.Fatalf("unknown expect_posture %q", expect)
		return ""
	}
}

// secureMountPosturePaths resolves a row's route name to the path every route
// family declares for it, from the inventory the registrar returned rather than
// from a literal. A family-scoped route yields one distinct path per family; a
// stage-global route yields one path that every family names, so it is asserted
// once rather than four times.
func secureMountPosturePaths(t *testing.T, inventory *RouteInventory, route string) []string {
	t.Helper()
	paths := make([]string, 0, len(inventory.Routes))
	seen := make(map[string]struct{}, len(inventory.Routes))
	for family := range inventory.Routes {
		path := secureMountRoutePath(t, inventory, family, route)
		if _, duplicate := seen[path]; duplicate {
			continue
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	if !secureMountGlobalRoute(route) {
		require.Equalf(t, len(inventory.Routes), len(paths), "route %q must resolve one distinct path per route family", route)
	}
	return paths
}

// secureMountGlobalRoute reports whether a row's route name is stage-global
// rather than per route family.
func secureMountGlobalRoute(route string) bool {
	return route == "callback" || route == "root_authorization_server"
}

// secureMountRoutePath resolves a row's route name to the concrete path one
// route family mounts, using the returned inventory rather than a hard-coded
// string.
func secureMountRoutePath(t *testing.T, inventory *RouteInventory, family int, route string) string {
	t.Helper()
	switch route {
	case "transport":
		return inventory.Routes[family].MCPPattern
	case "protected_resource":
		return inventory.Routes[family].ProtectedResourcePattern
	case "discovery_canonical":
		return inventory.Routes[family].DiscoveryCanonicalPattern
	case "discovery_suffix":
		return inventory.Routes[family].DiscoverySuffixPattern
	case "authorize":
		return inventory.Routes[family].AuthorizePattern
	case "token":
		return inventory.Routes[family].TokenPattern
	case "register":
		return inventory.Routes[family].RegisterPattern
	case "callback":
		return inventory.CallbackPattern
	case "root_authorization_server":
		return inventory.RootAuthorizationServerPattern
	default:
		t.Fatalf("unknown secure_app_mount route key %q", route)
		return ""
	}
}

// secureMountDeclaredPosture returns the posture the SecureApp declares for one
// exact route, and whether it declares that route at all.
func secureMountDeclaredPosture(secure *apptheory.SecureApp, method, path string) (apptheory.AuthPostureKind, bool) {
	for _, route := range secure.Routes() {
		if route.Surface == apptheory.SecureRouteHTTP && route.Method == method && route.Path == path {
			return route.Posture, true
		}
	}
	return "", false
}

// secureMountDeclares reports whether the SecureApp declares one exact route.
func secureMountDeclares(secure *apptheory.SecureApp, method, path string) bool {
	_, present := secureMountDeclaredPosture(secure, method, path)
	return present
}

// secureMountExpectedRouteCount is the number of posture-bearing routes the
// facade inventory must install: three transport routes per route family, the
// protected-resource document plus the two discovery documents per family while
// the posture attaches the OAuth surface, the front channel's authorize, token,
// and register routes, the stage-global callback, and the root discovery route.
// It is derived from the returned inventory, so a route the inventory does not
// describe is an over-mount and fails.
func secureMountExpectedRouteCount(inventory *RouteInventory, frontChannel bool) int {
	count := 0
	for _, route := range inventory.Routes {
		count += len(route.MCPMethods)
		if !route.AuthorizationRoutesAttached {
			continue
		}
		count += 3
		if frontChannel {
			count += 3
		}
	}
	if inventory.RootAuthorizationServerAttached {
		count++
	}
	if frontChannel && inventory.CallbackPattern != "" {
		count++
	}
	return count
}

// newSecureMountApp mounts the facade on a fresh SecureApp for one row and
// returns it with the inventory the registrar returned. A front-channel row
// reuses the shared harness, because the front channel needs the provider double
// and the five stores the harness owns; every other row mounts the plain facade
// shape.
func newSecureMountApp(t *testing.T, row secureAppMountCase) (*apptheory.SecureApp, *RouteInventory) {
	t.Helper()
	if row.FrontChannel {
		options := secureMountOptions(row)
		options.secureTopology = true
		harness := newFrontChannelHarnessWith(t, options)
		return harness.secure, harness.inventory
	}
	secure := apptheory.NewSecure(apptheory.SecureOptions{})
	inventory, err := RegisterMCPFacadeSecure(secure, secureMountConfig(row))
	require.NoError(t, err)
	return secure, inventory
}

// secureMountOptions is the harness option set a row that only mounts, and never
// serves, the facade needs: the row's transport posture, issuer mode, and
// optional root route, with a transport validator only the runtime-bearer
// posture requires.
func secureMountOptions(row secureAppMountCase) frontChannelHarnessOptions {
	options := frontChannelHarnessOptions{
		transportPosture:        TransportPosture(row.TransportPosture),
		rootAuthorizationServer: secureMountRootConfig(row),
	}
	if row.IssuerMode != "" {
		options.issuerMode = mcproutes.IssuerMode(row.IssuerMode)
	}
	if options.transportPosture == TransportPostureRuntimeBearer {
		options.requireBearerTokenFor = secureMountTrivialBearerFor
	}
	return options
}

// secureMountTrivialBearerFor satisfies the runtime-bearer posture's
// registration requirement for a row that never serves a request, so the mount
// is a real one while no token is validated.
func secureMountTrivialBearerFor(*oauthprovider.Server) *oauth.RequireBearerTokenOptions {
	return &oauth.RequireBearerTokenOptions{
		Validator: func(*apptheory.Context, string) error { return nil },
	}
}

// secureMountRootConfig is the root discovery configuration a row asks for, or
// nil when it asks for none.
func secureMountRootConfig(row secureAppMountCase) *RootDiscoveryConfig {
	if !row.RootAuthorizationServer {
		return nil
	}
	return validRootDiscoveryConfig()
}

// secureMountConfig is the plain facade config a non-front-channel row
// describes: the shared conformant shape with the row's posture, issuer mode,
// and optional root discovery route.
func secureMountConfig(row secureAppMountCase) FacadeConfig {
	config := validConfig(URLModePublicBaseURL)
	config.TransportPosture = TransportPosture(row.TransportPosture)
	if row.IssuerMode != "" {
		config.IssuerMode = mcproutes.IssuerMode(row.IssuerMode)
	}
	if row.RootAuthorizationServer {
		config.RootAuthorizationServer = validRootDiscoveryConfig()
	}
	if config.TransportPosture == TransportPostureRuntimeBearer {
		config.RequireBearerToken = secureMountTrivialBearerFor(nil)
	}
	return config
}

// ---------------------------------------------------------------------------
// request rows: the really-mounted SecureApp
// ---------------------------------------------------------------------------

// secureMountCounters records what one request row made the mounted app do: the
// MCP handler, the application's own SecurePrincipalResolver and PolicyHook, and
// the application's own non-facade handler.
type secureMountCounters struct {
	mcpHandler int
	resolver   int
	policyHook int
	audit      int
}

// resolve counts every principal resolution and admits exactly the request that
// carries the application's own session header, so an anonymous request is a
// resolved-nil denial rather than a resolver that never ran.
func (c *secureMountCounters) resolve(ctx *apptheory.Context) (*apptheory.SecurePrincipal, error) {
	c.resolver++
	if secureMountHeader(ctx.Request.Headers, secureMountSessionHeader) != secureMountSessionValue {
		return nil, nil
	}
	return &apptheory.SecurePrincipal{
		Identity: secureMountIdentity,
		Scopes:   []string{secureMountScope},
		Kind:     apptheory.PrincipalExternal,
	}, nil
}

// policy counts every policy evaluation and allows, so a denial the gate renders
// is the gate's own rather than the policy's.
func (c *secureMountCounters) policy(*apptheory.Context) (*apptheory.PolicyDecision, error) {
	c.policyHook++
	return nil, nil
}

// auditRoute counts every invocation of the application's own authenticated
// route and answers its marker body.
func (c *secureMountCounters) auditRoute(*apptheory.Context) (*apptheory.Response, error) {
	c.audit++
	return apptheory.Text(200, secureMountAuditBody), nil
}

// executeSecureMountRequestRow drives the really-mounted SecureApp with the
// row's own request and pins the denial or admission class, the challenge it
// advertises, and how far the request got, so a denial that reached the handler
// or a resolver that never ran cannot pass.
func executeSecureMountRequestRow(t *testing.T, row secureAppMountCase) {
	t.Helper()
	harness, counters := newSecureMountRequestApp(t, row)

	response := secureMountPresentRequest(t, harness, row)
	require.Equalf(t, row.ExpectStatus, response.Status, "row %q", row.ID)
	secureMountAssertChallenge(t, row, response)
	secureMountAssertCount(t, "MCP handler", row.ExpectHandlerInvocations, counters.mcpHandler, row.ID)
	secureMountAssertCount(t, "principal resolver", row.ExpectResolverInvocations, counters.resolver, row.ID)
	secureMountAssertCount(t, "policy hook", row.ExpectPolicyHookInvocations, counters.policyHook, row.ID)
	secureMountAssertAuditRoute(t, row, response, counters)
}

// newSecureMountRequestApp mounts the facade on a SecureApp with the counting
// resolver and the policy hook the row names — the allow-policy every request
// row pins, or a denial whose code the row carries — and installs the
// application's own authenticated route beside it, exactly as TMS mounts its
// non-MCP families on the same app.
func newSecureMountRequestApp(t *testing.T, row secureAppMountCase) (*frontChannelHarness, *secureMountCounters) {
	t.Helper()
	counters := &secureMountCounters{}
	options := frontChannelHarnessOptions{
		secureTopology:          true,
		transportPosture:        TransportPosture(row.TransportPosture),
		securePrincipalResolver: counters.resolve,
		policyHook:              counters.policy,
		mcpInvocations:          &counters.mcpHandler,
	}
	if row.PolicyHook == "deny" {
		code := row.PolicyHookCode
		options.policyHook = func(*apptheory.Context) (*apptheory.PolicyDecision, error) {
			counters.policyHook++
			return &apptheory.PolicyDecision{Code: code}, nil
		}
	}
	if options.transportPosture == TransportPostureRuntimeBearer {
		options.requireBearerTokenFor = secureMountBearerTokenFor(t)
	}
	harness := newFrontChannelHarnessWith(t, options)
	harness.secure.Get(secureMountAuditPath, counters.auditRoute, apptheory.Authenticated())
	return harness, counters
}

// secureMountPresentRequest presents the one request a row describes: a
// credential-free or bearer-bearing transport request, the by-design public
// metadata and registration routes, the application's own route with and
// without its own credential, and a path no mount declares.
func secureMountPresentRequest(t *testing.T, harness *frontChannelHarness, row secureAppMountCase) apptheory.Response {
	t.Helper()
	transport := harness.path(mcproutes.EndpointPath.MCPPath)
	switch row.Request {
	case "transport_credential_free":
		return serveSecure(t, harness.secure, "POST", transport, nil, []byte(secureMountMCPBody))
	case "transport_insufficient_scope":
		token := secureMountTransportToken(t, harness, secureMountInsufficientScope)
		return serveSecure(t, harness.secure, "POST", transport, secureMountBearerHeaders(token), []byte(secureMountMCPBody))
	case "transport_valid":
		token := secureMountTransportToken(t, harness, secureMountScope)
		return serveSecure(t, harness.secure, "POST", transport, secureMountBearerHeaders(token), []byte(secureMountMCPBody))
	case "protected_resource_metadata":
		return harness.serve("GET", harness.path(mcproutes.EndpointPath.ProtectedResourcePath), nil, nil)
	case "register":
		return harness.serve("POST", harness.path(mcproutes.EndpointPath.OAuthRegisterPath), nil, secureMountRegisterBody(t))
	case "non_facade_anonymous":
		return harness.serve("GET", secureMountAuditPath, nil, nil)
	case "non_facade_resolved":
		return serveSecure(t, harness.secure, "GET", secureMountAuditPath, secureMountSessionHeaders(), nil)
	case "undeclared_anonymous":
		return harness.serve("GET", secureMountUndeclaredPath, nil, nil)
	default:
		t.Fatalf("row %q carries unknown request %q", row.ID, row.Request)
		return apptheory.Response{}
	}
}

// secureMountAssertChallenge pins the challenge class the row names: the RFC 9728
// discovery challenge, the RFC 6750 insufficient_scope challenge carrying the
// remediation scope, or no challenge at all, so an app-principal denial cannot
// pass by advertising the other class's challenge.
func secureMountAssertChallenge(t *testing.T, row secureAppMountCase, response apptheory.Response) {
	t.Helper()
	challenge := response.Headers["www-authenticate"]
	switch {
	case row.ExpectChallengeResourceMetadata:
		require.Equalf(
			t,
			[]string{oauth.ProtectedResourceWWWAuthenticate(secureMountResourceMetadataURL)},
			challenge,
			"row %q must advertise the RFC 9728 discovery challenge",
			row.ID,
		)
	case row.ExpectChallengeScope != "":
		require.Equalf(
			t,
			[]string{oauth.InsufficientScopeWWWAuthenticate([]string{row.ExpectChallengeScope}, secureMountResourceMetadataURL)},
			challenge,
			"row %q must advertise the RFC 6750 insufficient_scope challenge",
			row.ID,
		)
	default:
		require.Emptyf(t, challenge, "row %q must advertise no challenge", row.ID)
	}
}

// secureMountAssertCount pins one invocation count the row names. A row that
// names none leaves it unpinned: the policy hook runs on every matched route, so
// only the rows that reason about it pin its count.
func secureMountAssertCount(t *testing.T, name string, expected *int, actual int, rowID string) {
	t.Helper()
	if expected == nil {
		return
	}
	require.Equalf(t, *expected, actual, "row %q %s invocations", rowID, name)
}

// secureMountAssertAuditRoute proves the application's own handler ran exactly
// when the request was admitted, and never for a denial.
func secureMountAssertAuditRoute(t *testing.T, row secureAppMountCase, response apptheory.Response, counters *secureMountCounters) {
	t.Helper()
	switch row.Request {
	case "non_facade_anonymous":
		require.Zerof(t, counters.audit, "row %q must not reach the application's own handler", row.ID)
	case "non_facade_resolved":
		require.Equalf(t, 1, counters.audit, "row %q must reach the application's own handler", row.ID)
		require.Equalf(t, secureMountAuditBody, string(response.Body), "row %q must return the non-facade handler's body", row.ID)
	}
}

// secureMountBearerTokenFor builds the transport claims validator over the
// started fake's own key set, so an admitted transport token is genuinely
// upstream-signed and a refused one differs only in the claim the row pins.
func secureMountBearerTokenFor(t *testing.T) func(*oauthprovider.Server) *oauth.RequireBearerTokenOptions {
	t.Helper()
	return func(fake *oauthprovider.Server) *oauth.RequireBearerTokenOptions {
		validator, err := oauth.NewJWKSValidator(oauth.JWKSValidatorOptions{
			Issuer:            frontTestUpstreamIss,
			JWKSURI:           fake.JWKSURL(),
			HTTPClient:        fake.HTTPClient(),
			AllowPrivateHosts: true,
			RequiredAudience:  secureMountRouteAudience,
			RequiredScopes:    secureMountRouteScopes,
		})
		require.NoError(t, err)
		return &oauth.RequireBearerTokenOptions{
			ResourceMetadataURL: secureMountResourceMetadataURL,
			ClaimsValidator:     validator,
			RequiredScopesFunc:  secureMountRouteScopes,
		}
	}
}

// secureMountRouteAudience and secureMountRouteScopes are the route-derived
// audience and scope set the transport validator pins, matching the namespace
// route the rows describe.
func secureMountRouteAudience(*apptheory.Context) (string, error) {
	return secureMountRouteResource, nil
}

func secureMountRouteScopes(*apptheory.Context) ([]string, error) {
	return []string{secureMountScope}, nil
}

// secureMountTransportToken mints the token a transport row presents. The fake's
// own key signs it, so only the pinned claim differs from a token the route
// admits and a refusal cannot come from a bad signature.
func secureMountTransportToken(t *testing.T, harness *frontChannelHarness, scope string) string {
	t.Helper()
	return harness.fake.MintAccessToken(oauthprovider.Claims{
		Issuer:          frontTestUpstreamIss,
		Audience:        secureMountRouteResource,
		AuthorizedParty: frontTestClientID,
		Subject:         "user-1",
		Scope:           scope,
		ExpiresIn:       900,
	})
}

// secureMountRegisterBody is the RFC 7591 registration request a public client
// presents: one https redirect URI.
func secureMountRegisterBody(t *testing.T) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{"redirect_uris": []string{secureMountRedirectURI}})
	require.NoError(t, err)
	return body
}

// serveSecure drives the mounted SecureApp with a request carrying headers,
// which the shared harness's helper deliberately does not express.
func serveSecure(t *testing.T, secure *apptheory.SecureApp, method, path string, headers map[string][]string, body []byte) apptheory.Response {
	t.Helper()
	return secure.Serve(context.Background(), apptheory.Request{Method: method, Path: path, Headers: headers, Body: body})
}

// secureMountBearerHeaders is the transport header set for one bearer token.
func secureMountBearerHeaders(token string) map[string][]string {
	return map[string][]string{secureMountAuthorizationHeader: {"Bearer " + token}}
}

// secureMountSessionHeaders is the application's own credential header set.
func secureMountSessionHeaders() map[string][]string {
	return map[string][]string{secureMountSessionHeader: {secureMountSessionValue}}
}

// secureMountHeader reads the first value of one normalized request header.
func secureMountHeader(headers map[string][]string, name string) string {
	values := headers[name]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

// ---------------------------------------------------------------------------
// inventory_parity rows
// ---------------------------------------------------------------------------

// executeSecureMountInventoryParityRow pins the "same semantics" proof: the
// plain-App registrar and the SecureApp registrar return the same route
// inventory for the same configuration, so a divergence between the two
// registration paths is a named row failure.
func executeSecureMountInventoryParityRow(t *testing.T, row secureAppMountCase) {
	t.Helper()
	plain, secure := secureMountParityInventories(t, row)
	require.NotEmptyf(t, plain.Routes, "row %q must mount a real inventory", row.ID)
	if row.ExpectEqual {
		require.Equalf(t, plain, secure, "row %q: both registrars must return the same inventory", row.ID)
		return
	}
	require.NotEqualf(t, plain, secure, "row %q: the two inventories must differ", row.ID)
}

// secureMountParityInventories mounts the row's configuration on both surfaces.
// A front-channel row mounts the shared harness twice, once plain and once
// secure, because the front channel needs the provider double and the five
// stores; every other row builds one configuration and mounts it on both, so the
// comparison is a proof about one config and not about two equal ones.
func secureMountParityInventories(t *testing.T, row secureAppMountCase) (*RouteInventory, *RouteInventory) {
	t.Helper()
	if row.FrontChannel {
		options := secureMountOptions(row)
		plain := newFrontChannelHarnessWith(t, options)
		options.secureTopology = true
		secured := newFrontChannelHarnessWith(t, options)
		return plain.inventory, secured.inventory
	}
	config := secureMountConfig(row)
	plain, err := RegisterMCPFacade(apptheory.New(apptheory.WithTier(apptheory.TierP0)), config)
	require.NoError(t, err)
	secure, err := RegisterMCPFacadeSecure(apptheory.NewSecure(apptheory.SecureOptions{Tier: apptheory.TierP0}), config)
	require.NoError(t, err)
	return plain, secure
}

// ---------------------------------------------------------------------------
// TMS-topology journey over the SecureApp
// ---------------------------------------------------------------------------

// TestSecureMountServesTheCompleteTmsJourney proves the whole TMS journey over
// the really-mounted SecureApp: the protected-resource document, RFC 7591
// registration, the authorize leg through the upstream callback to a PKCE code
// exchange, brokered refresh rotation, a bearer-enforced MCP call that reaches
// the handler, both transport challenges, and the application's own principal
// still governing its non-facade route.
func TestSecureMountServesTheCompleteTmsJourney(t *testing.T) {
	counters := &secureMountCounters{}
	harness := newSecureMountJourneyHarness(t, counters)
	harness.secure.Get(secureMountAuditPath, counters.auditRoute, apptheory.Authenticated())

	// The RFC 9728 document every client bootstraps from is reachable before any
	// credential and names the route's own resource.
	metadata := harness.serve("GET", harness.path(mcproutes.EndpointPath.ProtectedResourcePath), nil, nil)
	require.Equal(t, 200, metadata.Status)
	var document struct {
		Resource string `json:"resource"`
	}
	require.NoError(t, json.Unmarshal(metadata.Body, &document))
	require.Equal(t, secureMountRouteResource, document.Resource)

	// The registered public client then walks the whole front channel:
	// /authorize to the upstream, the callback back with the facade code, and the
	// PKCE exchange that mints the route handle.
	clientID := secureMountRegisterClient(t, harness)
	exchange := secureMountExchangeCode(t, harness, clientID)
	accessToken := refreshTestAccessToken(t, exchange)
	handle := refreshTestHandle(t, exchange)

	// The brokered refresh rotates the framework handle and returns the
	// upstream-minted access token, never the upstream refresh material it holds.
	refreshed := harness.token(secureMountRefreshForm(clientID, handle))
	require.Equal(t, 200, refreshed.Status)
	require.Equal(t, frontTestRefreshAccessToken, refreshTestAccessToken(t, refreshed))
	require.NotEqual(t, handle, refreshTestHandle(t, refreshed))
	require.NotContains(t, string(refreshed.Body), frontTestRotatedUpstreamRefreshToken)

	secureMountJourneyClearsTransport(t, harness, counters, accessToken)
	secureMountJourneyKeepsTheAppPrincipal(t, harness, counters)
}

// newSecureMountJourneyHarness starts the journey world: the front channel on a
// SecureApp under the runtime-bearer posture with a real JWKS claims validator
// over the fake's key set, the application's counting resolver and allow-policy,
// and an MCP handler that answers 200 and counts its invocations.
func newSecureMountJourneyHarness(t *testing.T, counters *secureMountCounters) *frontChannelHarness {
	t.Helper()
	return newFrontChannelHarnessWith(t, frontChannelHarnessOptions{
		secureTopology:          true,
		transportPosture:        TransportPostureRuntimeBearer,
		requireBearerTokenFor:   secureMountBearerTokenFor(t),
		securePrincipalResolver: counters.resolve,
		policyHook:              counters.policy,
		mcpHandler: func(*apptheory.Context) (*apptheory.Response, error) {
			return apptheory.Text(200, secureMountMCPHandlerBody), nil
		},
		mcpInvocations: &counters.mcpHandler,
	})
}

// secureMountJourneyClearsTransport pins the three transport outcomes on the
// mounted SecureApp: an upstream-minted access token reaches the handler, a
// credential-free request is the RFC 9728 challenge, and an insufficient-scope
// token is the RFC 6750 challenge naming the remediation scope. Only the first
// reaches the handler.
func secureMountJourneyClearsTransport(t *testing.T, harness *frontChannelHarness, counters *secureMountCounters, accessToken string) {
	t.Helper()
	path := harness.path(mcproutes.EndpointPath.MCPPath)

	admitted := serveSecure(t, harness.secure, "POST", path, secureMountBearerHeaders(accessToken), []byte(secureMountMCPBody))
	require.Equal(t, 200, admitted.Status)
	require.Equal(t, secureMountMCPHandlerBody, string(admitted.Body))
	require.Equal(t, 1, counters.mcpHandler)

	credentialFree := serveSecure(t, harness.secure, "POST", path, nil, []byte(secureMountMCPBody))
	require.Equal(t, 401, credentialFree.Status)
	require.Equal(
		t,
		[]string{oauth.ProtectedResourceWWWAuthenticate(secureMountResourceMetadataURL)},
		credentialFree.Headers["www-authenticate"],
	)

	insufficient := serveSecure(t, harness.secure, "POST", path, secureMountBearerHeaders(secureMountTransportToken(t, harness, secureMountInsufficientScope)), []byte(secureMountMCPBody))
	require.Equal(t, 403, insufficient.Status)
	require.Equal(
		t,
		[]string{oauth.InsufficientScopeWWWAuthenticate([]string{secureMountScope}, secureMountResourceMetadataURL)},
		insufficient.Headers["www-authenticate"],
	)

	require.Equal(t, 1, counters.mcpHandler, "only the admitted request may reach the MCP handler")
}

// secureMountJourneyKeepsTheAppPrincipal pins the closed-by-default seam beside
// the facade: the application's own route still demands a principal the
// application resolves, so an anonymous request is refused with the resolver
// having run, and a resolved one reaches the application's handler.
func secureMountJourneyKeepsTheAppPrincipal(t *testing.T, harness *frontChannelHarness, counters *secureMountCounters) {
	t.Helper()
	before := counters.resolver

	anonymous := harness.serve("GET", secureMountAuditPath, nil, nil)
	require.Equal(t, 401, anonymous.Status)
	require.Equal(t, before+1, counters.resolver)
	require.Zero(t, counters.audit, "an anonymous denial must not reach the application's handler")

	resolved := serveSecure(t, harness.secure, "GET", secureMountAuditPath, secureMountSessionHeaders(), nil)
	require.Equal(t, 200, resolved.Status)
	require.Equal(t, secureMountAuditBody, string(resolved.Body))
	require.Equal(t, before+2, counters.resolver)
	require.Equal(t, 1, counters.audit)

	// A route the application never declares stays undeliverable after the facade
	// mounts, and the refusal is not even a principal decision.
	undeclared := harness.serve("GET", secureMountUndeclaredPath, nil, nil)
	require.Equal(t, 404, undeclared.Status)
	require.Equal(t, before+2, counters.resolver, "an undeclared route must resolve no principal")
}

// secureMountRegisterClient registers one public client through the real
// POST .../register handler and returns the id it minted.
func secureMountRegisterClient(t *testing.T, harness *frontChannelHarness) string {
	t.Helper()
	response := harness.serve("POST", harness.path(mcproutes.EndpointPath.OAuthRegisterPath), nil, secureMountRegisterBody(t))
	require.Equal(t, 201, response.Status)
	var payload struct {
		ClientID string `json:"client_id"`
	}
	require.NoError(t, json.Unmarshal(response.Body, &payload))
	require.NotEmpty(t, payload.ClientID)
	return payload.ClientID
}

// secureMountExchangeCode completes /authorize, the upstream callback, and the
// PKCE code exchange for one registered client and returns the token response.
// It also pins the two redirects the journey turns on: the authorize leg hands
// the browser to the upstream with the facade's own material (the upstream is
// given the facade's callback, never the client's redirect URI), and the
// callback returns the browser to the client's own registered redirect URI with
// the client's state and a facade code that is not the upstream code.
func secureMountExchangeCode(t *testing.T, harness *frontChannelHarness, clientID string) apptheory.Response {
	t.Helper()
	authorize := harness.authorize(func(query url.Values) { query.Set("client_id", clientID) })
	require.Equal(t, 302, authorize.Status)
	upstream := locationQuery(t, authorize)
	require.Equal(t, frontTestClientID, upstream.Get("client_id"))
	require.Equal(t, frontTestBaseURL+"/_oauth/mcp/callback", upstream.Get("redirect_uri"))
	require.Equal(t, secureMountRouteResource, upstream.Get("resource"))
	require.NotEqual(t, frontTestClientState, upstream.Get("state"))

	callback := harness.serve("GET", mcproutes.DefaultCallbackPath, url.Values{
		"code":  {frontTestUpstreamCode},
		"state": {upstream.Get("state")},
		"iss":   {frontTestUpstreamIss},
	}, nil)
	require.Equal(t, 302, callback.Status)
	require.Truef(
		t,
		strings.HasPrefix(locationOf(callback), secureMountRedirectURI),
		"the callback must return the browser to the client's redirect URI, got %q",
		locationOf(callback),
	)
	delivered := locationQuery(t, callback)
	require.Equal(t, frontTestClientState, delivered.Get("state"))
	code := delivered.Get("code")
	require.NotEmpty(t, code)
	require.NotEqual(t, frontTestUpstreamCode, code)

	exchange := harness.token(url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {secureMountVerifier},
		"redirect_uri":  {secureMountRedirectURI},
		"client_id":     {clientID},
	})
	require.Equal(t, 200, exchange.Status)
	return exchange
}

// secureMountRefreshForm is the brokered refresh grant for one handle, presented
// by the client that holds it.
func secureMountRefreshForm(clientID, handle string) url.Values {
	return url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {handle},
		"client_id":     {clientID},
	}
}

// ---------------------------------------------------------------------------
// Fail-closed registration
// ---------------------------------------------------------------------------

// TestSecureMountFailsClosed pins the three refusals the SecureApp seam owes its
// callers: a nil app is an error, a configuration the facade rejects installs
// nothing at all, and a second mount of the same configuration is an error that
// leaves the first mount intact rather than a panic or a half-installed surface.
func TestSecureMountFailsClosed(t *testing.T) {
	t.Run("nil secure app", func(t *testing.T) {
		inventory, err := RegisterMCPFacadeSecure(nil, validConfig(URLModePublicBaseURL))
		require.Nil(t, inventory)
		require.ErrorContains(t, err, "secure app is required")
	})

	t.Run("rejected configuration installs nothing", func(t *testing.T) {
		secure := apptheory.NewSecure(apptheory.SecureOptions{})
		config := validConfig(URLModePublicBaseURL)
		config.TransportPosture = TransportPostureRuntimeBearer

		inventory, err := RegisterMCPFacadeSecure(secure, config)
		require.Nil(t, inventory)
		require.ErrorContains(t, err, "TransportPosture runtime-bearer requires RequireBearerToken")
		require.Empty(t, secure.Routes())
	})

	t.Run("a route that declares no posture never reaches the caller's app", func(t *testing.T) {
		registers := []routeRegistration{{
			method:  "POST",
			pattern: "/acme/mcp",
			handler: func(*apptheory.Context) (*apptheory.Response, error) { return apptheory.Text(204, ""), nil },
		}}
		secure := apptheory.NewSecure(apptheory.SecureOptions{})
		require.Error(t, preflightSecureRegistrations(secure, registers))
		require.Empty(t, secure.Routes())

		require.Error(t, registerSecureRoutes(secure, registers))
		require.Empty(t, secure.Routes())
	})

	t.Run("duplicate mount is an error and leaves the first mount intact", func(t *testing.T) {
		secure := apptheory.NewSecure(apptheory.SecureOptions{})
		config := validConfig(URLModePublicBaseURL)
		_, err := RegisterMCPFacadeSecure(secure, config)
		require.NoError(t, err)
		installed := secure.Routes()
		require.NotEmpty(t, installed)

		inventory, err := RegisterMCPFacadeSecure(secure, config)
		require.Nil(t, inventory)
		require.ErrorContains(t, err, "already registered on the secure app")
		require.Equal(t, installed, secure.Routes())
	})
}

// TestSecureMountRejectsANonFirstCollisionWithoutMountingAnything pins the
// all-or-nothing guarantee of the SecureApp registrar: when the application
// already owns the method+path of a LATER facade registration, the mount is
// refused before the first route reaches the app, so the app's route table is
// exactly what it was. A registrar that mounted as it went would leave the
// earlier facade routes behind, which is what the earlier
// "duplicate mount" row above cannot see because its collision is the first
// entry of the plan.
func TestSecureMountRejectsANonFirstCollisionWithoutMountingAnything(t *testing.T) {
	t.Parallel()
	config := validConfig(URLModePublicBaseURL)
	normalized, err := normalizeConfig(config)
	require.NoError(t, err)
	inventory, err := buildInventory(normalized)
	require.NoError(t, err)
	registrations, err := buildRegistrations(normalized, inventory)
	require.NoError(t, err)
	require.Greater(t, len(registrations), 4)

	// The application owns the fourth planned route, not the first, so a
	// mount-as-it-goes registrar would already have installed the first three.
	collision := registrations[3]
	require.Equal(t, "GET", collision.method)

	secure := apptheory.NewSecure(apptheory.SecureOptions{})
	secure.Handle(collision.method, collision.pattern, func(*apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(204, ""), nil
	}, apptheory.Public())
	declared := secure.Routes()
	require.Len(t, declared, 1)

	routeInventory, err := RegisterMCPFacadeSecure(secure, config)
	require.Nil(t, routeInventory)
	require.ErrorContains(t, err, "already registered on the secure app")
	require.Equal(t, declared, secure.Routes())
}

// TestSecureMountRejectsACrossSurfaceCollisionWithoutMountingAnything pins the
// all-or-nothing guarantee against a collision with a route the caller's app
// declares on a DIFFERENT surface than the facade mounts on. SecureApp.
// AppSyncField registers GET /<field> for Query and Subscription and POST
// /<field> for Mutation on the SAME shared router the facade mounts on, and the
// router's duplicate check is surface-agnostic, so an AppSync field whose path is
// a facade route's path occupies that route's key. A preflight that compared only
// the HTTP surface would miss it, let the mount start, and leave the facade
// routes that preceded the collision mounted.
func TestSecureMountRejectsACrossSurfaceCollisionWithoutMountingAnything(t *testing.T) {
	t.Parallel()
	config := validConfig(URLModePublicBaseURL)
	normalized, err := normalizeConfig(config)
	require.NoError(t, err)
	inventory, err := buildInventory(normalized)
	require.NoError(t, err)
	registrations, err := buildRegistrations(normalized, inventory)
	require.NoError(t, err)
	require.Greater(t, len(registrations), 4)

	// The collision is the fourth planned route, so a mount-as-it-goes registrar
	// would already have installed the first three.
	collision := registrations[3]
	require.Equal(t, "GET", collision.method)
	require.True(t, strings.HasPrefix(collision.pattern, "/"), "collision pattern %q", collision.pattern)
	// A Query field is a GET on the shared router at "/"+field, so the field
	// name that collides with the planned path is that path without its slash.
	field := strings.TrimPrefix(collision.pattern, "/")

	secure := apptheory.NewSecure(apptheory.SecureOptions{})
	secure.AppSyncField("Query", field, func(*apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(204, ""), nil
	}, apptheory.Public())
	declared := secure.Routes()
	require.Len(t, declared, 1)
	require.Equal(t, apptheory.SecureRouteAppSync, declared[0].Surface)
	collisionKey := declared[0].Method + " " + declared[0].Path

	routeInventory, err := RegisterMCPFacadeSecure(secure, config)
	require.Nil(t, routeInventory)
	require.Equal(t, declared, secure.Routes())
	require.ErrorContains(t, err, "already registered on the secure app")
	require.ErrorContains(t, err, collisionKey)
}

// TestSecureRoutedMetadataAdvertisesRFC9207IssParameterSupported proves the
// SecureApp registrar serves the same RFC 9207 claim as the plain-App registrar
// when the framework owns the front channel: every routed authorization-server
// route the SecureApp mounts advertises `iss` support.
func TestSecureRoutedMetadataAdvertisesRFC9207IssParameterSupported(t *testing.T) {
	t.Parallel()
	row := secureAppMountCase{
		ID:               "rfc9207-iss-parameter",
		Group:            secureAppMountGroup,
		Scenario:         "inventory_parity",
		TransportPosture: string(TransportPostureIAM),
		IssuerMode:       string(mcproutes.IssuerModeRoute),
		// The row owns the front channel, the only posture that advertises `iss`.
		FrontChannel: true,
		ExpectEqual:  true,
	}
	secure, inventory := newSecureMountApp(t, row)
	for _, route := range inventory.Routes {
		for _, path := range []string{route.DiscoveryCanonicalPattern, route.DiscoverySuffixPattern} {
			response := serveSecure(t, secure, "GET", path, nil, nil)
			require.Equalf(t, 200, response.Status, "%s", path)
			var document map[string]any
			require.NoError(t, json.Unmarshal(response.Body, &document))
			require.Equalf(t, true, document["authorization_response_iss_parameter_supported"], "%s", path)
		}
	}
}
