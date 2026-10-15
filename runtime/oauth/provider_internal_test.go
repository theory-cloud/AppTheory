package oauth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory/v6/testkit/oauthprovider"
)

// b64url encodes a raw JWS segment.
func b64url(raw string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// compactJWS assembles a compact JWS from a header, payload, and signature
// segment, each given as raw JSON or text.
func compactJWS(header, payload, signature string) string {
	return b64url(header) + "." + b64url(payload) + "." + b64url(signature)
}

// mustParseURL parses raw, failing the test on a malformed URL.
func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return parsed
}

// serveBytes returns a handler that writes data and stops on a write error.
func serveBytes(data []byte) http.HandlerFunc {
	return func(writer http.ResponseWriter, _ *http.Request) {
		if _, err := writer.Write(data); err != nil {
			return
		}
	}
}

func TestProviderErrorNilAndCausePaths(t *testing.T) {
	var nilErr *ProviderError
	if got := nilErr.Error(); got != "" {
		t.Fatalf("nil Error() = %q", got)
	}
	if nilErr.Unwrap() != nil {
		t.Fatal("nil Unwrap() must be nil")
	}
	if got := nilErr.HTTPStatus(); got != 500 {
		t.Fatalf("nil HTTPStatus() = %d", got)
	}
	if got := nilErr.withCause(errors.New("cause")); got != nil {
		t.Fatalf("nil withCause() = %v", got)
	}

	// An operation-less error renders without a stray separator.
	opless := &ProviderError{Class: ProviderInvalidGrant, Message: "fixed"}
	if got := opless.Error(); got != "oauth provider: invalid_grant: fixed" {
		t.Fatalf("operation-less Error() = %q", got)
	}
	// An unrecognized class is an internal error, never a client-facing one.
	if got := NewProviderError("surprise", "op", "fixed").HTTPStatus(); got != 500 {
		t.Fatalf("unknown class HTTPStatus() = %d, want 500", got)
	}

	cause := errors.New("connection reset")
	classed := providerClassError(ProviderUpstreamError, providerOpDiscovery, "fixed message", cause)
	if !errors.Is(classed, cause) {
		t.Fatalf("providerClassError did not attach the cause: %v", classed)
	}
	if !strings.Contains(classed.Error(), "connection reset") {
		t.Fatalf("Error() = %q, want the cause rendered", classed)
	}
	if providerClassError(ProviderUpstreamError, providerOpDiscovery, "fixed message", nil).Unwrap() != nil {
		t.Fatal("a nil cause must not keep an unwrap target")
	}
}

func TestNewAutheoryProviderRejectsRelativeIssuer(t *testing.T) {
	if _, err := NewAutheoryProvider(AutheoryProviderOptions{Issuer: "auth.example.test"}); err == nil {
		t.Fatal("NewAutheoryProvider accepted a relative issuer")
	}
	provider, err := NewAutheoryProvider(AutheoryProviderOptions{Issuer: " https://auth.example.test "})
	if err != nil {
		t.Fatalf("NewAutheoryProvider: %v", err)
	}
	if provider.issuer != "https://auth.example.test" {
		t.Fatalf("canonical issuer = %q", provider.issuer)
	}
	if provider.discoveryURL != "https://auth.example.test"+autheoryWellKnownPath {
		t.Fatalf("default discovery URL = %q", provider.discoveryURL)
	}
}

func TestDiscoveryDocumentMetadataRejectsInsecureEndpoints(t *testing.T) {
	secure := func() autheoryDiscoveryDocument {
		return autheoryDiscoveryDocument{ //nolint:gosec // fixed fake endpoint URLs in a test
			AuthorizationEndpoint: "https://auth.example.test/oauth/authorize",
			TokenEndpoint:         "https://auth.example.test/token",
			JWKSURI:               "https://auth.example.test/.well-known/jwks.json",
		}
	}
	if metadata, ok := secure().metadata("https://auth.example.test"); !ok || metadata.Issuer != "https://auth.example.test" {
		t.Fatalf("secure document rejected: %+v %t", metadata, ok)
	}

	insecureAuthorization := secure()
	insecureAuthorization.AuthorizationEndpoint = "http://auth.example.test/oauth/authorize"
	insecureToken := secure()
	insecureToken.TokenEndpoint = "http://auth.example.test/token"
	insecureJWKS := secure()
	insecureJWKS.JWKSURI = "http://auth.example.test/.well-known/jwks.json"

	for name, document := range map[string]autheoryDiscoveryDocument{
		"authorization_endpoint": insecureAuthorization,
		"token_endpoint":         insecureToken,
		"jwks_uri":               insecureJWKS,
	} {
		if _, ok := document.metadata("https://auth.example.test"); ok {
			t.Errorf("%s: a non-https endpoint was trusted", name)
		}
	}
}

func TestApplyEndpointOverrides(t *testing.T) {
	provider := &AutheoryProvider{ //nolint:gosec // fixed fake endpoint URLs in a test
		authzOverride: "https://override.example.test/authorize",
		tokenOverride: "https://override.example.test/token",
		jwksOverride:  "https://override.example.test/jwks",
	}
	metadata := &ProviderMetadata{ //nolint:gosec // fixed fake endpoint URLs in a test
		AuthorizationEndpoint: "https://auth.example.test/authorize",
		TokenEndpoint:         "https://auth.example.test/token",
		JWKSURI:               "https://auth.example.test/jwks",
	}
	provider.applyEndpointOverrides(metadata)
	if metadata.AuthorizationEndpoint != provider.authzOverride ||
		metadata.TokenEndpoint != provider.tokenOverride ||
		metadata.JWKSURI != provider.jwksOverride {
		t.Fatalf("overrides not applied: %+v", metadata)
	}
}

func TestEndpointOverrideResolution(t *testing.T) {
	provider := &AutheoryProvider{}
	if _, err := provider.endpoint(context.Background(), providerOpRefresh, "http://insecure.example.test/token", nil); err == nil {
		t.Fatal("a non-https override was accepted")
	}
	normalized, err := provider.endpoint(
		context.Background(), providerOpRefresh, " https://override.example.test/token ", nil)
	if err != nil {
		t.Fatalf("override resolution: %v", err)
	}
	if normalized != "https://override.example.test/token" {
		t.Fatalf("normalized override = %q", normalized)
	}

	// Without an override the endpoint falls through to discovery, so a
	// non-secure discovery URL fails the resolution.
	failing := &AutheoryProvider{discoveryURL: "http://insecure.example.test/discovery"}
	if _, err := failing.endpoint(context.Background(), providerOpDiscovery, "", func(*ProviderMetadata) string {
		return "unused"
	}); err == nil {
		t.Fatal("endpoint resolution ignored a failing discovery")
	}
}

func TestAuthorizationRequestValidationPaths(t *testing.T) {
	valid := AuthorizationRequest{
		UpstreamClientID:    "facade-client",
		CallbackURL:         "https://mcp.example.test/callback",
		CodeChallenge:       "challenge",
		CodeChallengeMethod: pkceMethodS256,
		State:               "state",
		Resource:            "https://mcp.example.test/mcp",
	}
	if err := valid.validate(); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}

	unsupportedMethod := valid
	unsupportedMethod.CodeChallengeMethod = "plain"
	if err := unsupportedMethod.validate(); err == nil {
		t.Fatal("an unsupported PKCE method was accepted")
	}

	missingResource := valid
	missingResource.Resource = "  "
	if err := missingResource.validate(); err == nil {
		t.Fatal("a blank resource was accepted")
	}

	collidingHint := valid
	collidingHint.Hints = map[string]string{" Client_ID ": "attacker-client"}
	if err := collidingHint.validate(); err == nil {
		t.Fatal("a hint colliding with a required parameter was accepted")
	}

	forwardedHint := valid
	forwardedHint.Hints = map[string]string{"": "ignored", "account_id": "acct_hint"}
	if err := forwardedHint.validate(); err != nil {
		t.Fatalf("a non-colliding hint was rejected: %v", err)
	}
}

func TestAuthorizationURLFailClosedPaths(t *testing.T) {
	// An invalid authorization endpoint override fails after the request checks.
	provider := &AutheoryProvider{authzOverride: "http://insecure.example.test/authorize"}
	request := AuthorizationRequest{
		UpstreamClientID:    "facade-client",
		CallbackURL:         "https://mcp.example.test/callback",
		CodeChallenge:       "challenge",
		CodeChallengeMethod: pkceMethodS256,
		State:               "state",
		Resource:            "https://mcp.example.test/mcp",
	}
	if _, err := provider.AuthorizationURL(request); err == nil {
		t.Fatal("a non-https authorization endpoint was accepted")
	}

	// A blank hint name is skipped and a non-colliding hint is applied.
	working := &AutheoryProvider{authzOverride: "https://auth.example.test/oauth/authorize?existing=1"}
	request.Hints = map[string]string{"": "ignored", "account_id": "acct_hint"}
	raw, err := working.AuthorizationURL(request)
	if err != nil {
		t.Fatalf("AuthorizationURL: %v", err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("authorization URL %q is not a URL: %v", raw, err)
	}
	query := parsed.Query()
	if query.Get("account_id") != "acct_hint" {
		t.Errorf("hint account_id = %q", query.Get("account_id"))
	}
	if query.Get("state") != "state" {
		t.Errorf("a blank hint overrode state: %q", query.Get("state"))
	}
	if query.Get("existing") != "1" {
		t.Errorf("the endpoint's own query was dropped: %q", raw)
	}

	// A hint colliding with a required parameter is refused, not applied.
	for _, hints := range []map[string]string{
		{"state": "attacker-state"},
		{"Client_ID": "attacker-client"},
		{" response_type ": "token"},
	} {
		request.Hints = hints
		if raw, err := working.AuthorizationURL(request); err == nil {
			t.Fatalf("a hint colliding with a required parameter was accepted: %q", raw)
		}
	}
}

func TestExchangeCodeAndRefreshFailClosedPaths(t *testing.T) {
	provider := &AutheoryProvider{}
	if _, err := provider.ExchangeCode(context.Background(), CodeExchangeRequest{}); err == nil {
		t.Fatal("ExchangeCode accepted an incomplete request")
	}
	if _, err := provider.Refresh(context.Background(), RefreshRequest{}); err == nil {
		t.Fatal("Refresh accepted an incomplete request")
	}

	// A non-https token endpoint override fails after the request checks.
	overridden := &AutheoryProvider{tokenOverride: "http://insecure.example.test/token"} //nolint:gosec // fixed fake endpoint URL in a test
	if _, err := overridden.ExchangeCode(context.Background(), CodeExchangeRequest{
		Code:             "code",
		UpstreamClientID: "facade-client",
		CallbackURL:      "https://mcp.example.test/callback",
		CodeVerifier:     "verifier",
	}); err == nil {
		t.Fatal("ExchangeCode accepted a non-https token endpoint")
	}
	if _, err := overridden.Refresh(context.Background(), RefreshRequest{
		RefreshMaterial:  "refresh",
		UpstreamClientID: "facade-client",
	}); err == nil {
		t.Fatal("Refresh accepted a non-https token endpoint")
	}
}

// newFakeProvider builds an Autheory adapter over a fake upstream.
func newFakeProvider(t *testing.T, opts oauthprovider.Options) *AutheoryProvider {
	t.Helper()
	server := oauthprovider.NewServer(t, opts)
	t.Cleanup(server.Close)
	provider, err := NewAutheoryProvider(AutheoryProviderOptions{
		Issuer:            server.Issuer(),
		HTTPClient:        server.HTTPClient(),
		AllowPrivateHosts: true,
		FetchTimeout:      5 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewAutheoryProvider: %v", err)
	}
	return provider
}

func TestPostTokenRejectsUnparseableBody(t *testing.T) {
	provider := newFakeProvider(t, oauthprovider.Options{
		Issuer:         "https://auth.example.test",
		TokenBodyBytes: 256,
	})
	_, err := provider.ExchangeCode(context.Background(), CodeExchangeRequest{
		Code:             "code",
		UpstreamClientID: "facade-client",
		CallbackURL:      "https://mcp.example.test/callback",
		CodeVerifier:     "verifier",
	})
	providerErr, ok := AsProviderError(err)
	if !ok || providerErr.Class != ProviderUpstreamError {
		t.Fatalf("unparseable token body error = %v", err)
	}
}

func TestValidateAccessTokenJwksEndpointFailure(t *testing.T) {
	provider := &AutheoryProvider{jwksOverride: "http://insecure.example.test/jwks"}
	if _, err := provider.ValidateAccessToken(context.Background(), "token", TokenExpectations{}); err == nil {
		t.Fatal("ValidateAccessToken accepted a non-https JWKS endpoint")
	}
}

func TestValidateAccessTokenInvalidExpectations(t *testing.T) {
	// An empty expected issuer cannot build a validator, so validation fails
	// closed with the upstream error class after the JWKS endpoint resolves.
	provider := newFakeProvider(t, oauthprovider.Options{Issuer: "https://auth.example.test"})
	claims, err := provider.ValidateAccessToken(context.Background(), "token", TokenExpectations{})
	if err == nil {
		t.Fatalf("ValidateAccessToken returned claims %+v for an empty issuer", claims)
	}
	providerErr, ok := AsProviderError(err)
	if !ok || providerErr.Class != ProviderUpstreamError {
		t.Fatalf("invalid-expectations error = %v", err)
	}
}

func TestValidatorCacheReuseAndEviction(t *testing.T) {
	provider := newFakeProvider(t, oauthprovider.Options{Issuer: "https://auth.example.test"})
	jwksURI := "https://auth.example.test/.well-known/jwks.json"
	expected := TokenExpectations{ExpectedIssuer: "https://auth.example.test"}

	first, err := provider.validatorFor(jwksURI, expected)
	if err != nil {
		t.Fatalf("validatorFor: %v", err)
	}
	second, err := provider.validatorFor(jwksURI, expected)
	if err != nil {
		t.Fatalf("validatorFor (cached): %v", err)
	}
	if reflect.ValueOf(first).Pointer() != reflect.ValueOf(second).Pointer() {
		t.Fatal("the same expectation set built more than one validator")
	}

	// Distinct expectation sets are bounded: the oldest entry is evicted once
	// the cache is full, so the adapter's state cannot grow without bound.
	for index := 0; index < maxCachedValidators+1; index++ {
		if _, err := provider.validatorFor(jwksURI, TokenExpectations{
			ExpectedIssuer:   "https://auth.example.test",
			ExpectedAudience: fmt.Sprintf("https://aud-%d.example.test", index),
		}); err != nil {
			t.Fatalf("validatorFor (#%d): %v", index, err)
		}
	}
	provider.mu.Lock()
	cached := len(provider.validators)
	provider.mu.Unlock()
	if cached > maxCachedValidators {
		t.Fatalf("validator cache holds %d entries, want <= %d", cached, maxCachedValidators)
	}
}

func TestExpectationAuthorizedPartiesAndKey(t *testing.T) {
	own := expectationAuthorizedParties(TokenExpectations{AllowedAuthorizedParties: []string{"client-a"}}, []string{"fallback"})
	if len(own) != 1 || own[0] != "client-a" {
		t.Fatalf("expectation's own allow-list = %v", own)
	}
	fallback := expectationAuthorizedParties(TokenExpectations{}, []string{"fallback"})
	if len(fallback) != 1 || fallback[0] != "fallback" {
		t.Fatalf("fallback allow-list = %v", fallback)
	}

	key := expectationKey(TokenExpectations{
		ExpectedIssuer:           " issuer ",
		ExpectedAudience:         " audience ",
		RequiredScopes:           []string{"a", "b"},
		AllowedAuthorizedParties: []string{"c"},
	})
	if key.issuer != "issuer" || key.audience != "audience" ||
		key.scopes != "a"+providerKeySeparator+"b" || key.authorizedParties != "c" {
		t.Fatalf("expectation key = %+v", key)
	}
}

func TestAuthorizedPartyFromToken(t *testing.T) {
	if got := authorizedPartyFromToken("not-a-jwt"); got != "" {
		t.Fatalf("malformed token azp = %q", got)
	}
	if got := authorizedPartyFromToken(compactJWS(`{"alg":"RS256"}`, "not-json", "sig")); got != "" {
		t.Fatalf("unparseable payload azp = %q", got)
	}
	if got := authorizedPartyFromToken(compactJWS(`{"alg":"RS256"}`, `{"azp":"client-a"}`, "sig")); got != "client-a" {
		t.Fatalf("azp = %q", got)
	}
	if got := authorizedPartyFromToken(compactJWS(`{"alg":"RS256"}`, `{"client_id":"client-b"}`, "sig")); got != "client-b" {
		t.Fatalf("client_id fallback = %q", got)
	}
	if got := authorizedPartyFromToken(compactJWS(`{"alg":"RS256"}`, `{"azp":"","client_id":""}`, "sig")); got != "" {
		t.Fatalf("empty azp and client_id = %q", got)
	}
}

func TestTokenErrorCodeRejectsUnparseableBody(t *testing.T) {
	if got := tokenErrorCode([]byte("not json")); got != "" {
		t.Fatalf("tokenErrorCode(non-JSON) = %q", got)
	}
	if got := tokenErrorCode([]byte(`{"error":" invalid_grant "}`)); got != "invalid_grant" {
		t.Fatalf("tokenErrorCode = %q", got)
	}
}

func TestProviderTransientFailureClassification(t *testing.T) {
	if providerTransientFailure(nil) {
		t.Fatal("nil is not a transient failure")
	}
	if !providerTransientFailure(fmt.Errorf("dial: %w", syscall.ECONNRESET)) {
		t.Fatal("ECONNRESET must be transient")
	}
	if !providerTransientFailure(syscall.ECONNREFUSED) {
		t.Fatal("ECONNREFUSED must be transient")
	}
	if !providerTransientFailure(&net.DNSError{Err: "no such host"}) {
		t.Fatal("a DNS failure must be transient")
	}
	if !providerTransientFailure(osDeadlineError{}) {
		t.Fatal("a net.Error timeout must be transient")
	}
	if providerTransientFailure(errors.New("plain failure")) {
		t.Fatal("a plain error must not be transient")
	}
}

// osDeadlineError is a minimal net.Error whose Timeout reports true, so the
// deadline branch of the transient classifier is reached without a real socket.
type osDeadlineError struct{}

func (osDeadlineError) Error() string   { return "i/o timeout" }
func (osDeadlineError) Timeout() bool   { return true }
func (osDeadlineError) Temporary() bool { return true }

func TestPostBoundedFormEdges(t *testing.T) {
	form := url.Values{formFieldGrantType: {grantTypeRefreshToken}}

	// A nil context is replaced with a background context.
	ok := httptest.NewServer(serveBytes([]byte(`{"access_token":"token"}`)))
	defer ok.Close()
	status, body, err := postBoundedForm(nil, ok.Client(), ok.URL, form) //nolint:staticcheck // nil-context fallback under test
	if err != nil || status != http.StatusOK || string(body) != `{"access_token":"token"}` {
		t.Fatalf("postBoundedForm(nil ctx) = %d %q %v", status, body, err)
	}

	// A request that cannot be built fails closed.
	if _, _, postErr := postBoundedForm(context.Background(), http.DefaultClient, "://bad", form); postErr == nil {
		t.Fatal("an unbuildable request was accepted")
	}

	// A redirect is reported rather than followed.
	redirecting := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, "/elsewhere", http.StatusFound)
	}))
	defer redirecting.Close()
	noRedirect := redirecting.Client()
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	status, body, err = postBoundedForm(context.Background(), noRedirect, redirecting.URL, form)
	if err == nil {
		t.Fatalf("a redirect was followed: %d %q", status, body)
	}
	if !errors.Is(err, errRedirectRejected) && !errors.Is(err, errCrossOriginRedirect) {
		t.Fatalf("redirect error = %v, want a redirect rejection", err)
	}
}

// --- jwks.go helpers ---------------------------------------------------------

func TestEffectivePortAndSameOrigin(t *testing.T) {
	withPort := mustParseURL(t, "https://a.example.test:8443/x")
	if got := effectivePort(withPort); got != "8443" {
		t.Fatalf("effectivePort(explicit) = %q", got)
	}
	defaultHTTPS := mustParseURL(t, "https://a.example.test/x")
	if got := effectivePort(defaultHTTPS); got != "443" {
		t.Fatalf("effectivePort(https default) = %q", got)
	}
	defaultHTTP := mustParseURL(t, "http://a.example.test/x")
	if got := effectivePort(defaultHTTP); got != "80" {
		t.Fatalf("effectivePort(http default) = %q", got)
	}

	if sameOrigin(nil, defaultHTTPS) || sameOrigin(defaultHTTPS, nil) {
		t.Fatal("sameOrigin must be false for a nil URL")
	}
	uppercase := mustParseURL(t, "HTTPS://A.EXAMPLE.TEST./x")
	if !sameOrigin(defaultHTTPS, uppercase) {
		t.Fatal("sameOrigin must ignore case and a trailing dot")
	}
	if sameOrigin(defaultHTTPS, defaultHTTP) {
		t.Fatal("sameOrigin must compare schemes")
	}
}

func TestRedirectFailure(t *testing.T) {
	requestURL := mustParseURL(t, "https://a.example.test/token")

	if err := redirectFailure(requestURL, &http.Response{Header: http.Header{}}); !errors.Is(err, errRedirectRejected) {
		t.Fatalf("empty location error = %v", err)
	}
	unparseable := &http.Response{Header: http.Header{"Location": {"%zz"}}}
	if err := redirectFailure(requestURL, unparseable); !errors.Is(err, errRedirectRejected) {
		t.Fatalf("unparseable location error = %v", err)
	}
	sameOriginRedirect := &http.Response{Header: http.Header{"Location": {"/elsewhere"}}}
	if err := redirectFailure(requestURL, sameOriginRedirect); !errors.Is(err, errRedirectRejected) {
		t.Fatalf("same-origin redirect error = %v", err)
	}
	crossOrigin := &http.Response{Header: http.Header{"Location": {"https://evil.example.test/token"}}}
	if err := redirectFailure(requestURL, crossOrigin); !errors.Is(err, errCrossOriginRedirect) {
		t.Fatalf("cross-origin redirect error = %v", err)
	}
}

func TestNormalizeSecureURLRejectsFragment(t *testing.T) {
	if _, ok := normalizeSecureURL("https://a.example.test/jwks#fragment"); ok {
		t.Fatal("a fragment-bearing URL was accepted")
	}
	if _, ok := normalizeSecureURL("https://user@a.example.test/jwks"); ok {
		t.Fatal("a userinfo-bearing URL was accepted")
	}
}

func TestGuardJWKSConnection(t *testing.T) {
	if err := guardJWKSConnection("unix", "/tmp/sock", nil); err != nil {
		t.Fatalf("non-tcp network rejected: %v", err)
	}
	if err := guardJWKSConnection("tcp", "not-a-host-port", nil); err == nil {
		t.Fatal("a malformed address was accepted")
	}
	if err := guardJWKSConnection("tcp4", "127.0.0.1:443", nil); err == nil {
		t.Fatal("a loopback address was accepted")
	}
	if err := guardJWKSConnection("tcp", "93.184.216.34:443", nil); err != nil {
		t.Fatalf("a public address was rejected: %v", err)
	}
}

func TestIsPublicHostAddress(t *testing.T) {
	if isPublicHostAddress(nil) {
		t.Fatal("a nil address must be refused")
	}
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1"} {
		if isPublicHostAddress(net.ParseIP(raw)) {
			t.Errorf("%s must be refused", raw)
		}
	}
	for _, raw := range []string{"93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"} {
		if !isPublicHostAddress(net.ParseIP(raw)) {
			t.Errorf("%s must be public", raw)
		}
	}
	if !isPublicHostAddress(net.ParseIP("::ffff:93.184.216.34")) {
		t.Error("an IPv4-mapped public address must be public")
	}
}

func TestAllowedAZPSet(t *testing.T) {
	if allowedAZPSet(nil) != nil || allowedAZPSet([]string{"  "}) != nil {
		t.Fatal("an empty or blank allow-list must be nil")
	}
	allowed := allowedAZPSet([]string{" client-a ", "", "client-b"})
	if len(allowed) != 2 {
		t.Fatalf("allow-list = %v", allowed)
	}
	if _, ok := allowed["client-a"]; !ok {
		t.Fatalf("allow-list lost a trimmed member: %v", allowed)
	}
}

func TestParseCompactJWSErrors(t *testing.T) {
	cases := map[string]string{
		"two_segments":       "a.b",
		"bad_header_base64":  "!!." + b64url("{}") + "." + b64url("sig"),
		"bad_payload_base64": b64url(`{"alg":"RS256"}`) + ".!!." + b64url("sig"),
		"bad_signature":      b64url(`{"alg":"RS256"}`) + "." + b64url("{}") + ".!!",
		"header_not_json":    b64url("not-json") + "." + b64url("{}") + "." + b64url("sig"),
		"critical_header":    b64url(`{"alg":"RS256","kid":"k","crit":["exp"]}`) + "." + b64url("{}") + "." + b64url("sig"),
	}
	for name, token := range cases {
		if _, err := parseCompactJWS(token); err == nil {
			t.Errorf("%s: malformed token accepted", name)
		}
	}

	parsed, err := parseCompactJWS(" " + b64url(`{"alg":"RS256","kid":" key ","crit":null}`) + "." + b64url("{}") + "." + b64url("sig") + " ")
	if err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if parsed.alg != "RS256" || parsed.kid != "key" {
		t.Fatalf("parsed token = %+v", parsed)
	}
}

func TestParseJWKSClaimsErrors(t *testing.T) {
	if _, err := parseJWKSClaims([]byte("not json")); err == nil {
		t.Fatal("an unparseable payload was accepted")
	}
	for name, payload := range map[string]string{
		"audience_not_string_list": `{"aud":123}`,
		"scp_not_string_list":      `{"scp":123}`,
		"exp_not_numeric":          `{"exp":"soon"}`,
		"nbf_not_numeric":          `{"nbf":"later"}`,
		"exp_out_of_range":         `{"exp":1e999999}`,
		"nbf_out_of_range":         `{"nbf":1e999999}`,
	} {
		if _, err := parseJWKSClaims([]byte(payload)); err == nil {
			t.Errorf("%s: invalid claim accepted", name)
		}
	}

	claims, err := parseJWKSClaims([]byte(`{"iss":" https://issuer.example.test ","aud":["a","a"," b "],"scp":"x y","azp":"client","exp":1.5,"nbf":2}`))
	if err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}
	if claims.Issuer != "https://issuer.example.test" || !claims.HasExpiry || !claims.HasNotBefore {
		t.Fatalf("claims = %+v", claims)
	}
	if len(claims.Audience) != 2 || claims.Audience[1] != "b" {
		t.Fatalf("audience = %v", claims.Audience)
	}
	if len(claims.Scopes) != 1 || claims.Scopes[0] != "x y" {
		t.Fatalf("scopes = %v", claims.Scopes)
	}
}

func TestParseStringOrStringListAndNormalize(t *testing.T) {
	if values, err := parseStringOrStringList(nil); err != nil || values != nil {
		t.Fatalf("null claim = %v %v", values, err)
	}
	if _, err := parseStringOrStringList(json.RawMessage(`[1,2]`)); err == nil {
		t.Fatal("a non-string array was accepted")
	}
	if _, err := parseStringOrStringList(json.RawMessage(`123`)); err == nil {
		t.Fatal("a non-string scalar was accepted")
	}
	if values, err := parseStringOrStringList(json.RawMessage(`"one two"`)); err != nil || len(values) != 1 || values[0] != "one two" {
		t.Fatalf("space-bearing scalar = %v %v", values, err)
	}

	normalized := normalizeClaimValues([]string{" a ", "a", "", "b"})
	if len(normalized) != 2 || normalized[0] != "a" || normalized[1] != "b" {
		t.Fatalf("normalizeClaimValues = %v", normalized)
	}
}

func TestNumericDate(t *testing.T) {
	whole, ok := numericDate(json.Number("1700000000"))
	if !ok || whole.Unix() != 1700000000 {
		t.Fatalf("numericDate(whole) = %v %t", whole, ok)
	}
	fractional, ok := numericDate(json.Number("1700000000.5"))
	if !ok || fractional.Nanosecond() != 500_000_000 {
		t.Fatalf("numericDate(fractional) = %v %t", fractional, ok)
	}
	if _, ok := numericDate(json.Number("soon")); ok {
		t.Fatal("a non-numeric date was accepted")
	}
}

func TestVerifyRS256Edges(t *testing.T) {
	if verifyRS256(nil, []byte("input"), []byte("sig")) {
		t.Fatal("a nil key must not verify")
	}
	if verifyRS256(&rsa.PublicKey{N: big.NewInt(3), E: 3}, []byte("input"), nil) {
		t.Fatal("an empty signature must not verify")
	}
	if verifyRS256(&rsa.PublicKey{N: big.NewInt(3), E: 3}, []byte("input"), []byte("sig")) {
		t.Fatal("a bogus signature must not verify")
	}
}

func TestParseJWKSKeysEdges(t *testing.T) {
	if _, err := parseJWKSKeys([]byte("not json")); err == nil {
		t.Fatal("an unparseable document was accepted")
	}
	if _, err := parseJWKSKeys([]byte(`{"keys":[]}`)); err == nil {
		t.Fatal("an empty key set was accepted")
	}

	validN := base64.RawURLEncoding.EncodeToString([]byte{1, 2, 3})
	body := fmt.Sprintf(`{"keys":[
		{"kty":"RSA","kid":"","n":%q,"e":"AQAB"},
		{"kty":"RSA","kid":"dup","n":%q,"e":"AQAB"},
		{"kty":"RSA","kid":"dup","n":%q,"e":"AQAB"}
	]}`, validN, validN, validN)
	keys, err := parseJWKSKeys([]byte(body))
	if err != nil {
		t.Fatalf("parseJWKSKeys: %v", err)
	}
	if len(keys) != 1 || keys[0].kid != "dup" {
		t.Fatalf("parsed keys = %+v (a blank and a duplicate kid must be dropped)", keys)
	}
}

func TestRSAPublicKeyFromJWKEdges(t *testing.T) {
	validN := base64.RawURLEncoding.EncodeToString([]byte{1, 2, 3})
	if _, ok := rsaPublicKeyFromJWK(jwk{Kty: "RSA", N: "", E: "AQAB"}); ok {
		t.Fatal("a missing modulus was accepted")
	}
	if _, ok := rsaPublicKeyFromJWK(jwk{Kty: "RSA", N: validN, E: "!!"}); ok {
		t.Fatal("a malformed exponent was accepted")
	}
	if _, ok := rsaPublicKeyFromJWK(jwk{Kty: "EC", N: validN, E: "AQAB"}); ok {
		t.Fatal("a non-RSA key type was accepted")
	}
	if _, ok := rsaPublicKeyFromJWK(jwk{Kty: "RSA", Alg: "HS256", N: validN, E: "AQAB"}); ok {
		t.Fatal("a non-RS256 algorithm was accepted")
	}
	if _, ok := rsaPublicKeyFromJWK(jwk{Kty: "RSA", Use: "enc", N: validN, E: "AQAB"}); ok {
		t.Fatal("a non-signature key use was accepted")
	}
}

func TestDecodeBase64URLUIntAndExponent(t *testing.T) {
	if _, ok := decodeBase64URLUInt("  "); ok {
		t.Fatal("a blank value was accepted")
	}
	if _, ok := decodeBase64URLUInt("!!"); ok {
		t.Fatal("a malformed value was accepted")
	}
	if got, ok := decodeBase64URLUInt(base64.RawURLEncoding.EncodeToString([]byte{5})); !ok || got.Int64() != 5 {
		t.Fatalf("decodeBase64URLUInt = %v %t", got, ok)
	}

	if _, ok := decodeExponent(base64.RawURLEncoding.EncodeToString([]byte{1})); ok {
		t.Fatal("an exponent below 3 was accepted")
	}
	if _, ok := decodeExponent(base64.RawURLEncoding.EncodeToString(make([]byte, 12))); ok {
		t.Fatal("an exponent that is not an int64 was accepted")
	}
	if got, ok := decodeExponent("AQAB"); !ok || got != 65537 {
		t.Fatalf("decodeExponent = %d %t", got, ok)
	}
}

func TestAwaitFlightBounds(t *testing.T) {
	validator := &jwksValidator{fetchTimeout: 10 * time.Millisecond}
	hung := &jwksRefreshFlight{done: make(chan struct{})}
	if err := validator.awaitFlight(context.Background(), hung); err == nil {
		t.Fatal("awaitFlight returned for a never-completing flight")
	}

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := validator.awaitFlight(canceled, hung); err == nil {
		t.Fatal("awaitFlight returned for a canceled context")
	}

	completed := &jwksRefreshFlight{done: make(chan struct{}), err: errUnknownKey}
	close(completed.done)
	if err := validator.awaitFlight(context.Background(), completed); !errors.Is(err, errUnknownKey) {
		t.Fatalf("awaitFlight completed flight error = %v", err)
	}
}

func TestFetchBoundedDocumentEdges(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/ok" {
			http.Error(writer, "no", http.StatusNotFound)
			return
		}
		if _, err := writer.Write([]byte("body")); err != nil {
			return
		}
	}))
	defer server.Close()

	body, err := fetchBoundedDocument(nil, server.Client(), server.URL+"/ok") //nolint:staticcheck // nil-context fallback under test
	if err != nil || string(body) != "body" {
		t.Fatalf("fetchBoundedDocument(nil ctx) = %q %v", body, err)
	}
	if _, err := fetchBoundedDocument(context.Background(), server.Client(), "://bad"); err == nil {
		t.Fatal("an unbuildable request was accepted")
	}
	if _, err := fetchBoundedDocument(context.Background(), server.Client(), server.URL+"/missing"); err == nil {
		t.Fatal("a non-200 response was accepted")
	}
}

func TestBootstrapOIDCDiscoveryEdges(t *testing.T) {
	if _, err := BootstrapOIDCDiscovery(context.Background(), "https://a.example.test/discovery", "not-a-url", nil); err == nil {
		t.Fatal("a relative configured issuer was accepted")
	}

	badDocument := httptest.NewTLSServer(serveBytes([]byte("not json")))
	defer badDocument.Close()
	if _, err := BootstrapOIDCDiscovery(context.Background(), badDocument.URL, badDocument.URL, badDocument.Client()); err == nil {
		t.Fatal("an unparseable discovery document was accepted")
	}

	insecure := httptest.NewTLSServer(serveBytes([]byte(fmt.Sprintf(
		`{"issuer":%q,"jwks_uri":"http://a.example.test/jwks"}`, "https://issuer.example.test"))))
	defer insecure.Close()
	if _, err := BootstrapOIDCDiscovery(context.Background(), insecure.URL, "https://issuer.example.test", insecure.Client()); err == nil {
		t.Fatal("a non-https jwks_uri was accepted")
	}
}

func TestJWKSValidatorStateEdges(t *testing.T) {
	if _, err := NewJWKSValidator(JWKSValidatorOptions{Issuer: "not-a-url", JWKSURI: "https://a.example.test/jwks"}); err == nil {
		t.Fatal("an invalid issuer was accepted")
	}
	// An unroutable discovery URL fails the bootstrap.
	if _, err := NewJWKSValidator(JWKSValidatorOptions{
		Issuer:       "https://a.example.test",
		DiscoveryURL: "https://127.0.0.1:1/discovery",
	}); err == nil {
		t.Fatal("an unreachable discovery URL was accepted")
	}
	// An invalid explicit discovery URL is refused before any fetch.
	if _, err := NewJWKSValidator(JWKSValidatorOptions{
		Issuer:       "https://a.example.test",
		DiscoveryURL: "http://a.example.test/discovery",
	}); err == nil {
		t.Fatal("a non-https discovery URL was accepted")
	}

	validator, err := newJWKSValidatorState(JWKSValidatorOptions{
		Issuer:  "https://a.example.test",
		JWKSURI: "https://a.example.test/jwks",
	})
	if err != nil {
		t.Fatalf("newJWKSValidatorState: %v", err)
	}
	if validator.now().IsZero() {
		t.Fatal("the default clock returned the zero instant")
	}
}

func TestJWKSValidatorInternalBranches(t *testing.T) {
	now := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)

	// checkAudience with no requirement and no audience claim.
	audience, err := (&jwksValidator{}).checkAudience(nil, jwksClaims{})
	if err != nil || audience != "" {
		t.Fatalf("checkAudience = %q %v", audience, err)
	}

	// A malformed payload fails the claim parse inside validate.
	validator := &jwksValidator{issuer: "https://issuer.example.test"}
	_, err = validator.validate(nil, compactJWS(`{"alg":"RS256","kid":"k"}`, "not-json", "sig"))
	if !errors.Is(err, ErrInvalidBearerToken) {
		t.Fatalf("validate with an unparseable payload = %v", err)
	}

	// pruneWindowsLocked drops expired windows and evicts at capacity.
	windowed := &jwksValidator{
		refreshCooldown:  time.Minute,
		maxWindowEntries: 2,
		windows: map[string]jwksKidWindow{
			"expired": {startedAt: now.Add(-2 * time.Minute)},
			"live":    {startedAt: now},
		},
	}
	windowed.pruneWindowsLocked(now)
	if _, ok := windowed.windows["expired"]; ok {
		t.Fatal("pruneWindowsLocked kept an expired window")
	}

	// recordWindowLocked prunes at capacity before inserting.
	full := &jwksValidator{
		refreshCooldown:  time.Minute,
		maxWindowEntries: 2,
		windows: map[string]jwksKidWindow{
			"oldest": {startedAt: now, seq: 1},
			"newer":  {startedAt: now, seq: 2},
		},
	}
	full.recordWindowLocked("third", now)
	if _, ok := full.windows["third"]; !ok {
		t.Fatal("recordWindowLocked did not store the new window")
	}
	if len(full.windows) > full.maxWindowEntries {
		t.Fatalf("window map holds %d entries, want <= %d", len(full.windows), full.maxWindowEntries)
	}

	// evictKeysLocked drops expired keys.
	keys := &jwksValidator{
		keys: map[string]jwksCachedKey{
			"expired": {key: &rsa.PublicKey{}, expiresAt: now.Add(-time.Minute)},
			"live":    {key: &rsa.PublicKey{}, expiresAt: now.Add(time.Minute)},
		},
		maxKeyEntries: 8,
	}
	keys.evictKeysLocked(now)
	if _, ok := keys.keys["expired"]; ok {
		t.Fatal("evictKeysLocked kept an expired key")
	}
}

func TestFetchBoundedDocumentCloseError(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{},
			Body:       closeErrorReader{},
		}, nil
	})}
	body, err := fetchBoundedDocument(context.Background(), client, "https://a.example.test/jwks")
	if err != nil || string(body) != "" {
		t.Fatalf("fetchBoundedDocument = %q %v", body, err)
	}
}

// roundTripFunc adapts a function to http.RoundTripper.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

// closeErrorReader fails on Close, so the fetch's close-error branch is reached.
type closeErrorReader struct{}

func (closeErrorReader) Read([]byte) (int, error) { return 0, io.EOF }
func (closeErrorReader) Close() error             { return errors.New("close failed") }

func TestPostBoundedFormReadFailure(t *testing.T) {
	truncated := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Length", "1024")
		writer.WriteHeader(http.StatusOK)
		if _, err := writer.Write([]byte("short")); err != nil {
			return
		}
	}))
	defer truncated.Close()

	if _, _, err := postBoundedForm(context.Background(), truncated.Client(), truncated.URL, url.Values{"a": {"b"}}); err == nil {
		t.Fatal("a truncated token response was accepted")
	}
}

func TestDiscoveryDocumentUnparseableAndInsecure(t *testing.T) {
	unparseable := httptest.NewTLSServer(serveBytes([]byte("not a discovery document")))
	defer unparseable.Close()
	unparseableProvider, err := NewAutheoryProvider(AutheoryProviderOptions{
		Issuer:       "https://auth.example.test",
		DiscoveryURL: unparseable.URL,
		HTTPClient:   unparseable.Client(),
	})
	if err != nil {
		t.Fatalf("NewAutheoryProvider: %v", err)
	}
	if _, discoveryErr := unparseableProvider.Discovery(context.Background()); discoveryErr == nil {
		t.Fatal("an unparseable discovery document was accepted")
	}

	insecure := httptest.NewTLSServer(serveBytes([]byte(`{"issuer":"https://auth.example.test",` +
		`"authorization_endpoint":"http://auth.example.test/authorize",` +
		`"token_endpoint":"https://auth.example.test/token",` +
		`"jwks_uri":"https://auth.example.test/jwks"}`)))
	defer insecure.Close()
	insecureProvider, err := NewAutheoryProvider(AutheoryProviderOptions{
		Issuer:       "https://auth.example.test",
		DiscoveryURL: insecure.URL,
		HTTPClient:   insecure.Client(),
	})
	if err != nil {
		t.Fatalf("NewAutheoryProvider: %v", err)
	}
	if _, discoveryErr := insecureProvider.Discovery(context.Background()); discoveryErr == nil {
		t.Fatal("a discovery document with a non-https endpoint was accepted")
	}
}

func TestValidatorForConcurrentInsertion(t *testing.T) {
	// Two validations that race on the same expectation set must end up sharing
	// one cached validator: the second insertion observes the first under the lock.
	provider := newFakeProvider(t, oauthprovider.Options{Issuer: "https://auth.example.test"})
	jwksURI := "https://auth.example.test/.well-known/jwks.json"
	expected := TokenExpectations{ExpectedIssuer: "https://auth.example.test"}

	var wait sync.WaitGroup
	start := make(chan struct{})
	for index := 0; index < 32; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			if _, err := provider.validatorFor(jwksURI, expected); err != nil {
				t.Errorf("validatorFor: %v", err)
			}
		}()
	}
	close(start)
	wait.Wait()

	provider.mu.Lock()
	cached := len(provider.validators)
	provider.mu.Unlock()
	if cached != 1 {
		t.Fatalf("concurrent validations cached %d validators, want 1", cached)
	}
}

func TestFetchKeysSkipsOversizedKid(t *testing.T) {
	validN := base64.RawURLEncoding.EncodeToString([]byte{1, 2, 3})
	body := fmt.Sprintf(`{"keys":[{"kty":"RSA","kid":"%s","n":%q,"e":"AQAB"}]}`, strings.Repeat("k", 40), validN)
	server := httptest.NewServer(serveBytes([]byte(body)))
	defer server.Close()

	validator := &jwksValidator{
		jwksURI:       server.URL,
		client:        server.Client(),
		maxKidLength:  4,
		cacheTTL:      time.Minute,
		maxKeyEntries: 8,
		keys:          map[string]jwksCachedKey{},
		now:           func() time.Time { return time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC) },
	}
	if err := validator.fetchKeys(context.Background(), validator.now()); err != nil {
		t.Fatalf("fetchKeys: %v", err)
	}
	if len(validator.keys) != 0 {
		t.Fatalf("an oversized document kid entered the cache: %v", validator.keys)
	}
}
