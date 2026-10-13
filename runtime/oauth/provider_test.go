package oauth_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	oauthruntime "github.com/theory-cloud/apptheory/v6/runtime/oauth"
	"github.com/theory-cloud/apptheory/v6/testkit/oauthprovider"
)

// providerConformanceFixture is the shared provider conformance table. From
// runtime/oauth/ the repository root is two levels up.
const providerConformanceFixture = "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-provider-conformance.v1.json"

// providerFixtureCaseCount is the case count the shared fixture must carry.
const providerFixtureCaseCount = 22

// defaultFetchTimeout bounds one upstream call in the conformance harness,
// unless the case states its own fetch_timeout_seconds.
const defaultFetchTimeout = 5 * time.Second

// theAdapterImplementsTheSPI pins that the Autheory adapter satisfies the
// provider SPI by interface, not by convention.
var _ oauthruntime.Provider = (*oauthruntime.AutheoryProvider)(nil)

// provider operation names used to dispatch a fixture case.
const (
	operationDiscovery          = "discovery"
	operationAuthorizationURL   = "authorization_url"
	operationExchangeCode       = "exchange_code"
	operationRefresh            = "refresh"
	operationValidateToken      = "validate_access_token"
	operationSecondAdapter      = "second_adapter"
	operationOutcomeOK          = "ok"
	operationOutcomeError       = "error"
	conformanceFacadeClientID   = "facade-client"
	conformanceCallbackURL      = "https://mcp.example.test/_oauth/mcp/callback"
	conformanceResource         = "https://mcp.example.test/mcp"
	conformanceCodeVerifier     = "facade-verifier"
	conformanceUpstreamCode     = "upstream-code"
	conformanceRefreshMaterial  = "upstream-refresh-token"
	conformanceGrantTypeCode    = "authorization_code"
	conformanceGrantTypeRefresh = "refresh_token"
	secondAdapterIssuer         = "https://second-provider.example.test"
)

type providerConformanceDocument struct {
	Cases []providerCase `json:"cases"`
}

type providerCase struct {
	ID                  string               `json:"id"`
	Operation           string               `json:"operation"`
	Upstream            providerUpstream     `json:"upstream"`
	FetchTimeoutSeconds int                  `json:"fetch_timeout_seconds"`
	Request             providerRequest      `json:"request"`
	Token               oauthprovider.Claims `json:"token"`
	Expectations        providerExpectations `json:"expectations"`
	Expect              providerExpectation  `json:"expect"`
}

type providerUpstream struct {
	Issuer            string         `json:"issuer"`
	DiscoveryIssuer   string         `json:"discovery_issuer"`
	RedirectTo        string         `json:"redirect_to"`
	TokenStatus       int            `json:"token_status"`
	TokenBody         map[string]any `json:"token_body"`
	TokenBodyBytes    int            `json:"token_body_bytes"`
	TokenBodyPadding  int            `json:"token_body_padding_bytes"`
	TokenDelaySeconds int            `json:"token_delay_seconds"`
}

// providerRequest covers the request object of every operation the fixture
// uses; only the fields of the current operation are populated.
type providerRequest struct {
	UpstreamClientID    string            `json:"upstream_client_id"`
	CallbackURL         string            `json:"callback_url"`
	CodeChallenge       string            `json:"code_challenge"`
	CodeChallengeMethod string            `json:"code_challenge_method"`
	State               string            `json:"state"`
	Resource            string            `json:"resource"`
	Scopes              []string          `json:"scopes"`
	Hints               map[string]string `json:"hints"`
	Code                string            `json:"code"`
	CodeVerifier        string            `json:"code_verifier"`
	RefreshMaterial     string            `json:"refresh_material"`
}

type providerExpectations struct {
	ExpectedIssuer           string   `json:"expected_issuer"`
	ExpectedAudience         string   `json:"expected_audience"`
	RequiredScopes           []string `json:"required_scopes"`
	AllowedAuthorizedParties []string `json:"allowed_authorized_parties"`
}

type providerExpectation struct {
	Outcome                                    string            `json:"outcome"`
	ErrorClass                                 string            `json:"error_class"`
	Issuer                                     string            `json:"issuer"`
	CodeChallengeMethodsSupported              []string          `json:"code_challenge_methods_supported"`
	AuthorizationResponseIssParameterSupported *bool             `json:"authorization_response_iss_parameter_supported"`
	ResourceParameterSupported                 *bool             `json:"resource_parameter_supported"`
	Query                                      map[string]string `json:"query"`
	AccessToken                                *string           `json:"access_token"`
	RefreshToken                               *string           `json:"refresh_token"`
	IDToken                                    *string           `json:"id_token"`
	TokenType                                  *string           `json:"token_type"`
	ExpiresIn                                  *int              `json:"expires_in"`
	UpstreamClientID                           string            `json:"upstream_client_id"`
	Subject                                    string            `json:"subject"`
	Audience                                   string            `json:"audience"`
	Scopes                                     []string          `json:"scopes"`
	AuthorizedParty                            string            `json:"authorized_party"`
	MessageExcludes                            []string          `json:"message_excludes"`
}

func loadProviderCases(t *testing.T) []providerCase {
	t.Helper()
	raw, err := os.ReadFile(providerConformanceFixture)
	if err != nil {
		t.Fatalf("read provider conformance fixture: %v", err)
	}
	var document providerConformanceDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("parse provider conformance fixture: %v", err)
	}
	return document.Cases
}

// TestProviderConformance runs the shared provider conformance table against
// the Autheory adapter over a real local fake upstream with a real RSA key, plus
// the second in-test adapter that proves the SPI is provider-neutral. Every case
// runs; the count assertion proves the whole table executed.
func TestProviderConformance(t *testing.T) {
	cases := loadProviderCases(t)
	if len(cases) != providerFixtureCaseCount {
		t.Fatalf("provider conformance fixture case count = %d, want %d", len(cases), providerFixtureCaseCount)
	}

	ran := 0
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.ID, func(t *testing.T) {
			ran++
			runProviderCase(t, testCase)
		})
	}
	if ran != providerFixtureCaseCount {
		t.Fatalf("provider conformance ran %d cases, want %d", ran, providerFixtureCaseCount)
	}
	t.Logf("provider conformance: ran %d of %d fixture cases", ran, len(cases))
}

func runProviderCase(t *testing.T, testCase providerCase) {
	t.Helper()
	if testCase.Operation == operationSecondAdapter {
		runSecondAdapterCase(t, testCase)
		return
	}
	runAutheoryCase(t, testCase)
}

func runAutheoryCase(t *testing.T, testCase providerCase) {
	t.Helper()
	server := oauthprovider.NewServer(t, oauthprovider.Options{
		Issuer:                testCase.Upstream.Issuer,
		DiscoveryIssuer:       testCase.Upstream.DiscoveryIssuer,
		RedirectTo:            testCase.Upstream.RedirectTo,
		TokenStatus:           testCase.Upstream.TokenStatus,
		TokenBody:             testCase.Upstream.TokenBody,
		TokenBodyBytes:        testCase.Upstream.TokenBodyBytes,
		TokenBodyPaddingBytes: testCase.Upstream.TokenBodyPadding,
		TokenDelay:            time.Duration(testCase.Upstream.TokenDelaySeconds) * time.Second,
	})
	defer server.Close()

	provider, err := oauthruntime.NewAutheoryProvider(oauthruntime.AutheoryProviderOptions{
		Issuer:            testCase.Upstream.Issuer,
		ClientID:          conformanceFacadeClientID,
		HTTPClient:        server.HTTPClient(),
		AllowPrivateHosts: true,
		FetchTimeout:      fetchTimeout(testCase),
	})
	if err != nil {
		assertProviderErrorClass(t, testCase, err)
		return
	}

	switch testCase.Operation {
	case operationDiscovery:
		assertDiscovery(t, testCase, provider)
	case operationAuthorizationURL:
		assertAuthorizationURL(t, testCase, provider)
	case operationExchangeCode:
		assertExchangeCode(t, testCase, provider, server)
	case operationRefresh:
		assertRefresh(t, testCase, provider, server)
	case operationValidateToken:
		assertValidateAccessToken(t, testCase, provider, server)
	default:
		t.Fatalf("case %s: unsupported operation %q", testCase.ID, testCase.Operation)
	}
}

func fetchTimeout(testCase providerCase) time.Duration {
	if testCase.FetchTimeoutSeconds > 0 {
		return time.Duration(testCase.FetchTimeoutSeconds) * time.Second
	}
	return defaultFetchTimeout
}

func expectsError(testCase providerCase) bool {
	return testCase.Expect.Outcome == operationOutcomeError
}

func assertDiscovery(t *testing.T, testCase providerCase, provider oauthruntime.Provider) {
	t.Helper()
	metadata, err := provider.Discovery(context.Background())
	if expectsError(testCase) {
		assertProviderErrorClass(t, testCase, err)
		return
	}
	if err != nil {
		t.Fatalf("case %s: discovery: %v", testCase.ID, err)
	}
	if metadata.Issuer != testCase.Expect.Issuer {
		t.Errorf("case %s: issuer = %q, want %q", testCase.ID, metadata.Issuer, testCase.Expect.Issuer)
	}
	if !slices.Equal(metadata.CodeChallengeMethodsSupported, testCase.Expect.CodeChallengeMethodsSupported) {
		t.Errorf("case %s: code_challenge_methods_supported = %v, want %v",
			testCase.ID, metadata.CodeChallengeMethodsSupported, testCase.Expect.CodeChallengeMethodsSupported)
	}
	assertBoolExpectation(t, testCase, "authorization_response_iss_parameter_supported",
		testCase.Expect.AuthorizationResponseIssParameterSupported, metadata.AuthorizationResponseIssParameterSupported)
	assertBoolExpectation(t, testCase, "resource_parameter_supported",
		testCase.Expect.ResourceParameterSupported, metadata.ResourceParameterSupported)
}

func assertBoolExpectation(t *testing.T, testCase providerCase, name string, expected *bool, actual bool) {
	t.Helper()
	if expected != nil && actual != *expected {
		t.Errorf("case %s: %s = %t, want %t", testCase.ID, name, actual, *expected)
	}
}

func assertAuthorizationURL(t *testing.T, testCase providerCase, provider oauthruntime.Provider) {
	t.Helper()
	raw, err := provider.AuthorizationURL(oauthruntime.AuthorizationRequest{
		UpstreamClientID:    testCase.Request.UpstreamClientID,
		CallbackURL:         testCase.Request.CallbackURL,
		CodeChallenge:       testCase.Request.CodeChallenge,
		CodeChallengeMethod: testCase.Request.CodeChallengeMethod,
		State:               testCase.Request.State,
		Resource:            testCase.Request.Resource,
		Scopes:              testCase.Request.Scopes,
		Hints:               testCase.Request.Hints,
	})
	if expectsError(testCase) {
		assertProviderErrorClass(t, testCase, err)
		return
	}
	if err != nil {
		t.Fatalf("case %s: authorization url: %v", testCase.ID, err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("case %s: authorization url %q is not a URL: %v", testCase.ID, raw, err)
	}
	if origin := parsed.Scheme + "://" + parsed.Host; origin != issuerOrigin(t, testCase.Upstream.Issuer) {
		t.Errorf("case %s: authorization url origin = %q, want %q", testCase.ID, origin, testCase.Upstream.Issuer)
	}
	query := parsed.Query()
	for name, expected := range testCase.Expect.Query {
		if actual := query.Get(name); actual != expected {
			t.Errorf("case %s: query %s = %q, want %q", testCase.ID, name, actual, expected)
		}
	}
}

func issuerOrigin(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("issuer %q is not a URL: %v", raw, err)
	}
	return parsed.Scheme + "://" + parsed.Host
}

func assertExchangeCode(t *testing.T, testCase providerCase, provider oauthruntime.Provider, server *oauthprovider.Server) {
	t.Helper()
	tokenSet, err := provider.ExchangeCode(context.Background(), oauthruntime.CodeExchangeRequest{
		Code:             testCase.Request.Code,
		UpstreamClientID: testCase.Request.UpstreamClientID,
		CallbackURL:      testCase.Request.CallbackURL,
		CodeVerifier:     testCase.Request.CodeVerifier,
	})
	if expectsError(testCase) {
		assertProviderErrorClass(t, testCase, err)
		return
	}
	if err != nil {
		t.Fatalf("case %s: exchange code: %v", testCase.ID, err)
	}
	assertTokenSet(t, testCase, tokenSet)

	form := server.LastTokenRequest()
	assertFormValue(t, testCase, form, "grant_type", conformanceGrantTypeCode)
	assertFormValue(t, testCase, form, "code", testCase.Request.Code)
	assertFormValue(t, testCase, form, "redirect_uri", testCase.Request.CallbackURL)
	assertFormValue(t, testCase, form, "client_id", testCase.Request.UpstreamClientID)
	assertFormValue(t, testCase, form, "code_verifier", testCase.Request.CodeVerifier)
}

func assertRefresh(t *testing.T, testCase providerCase, provider oauthruntime.Provider, server *oauthprovider.Server) {
	t.Helper()
	tokenSet, err := provider.Refresh(context.Background(), oauthruntime.RefreshRequest{
		RefreshMaterial:  testCase.Request.RefreshMaterial,
		UpstreamClientID: testCase.Request.UpstreamClientID,
	})
	if expectsError(testCase) {
		assertProviderErrorClass(t, testCase, err)
		return
	}
	if err != nil {
		t.Fatalf("case %s: refresh: %v", testCase.ID, err)
	}
	assertTokenSet(t, testCase, tokenSet)

	form := server.LastTokenRequest()
	assertFormValue(t, testCase, form, "grant_type", conformanceGrantTypeRefresh)
	assertFormValue(t, testCase, form, "refresh_token", testCase.Request.RefreshMaterial)
	assertFormValue(t, testCase, form, "client_id", testCase.Expect.UpstreamClientID)
}

// assertTokenSet asserts every token-set field the fixture's expect block
// states; a field the row does not state is not asserted.
func assertTokenSet(t *testing.T, testCase providerCase, tokenSet *oauthruntime.TokenSet) {
	t.Helper()
	if tokenSet == nil {
		t.Fatalf("case %s: no token set returned", testCase.ID)
	}
	assertOptionalString(t, testCase, "access_token", testCase.Expect.AccessToken, tokenSet.AccessToken)
	assertOptionalString(t, testCase, "refresh_token", testCase.Expect.RefreshToken, tokenSet.RefreshToken)
	assertOptionalString(t, testCase, "id_token", testCase.Expect.IDToken, tokenSet.IDToken)
	assertOptionalString(t, testCase, "token_type", testCase.Expect.TokenType, tokenSet.TokenType)
	if testCase.Expect.ExpiresIn != nil && tokenSet.ExpiresIn != *testCase.Expect.ExpiresIn {
		t.Errorf("case %s: expires_in = %d, want %d", testCase.ID, tokenSet.ExpiresIn, *testCase.Expect.ExpiresIn)
	}
}

func assertOptionalString(t *testing.T, testCase providerCase, name string, expected *string, actual string) {
	t.Helper()
	if expected != nil && actual != *expected {
		t.Errorf("case %s: %s = %q, want %q", testCase.ID, name, actual, *expected)
	}
}

func assertFormValue(t *testing.T, testCase providerCase, form url.Values, name, expected string) {
	t.Helper()
	if actual := form.Get(name); actual != expected {
		t.Errorf("case %s: upstream %s = %q, want %q", testCase.ID, name, actual, expected)
	}
}

func assertValidateAccessToken(
	t *testing.T,
	testCase providerCase,
	provider oauthruntime.Provider,
	server *oauthprovider.Server,
) {
	t.Helper()
	token := server.MintAccessToken(testCase.Token)
	claims, err := provider.ValidateAccessToken(context.Background(), token, oauthruntime.TokenExpectations{
		ExpectedIssuer:           testCase.Expectations.ExpectedIssuer,
		ExpectedAudience:         testCase.Expectations.ExpectedAudience,
		RequiredScopes:           testCase.Expectations.RequiredScopes,
		AllowedAuthorizedParties: testCase.Expectations.AllowedAuthorizedParties,
	})
	if expectsError(testCase) {
		assertProviderErrorClass(t, testCase, err)
		return
	}
	if err != nil {
		t.Fatalf("case %s: validate access token: %v", testCase.ID, err)
	}
	if claims.Subject != testCase.Expect.Subject {
		t.Errorf("case %s: subject = %q, want %q", testCase.ID, claims.Subject, testCase.Expect.Subject)
	}
	if claims.Audience != testCase.Expect.Audience {
		t.Errorf("case %s: audience = %q, want %q", testCase.ID, claims.Audience, testCase.Expect.Audience)
	}
	if !slices.Equal(claims.Scopes, testCase.Expect.Scopes) {
		t.Errorf("case %s: scopes = %v, want %v", testCase.ID, claims.Scopes, testCase.Expect.Scopes)
	}
	if claims.AuthorizedParty != testCase.Expect.AuthorizedParty {
		t.Errorf("case %s: authorized_party = %q, want %q", testCase.ID, claims.AuthorizedParty, testCase.Expect.AuthorizedParty)
	}
	if claims.ExpiresAt.IsZero() {
		t.Errorf("case %s: expires_at is zero", testCase.ID)
	}
}

// assertProviderErrorClass asserts the typed error class the fixture states and
// that no excluded marker (upstream material) leaked into the error string.
func assertProviderErrorClass(t *testing.T, testCase providerCase, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("case %s: expected error class %q, got success", testCase.ID, testCase.Expect.ErrorClass)
	}
	providerErr, ok := oauthruntime.AsProviderError(err)
	if !ok {
		t.Fatalf("case %s: error %v is not a *ProviderError", testCase.ID, err)
	}
	if string(providerErr.Class) != testCase.Expect.ErrorClass {
		t.Errorf("case %s: error class = %q, want %q", testCase.ID, providerErr.Class, testCase.Expect.ErrorClass)
	}
	for _, marker := range testCase.Expect.MessageExcludes {
		if strings.Contains(err.Error(), marker) {
			t.Errorf("case %s: error message leaked %q: %v", testCase.ID, marker, err)
		}
	}
}

// secondProvider is the tiny in-test adapter that proves the SPI is
// provider-neutral: nothing in the interface is Autheory-specific.
type secondProvider struct {
	issuer string
}

var _ oauthruntime.Provider = secondProvider{}

func (p secondProvider) Discovery(context.Context) (*oauthruntime.ProviderMetadata, error) {
	return &oauthruntime.ProviderMetadata{
		Issuer:                        p.issuer,
		AuthorizationEndpoint:         p.issuer + "/oauth/authorize",
		TokenEndpoint:                 p.issuer + "/token",
		JWKSURI:                       p.issuer + "/.well-known/jwks.json",
		CodeChallengeMethodsSupported: []string{"S256"},
		AuthorizationResponseIssParameterSupported: true,
		ResourceParameterSupported:                 true,
	}, nil
}

func (p secondProvider) AuthorizationURL(req oauthruntime.AuthorizationRequest) (string, error) {
	return p.issuer + "/oauth/authorize?client_id=" + url.QueryEscape(req.UpstreamClientID), nil
}

func (p secondProvider) ExchangeCode(
	context.Context,
	oauthruntime.CodeExchangeRequest,
) (*oauthruntime.TokenSet, error) {
	return &oauthruntime.TokenSet{AccessToken: "second-access-token", TokenType: "Bearer", ExpiresIn: 900}, nil
}

func (p secondProvider) Refresh(context.Context, oauthruntime.RefreshRequest) (*oauthruntime.TokenSet, error) {
	return &oauthruntime.TokenSet{AccessToken: "second-rotated-token", TokenType: "Bearer", ExpiresIn: 900}, nil
}

func (p secondProvider) ValidateAccessToken(
	context.Context,
	string,
	oauthruntime.TokenExpectations,
) (*oauthruntime.TokenClaims, error) {
	return &oauthruntime.TokenClaims{Subject: "second-user", Audience: p.issuer + "/mcp"}, nil
}

func runSecondAdapterCase(t *testing.T, testCase providerCase) {
	t.Helper()
	adapter := secondProvider{issuer: secondAdapterIssuer}

	metadata, err := adapter.Discovery(context.Background())
	if err != nil {
		t.Fatalf("case %s: discovery: %v", testCase.ID, err)
	}
	if metadata.Issuer != testCase.Expect.Issuer {
		t.Errorf("case %s: issuer = %q, want %q", testCase.ID, metadata.Issuer, testCase.Expect.Issuer)
	}

	// The rest of the SPI must answer for this adapter too: the interface carries
	// no Autheory-only requirement.
	if _, err := adapter.AuthorizationURL(oauthruntime.AuthorizationRequest{
		UpstreamClientID:    conformanceFacadeClientID,
		CallbackURL:         conformanceCallbackURL,
		CodeChallenge:       "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		CodeChallengeMethod: "S256",
		State:               "second-state",
		Resource:            conformanceResource,
	}); err != nil {
		t.Errorf("case %s: authorization url: %v", testCase.ID, err)
	}
	if _, err := adapter.ExchangeCode(context.Background(), oauthruntime.CodeExchangeRequest{
		Code:             conformanceUpstreamCode,
		UpstreamClientID: conformanceFacadeClientID,
		CallbackURL:      conformanceCallbackURL,
		CodeVerifier:     conformanceCodeVerifier,
	}); err != nil {
		t.Errorf("case %s: exchange code: %v", testCase.ID, err)
	}
	if _, err := adapter.Refresh(context.Background(), oauthruntime.RefreshRequest{
		RefreshMaterial:  conformanceRefreshMaterial,
		UpstreamClientID: conformanceFacadeClientID,
	}); err != nil {
		t.Errorf("case %s: refresh: %v", testCase.ID, err)
	}
	if _, err := adapter.ValidateAccessToken(context.Background(), "second-token", oauthruntime.TokenExpectations{
		ExpectedIssuer:   secondAdapterIssuer,
		ExpectedAudience: conformanceResource,
	}); err != nil {
		t.Errorf("case %s: validate access token: %v", testCase.ID, err)
	}
}

// newTestProvider builds an Autheory adapter over a fake upstream, pinned to the
// adapter's own client id.
func newTestProvider(t *testing.T, server *oauthprovider.Server, fetchTimeout time.Duration) oauthruntime.Provider {
	t.Helper()
	provider, err := oauthruntime.NewAutheoryProvider(oauthruntime.AutheoryProviderOptions{
		Issuer:            server.Issuer(),
		ClientID:          conformanceFacadeClientID,
		HTTPClient:        server.HTTPClient(),
		AllowPrivateHosts: true,
		FetchTimeout:      fetchTimeout,
	})
	if err != nil {
		t.Fatalf("new autheory provider: %v", err)
	}
	return provider
}

// TestAutheoryProviderDiscoveryRejectsDocumentWithoutIssuer pins that a
// discovery document with no issuer claim can never be trusted.
func TestAutheoryProviderDiscoveryRejectsDocumentWithoutIssuer(t *testing.T) {
	server := oauthprovider.NewServer(t, oauthprovider.Options{
		Issuer:              "https://auth.example.test",
		OmitDiscoveryIssuer: true,
	})
	defer server.Close()
	provider := newTestProvider(t, server, defaultFetchTimeout)

	metadata, err := provider.Discovery(context.Background())
	if err == nil {
		t.Fatalf("discovery without an issuer claim = %+v, want a fail-closed error", metadata)
	}
	providerErr, ok := oauthruntime.AsProviderError(err)
	if !ok {
		t.Fatalf("error %v is not a *ProviderError", err)
	}
	if providerErr.Class != oauthruntime.ProviderUpstreamError {
		t.Errorf("error class = %q, want %q", providerErr.Class, oauthruntime.ProviderUpstreamError)
	}
}

// TestAutheoryProviderTokenErrorClasses covers the classes the shared table does
// not reach: reauth_required needs an explicit upstream signal, and an
// unrecognized 4xx must stay an upstream_error rather than become a terminal
// client-facing decision.
func TestAutheoryProviderTokenErrorClasses(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   map[string]any
		want   oauthruntime.ProviderErrorClass
	}{
		{"invalid_grant", 400, map[string]any{"error": "invalid_grant"}, oauthruntime.ProviderInvalidGrant},
		{"reauth_required", 400, map[string]any{"error": "reauth_required"}, oauthruntime.ProviderReauthRequired},
		{"temporarily_unavailable", 503, map[string]any{"error": "temporarily_unavailable"}, oauthruntime.ProviderTemporarilyUnavailable},
		{"server_error", 500, map[string]any{"error": "server_error"}, oauthruntime.ProviderUpstreamError},
		{"unknown_4xx", 400, map[string]any{"error": "something_new"}, oauthruntime.ProviderUpstreamError},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := oauthprovider.NewServer(t, oauthprovider.Options{
				Issuer:      "https://auth.example.test",
				TokenStatus: testCase.status,
				TokenBody:   testCase.body,
			})
			defer server.Close()
			provider := newTestProvider(t, server, defaultFetchTimeout)

			_, err := provider.ExchangeCode(context.Background(), oauthruntime.CodeExchangeRequest{
				Code:             conformanceUpstreamCode,
				UpstreamClientID: conformanceFacadeClientID,
				CallbackURL:      conformanceCallbackURL,
				CodeVerifier:     conformanceCodeVerifier,
			})
			providerErr, ok := oauthruntime.AsProviderError(err)
			if !ok {
				t.Fatalf("exchange code error = %v, want *ProviderError", err)
			}
			if providerErr.Class != testCase.want {
				t.Errorf("error class = %q, want %q", providerErr.Class, testCase.want)
			}
			if strings.Contains(err.Error(), "UPSTREAM-SECRET-MARKER") {
				t.Errorf("error message leaked an upstream marker: %v", err)
			}
		})
	}
}

// TestAutheoryProviderValidateFailClosed covers the failure modes the shared
// table does not carry for this operation, including a token with no iss claim.
func TestAutheoryProviderValidateFailClosed(t *testing.T) {
	expectations := oauthruntime.TokenExpectations{
		ExpectedIssuer:   "https://auth.example.test",
		ExpectedAudience: conformanceResource,
		RequiredScopes:   []string{"mcp:tools"},
	}
	cases := []struct {
		name   string
		claims oauthprovider.Claims
	}{
		{"missing_iss", oauthprovider.Claims{
			Audience:  conformanceResource,
			Subject:   "user-1",
			Scope:     "mcp:tools",
			ExpiresIn: 900,
		}},
		{"bad_signature", oauthprovider.Claims{
			Issuer:          "https://auth.example.test",
			Audience:        conformanceResource,
			Subject:         "user-1",
			Scope:           "mcp:tools",
			ExpiresIn:       900,
			TamperSignature: true,
		}},
		{"missing_scope", oauthprovider.Claims{
			Issuer:    "https://auth.example.test",
			Audience:  conformanceResource,
			Subject:   "user-1",
			Scope:     "other:scope",
			ExpiresIn: 900,
		}},
		{"not_a_token", oauthprovider.Claims{Issuer: "https://auth.example.test"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := oauthprovider.NewServer(t, oauthprovider.Options{Issuer: "https://auth.example.test"})
			defer server.Close()
			provider := newTestProvider(t, server, defaultFetchTimeout)

			token := "not-a-jwt"
			if testCase.name != "not_a_token" {
				token = server.MintAccessToken(testCase.claims)
			}
			claims, err := provider.ValidateAccessToken(context.Background(), token, expectations)
			if err == nil {
				t.Fatalf("validate = %+v, want a fail-closed error", claims)
			}
			providerErr, ok := oauthruntime.AsProviderError(err)
			if !ok {
				t.Fatalf("error %v is not a *ProviderError", err)
			}
			if providerErr.Class != oauthruntime.ProviderUpstreamError {
				t.Errorf("error class = %q, want %q", providerErr.Class, oauthruntime.ProviderUpstreamError)
			}
		})
	}
}

// TestAutheoryProviderHintsCannotOverrideRequiredParameters pins the fail-closed
// ordering of AuthorizationURL: an opaque hint may add a parameter but never
// replace a required one such as client_id or state.
func TestAutheoryProviderHintsCannotOverrideRequiredParameters(t *testing.T) {
	server := oauthprovider.NewServer(t, oauthprovider.Options{Issuer: "https://auth.example.test"})
	defer server.Close()
	provider := newTestProvider(t, server, defaultFetchTimeout)

	raw, err := provider.AuthorizationURL(oauthruntime.AuthorizationRequest{
		UpstreamClientID:    conformanceFacadeClientID,
		CallbackURL:         conformanceCallbackURL,
		CodeChallenge:       "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		CodeChallengeMethod: "S256",
		State:               "facade-upstream-state",
		Resource:            conformanceResource,
		Scopes:              []string{"mcp:tools"},
		Hints: map[string]string{
			"client_id":  "attacker-client",
			"state":      "attacker-state",
			"resource":   "https://evil.example.test/mcp",
			"account_id": "acct_hint",
		},
	})
	if err != nil {
		t.Fatalf("authorization url: %v", err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("authorization url %q is not a URL: %v", raw, err)
	}
	query := parsed.Query()
	required := map[string]string{
		"client_id":             conformanceFacadeClientID,
		"state":                 "facade-upstream-state",
		"resource":              conformanceResource,
		"code_challenge_method": "S256",
	}
	for name, expected := range required {
		if actual := query.Get(name); actual != expected {
			t.Errorf("hint overrode %s: got %q, want %q", name, actual, expected)
		}
	}
	if actual := query.Get("account_id"); actual != "acct_hint" {
		t.Errorf("hint account_id = %q, want %q", actual, "acct_hint")
	}
}

// TestAutheoryProviderCachesDiscovery pins that discovery is fetched once: a
// later call still answers after the upstream is gone.
func TestAutheoryProviderCachesDiscovery(t *testing.T) {
	server := oauthprovider.NewServer(t, oauthprovider.Options{Issuer: "https://auth.example.test"})
	provider := newTestProvider(t, server, defaultFetchTimeout)

	first, err := provider.Discovery(context.Background())
	if err != nil {
		t.Fatalf("first discovery: %v", err)
	}
	server.Close()

	second, err := provider.Discovery(context.Background())
	if err != nil {
		t.Fatalf("cached discovery: %v", err)
	}
	if second.Issuer != first.Issuer || second.TokenEndpoint != first.TokenEndpoint {
		t.Fatalf("cached metadata = %+v, want %+v", second, first)
	}
}

// TestAutheoryProviderRefreshesWithTheOwningClient pins the refresh binding: the
// upstream leg presents the client that owns the recorded material, and the
// rotated material replaces the presented one.
func TestAutheoryProviderRefreshesWithTheOwningClient(t *testing.T) {
	server := oauthprovider.NewServer(t, oauthprovider.Options{
		Issuer:      "https://auth.example.test",
		TokenStatus: 200,
		TokenBody: map[string]any{
			"access_token":  "rotated-access-token",
			"refresh_token": "rotated-refresh-token",
			"token_type":    "Bearer",
			"expires_in":    900,
		},
	})
	defer server.Close()
	provider := newTestProvider(t, server, defaultFetchTimeout)

	tokenSet, err := provider.Refresh(context.Background(), oauthruntime.RefreshRequest{
		RefreshMaterial:  conformanceRefreshMaterial,
		UpstreamClientID: conformanceFacadeClientID,
	})
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if tokenSet.RefreshToken == conformanceRefreshMaterial {
		t.Error("refresh did not rotate the recorded material")
	}
	if actual := server.LastTokenRequest().Get("client_id"); actual != conformanceFacadeClientID {
		t.Errorf("upstream client_id = %q, want %q", actual, conformanceFacadeClientID)
	}
	if actual := server.LastTokenRequest().Get("refresh_token"); actual != conformanceRefreshMaterial {
		t.Errorf("upstream refresh_token = %q, want %q", actual, conformanceRefreshMaterial)
	}
}

func TestProviderErrorHTTPStatusAndUnwrap(t *testing.T) {
	statuses := map[oauthruntime.ProviderErrorClass]int{
		oauthruntime.ProviderUpstreamError:          502,
		oauthruntime.ProviderTemporarilyUnavailable: 503,
		oauthruntime.ProviderInvalidGrant:           400,
		oauthruntime.ProviderInvalidRequest:         400,
		oauthruntime.ProviderReauthRequired:         400,
	}
	for class, expected := range statuses {
		providerErr := oauthruntime.NewProviderError(class, "test", "fixed message")
		if got := providerErr.HTTPStatus(); got != expected {
			t.Errorf("class %q: HTTPStatus() = %d, want %d", class, got, expected)
		}
		if !strings.Contains(providerErr.Error(), string(class)) {
			t.Errorf("class %q: Error() = %q does not name the class", class, providerErr.Error())
		}
	}

	sentinel := errors.New("transport failed")
	providerErr := oauthruntime.NewProviderError(oauthruntime.ProviderTemporarilyUnavailable, "test", "fixed message")
	wrapped := fmt.Errorf("wrapped: %w", providerErr)
	found, ok := oauthruntime.AsProviderError(wrapped)
	if !ok || found != providerErr {
		t.Fatalf("AsProviderError(wrapped) = %v, %t; want the wrapped error", found, ok)
	}
	if _, ok := oauthruntime.AsProviderError(sentinel); ok {
		t.Fatal("AsProviderError reported a plain error as a *ProviderError")
	}
	if providerErr.Unwrap() != nil {
		t.Error("a class error without a cause must not unwrap to anything")
	}
}
