package oauth

import (
	"errors"
	"net/http"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
)

// This file closes the small, still-uncovered branches of the pre-existing
// runtime/oauth helpers the provider work depends on. Every case here is a
// fail-closed branch, so the assertions check the refusal, not just execution.

func TestPKCEInvalidVerifierPaths(t *testing.T) {
	if _, err := NewPKCECodeVerifier(); err != nil {
		t.Fatalf("NewPKCECodeVerifier: %v", err)
	}
	if err := ValidatePKCECodeVerifier("too-short"); err == nil {
		t.Fatal("a short verifier was accepted")
	}
	if _, err := PKCEChallengeS256("too-short"); err == nil {
		t.Fatal("a short verifier produced a challenge")
	}
	if _, err := PKCEVerifyS256("too-short", "challenge"); err == nil {
		t.Fatal("a short verifier was verified")
	}
}

func TestOpaqueTokenGeneration(t *testing.T) {
	token, err := NewOpaqueToken()
	if err != nil {
		t.Fatalf("NewOpaqueToken: %v", err)
	}
	if len(token) != 43 {
		t.Fatalf("opaque token length = %d, want 43", len(token))
	}
}

func TestJSONBytesHandlerMarshalFailure(t *testing.T) {
	handler := jsonBytesHandler(func() ([]byte, error) { return nil, errors.New("marshal boom") })
	response, err := handler(nil)
	if err != nil {
		t.Fatalf("handler error = %v", err)
	}
	if response.Status != http.StatusInternalServerError {
		t.Fatalf("marshal-failure status = %d, want 500", response.Status)
	}
}

func TestAuthorizationServerMetadataRejectsRelativeIssuer(t *testing.T) {
	if _, err := NewAuthorizationServerMetadata("auth.example.test"); err == nil {
		t.Fatal("a relative issuer was accepted")
	}
}

func TestDCRHelperEdges(t *testing.T) {
	if allowedRedirectURIs(nil) != nil {
		t.Fatal("an empty allow-list must be nil")
	}
	withBlank := allowedRedirectURIs([]string{"", "https://claude.ai/api/mcp/auth_callback"})
	if len(withBlank) != 1 {
		t.Fatalf("allow-list = %v", withBlank)
	}
	if allowedRedirectURIs([]string{"", "   "}) != nil {
		t.Fatal("an all-blank allow-list must be nil")
	}
	if err := validateTokenEndpointAuthMethod("client_secret_basic", false); err != nil {
		t.Fatalf("a policy that does not require a public client was enforced: %v", err)
	}
	if err := validateGrantTypes(nil, true); err != nil {
		t.Fatalf("an omitted grant_types list was rejected: %v", err)
	}
	normalized := normalizeStringList([]string{" b ", "", "a"})
	if len(normalized) != 2 || normalized[0] != "a" || normalized[1] != "b" {
		t.Fatalf("normalizeStringList = %v", normalized)
	}
	if err := validateTokenEndpointAuthMethod("", true); err != nil {
		t.Fatalf("a blank auth method was not defaulted to none: %v", err)
	}
	if err := validateGrantTypes([]string{"authorization_code"}, true); err == nil {
		t.Fatal("a grant_types list without refresh_token was accepted")
	}
}

func TestBearerValidatorRouteDerivedRequirements(t *testing.T) {
	records := []BearerTokenRecord{{Token: "route-token", Audience: "https://aud.example.test"}}

	resolved := NewMemoryBearerTokenValidator(records, BearerTokenValidationOptions{
		RequiredAudienceFunc: func(*apptheory.Context) (string, error) { return "https://aud.example.test", nil },
	})
	if _, err := resolved(nil, "route-token"); err != nil {
		t.Fatalf("route-derived audience rejected a matching token: %v", err)
	}

	audienceFailure := NewMemoryBearerTokenValidator(records, BearerTokenValidationOptions{
		RequiredAudienceFunc: func(*apptheory.Context) (string, error) { return "", errors.New("audience boom") },
	})
	if _, err := audienceFailure(nil, "route-token"); err == nil {
		t.Fatal("a failing audience resolver was ignored")
	}

	scopeFailure := NewMemoryBearerTokenValidator(records, BearerTokenValidationOptions{
		RequiredScopesFunc: func(*apptheory.Context) ([]string, error) { return nil, errors.New("scope boom") },
	})
	if _, err := scopeFailure(nil, "route-token"); err == nil {
		t.Fatal("a failing scope resolver was ignored")
	}
}

func TestBearerTokenValidatorDefaultsAndHeaderParsing(t *testing.T) {
	// A validator built without a clock falls back to wall time; a live token
	// therefore validates.
	validator := NewMemoryBearerTokenValidator([]BearerTokenRecord{{
		Token:     "live-token",
		Subject:   "user-1",
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}}, BearerTokenValidationOptions{})
	if _, err := validator(nil, "live-token"); err != nil {
		t.Fatalf("live token rejected by the default clock: %v", err)
	}

	if _, err := BearerTokenFromHeaders(map[string][]string{"authorization": {"Basic abc"}}); !errors.Is(err, ErrInvalidAuthorizationHeader) {
		t.Fatalf("non-bearer scheme error = %v", err)
	}
	if _, err := BearerTokenFromHeaders(map[string][]string{"authorization": {"Bearer "}}); !errors.Is(err, ErrInvalidAuthorizationHeader) {
		t.Fatalf("blank token error = %v", err)
	}
}

func TestResolvedResourceMetadataURLFallbacks(t *testing.T) {
	derived := resolvedResourceMetadataURL(nil, RequireBearerTokenOptions{
		ResourceMetadataURLFunc: func(*apptheory.Context) (string, error) {
			return "", errors.New("resolver boom")
		},
	})
	if derived != "" {
		t.Fatalf("failing resolver = %q, want empty", derived)
	}
	if got := resolvedResourceMetadataURL(nil, RequireBearerTokenOptions{}); got != "" {
		t.Fatalf("nil context without options = %q, want empty", got)
	}
}

func TestProtectedResourceMetadataHandlerAndMarshal(t *testing.T) {
	metadata, err := NewProtectedResourceMetadata("https://mcp.example.test/mcp", []string{"https://auth.example.test"})
	if err != nil {
		t.Fatalf("NewProtectedResourceMetadata: %v", err)
	}
	encoded, err := metadata.MarshalJSONBytes()
	if err != nil {
		t.Fatalf("MarshalJSONBytes: %v", err)
	}
	if len(encoded) == 0 {
		t.Fatal("MarshalJSONBytes returned no bytes")
	}

	response, err := ProtectedResourceMetadataHandler(metadata)(nil)
	if err != nil {
		t.Fatalf("handler error = %v", err)
	}
	if response.Status != http.StatusOK {
		t.Fatalf("metadata handler status = %d, want 200", response.Status)
	}
}

func TestRegisterMCPServerRejectsMissingInputs(t *testing.T) {
	config := MCPServerConfig{
		AuthorizationServerIssuer: "https://auth.example.test",
		JWKSURI:                   "https://auth.example.test/.well-known/jwks.json",
	}
	if err := RegisterMCPServer(nil, func(*apptheory.Context) (*apptheory.Response, error) { return nil, nil }, config); err == nil {
		t.Fatal("a nil secure app was accepted")
	}
	app := apptheory.NewSecure(apptheory.SecureOptions{})
	if err := RegisterMCPServer(app, nil, config); err == nil {
		t.Fatal("a nil MCP handler was accepted")
	}
}

func TestAllowedRequestHostEdges(t *testing.T) {
	if allowedRequestHost("not-a-url", nil) {
		t.Fatal("an unparseable origin was allowed")
	}
	if !allowedRequestHost("https://mcp.example.test", []string{"mcp.example.test"}) {
		t.Fatal("an allow-listed host was refused")
	}
	if allowedRequestHost("https://mcp.example.test", []string{"other.example.test"}) {
		t.Fatal("an unlisted host was allowed")
	}
}

func TestJSONResponseMarshalFailure(t *testing.T) {
	if _, err := jsonResponse(http.StatusOK, make(chan int)); err == nil {
		t.Fatal("an unmarshalable value was encoded")
	}
}

func TestAllowedHostnameNormalizationEdges(t *testing.T) {
	for name, raw := range map[string]string{
		"blank":       "  ",
		"has_slash":   "https://mcp.example.test/mcp",
		"has_query":   "mcp.example.test?x=1",
		"unparseable": "%zz",
	} {
		if _, ok := normalizeAllowedHostname(raw); ok {
			t.Errorf("%s: %q was accepted", name, raw)
		}
	}
	// A lone dot canonicalizes to an empty hostname.
	if _, ok := normalizeAllowedHostname("."); ok {
		t.Fatal("a bare dot was accepted as a hostname")
	}
	// A non-default port is preserved.
	withPort, ok := normalizeAllowedHostname("Example.Test:8443")
	if !ok || withPort != "example.test:8443" {
		t.Fatalf("normalizeAllowedHostname with port = %q %t", withPort, ok)
	}
	// The default HTTPS port is dropped.
	withoutPort, ok := normalizeAllowedHostname("EXAMPLE.test:443")
	if !ok || withoutPort != "example.test" {
		t.Fatalf("normalizeAllowedHostname default port = %q %t", withoutPort, ok)
	}
	if got := canonicalAllowedHostname("::1"); got != "[::1]" {
		t.Fatalf("canonicalAllowedHostname(IPv6) = %q", got)
	}
}

func TestNormalizeRequestOriginAuthorityEdges(t *testing.T) {
	if _, ok := NormalizeRequestOrigin("https://./"); ok {
		t.Fatal("a bare-dot authority was accepted")
	}
	ipv6, ok := NormalizeRequestOrigin("https://[::1]/")
	if !ok || ipv6 != "https://[::1]" {
		t.Fatalf("IPv6 origin = %q %t", ipv6, ok)
	}
	if _, ok := NormalizeRequestOrigin("https://user@mcp.example.test/"); ok {
		t.Fatal("a userinfo-bearing origin was accepted")
	}
	if got := defaultPortForScheme("ftp"); got != "" {
		t.Fatalf("defaultPortForScheme(ftp) = %q", got)
	}
}

func TestProtectedResourceWWWAuthenticateWithoutURL(t *testing.T) {
	if got := ProtectedResourceWWWAuthenticate("   "); got != "Bearer" {
		t.Fatalf("ProtecteResourceWWWAuthenticate(blank) = %q", got)
	}
}

func TestRFC9728ResourceMetadataURLRootPath(t *testing.T) {
	root, ok := RFC9728ResourceMetadataURL("https://api.example.test")
	if !ok || root != "https://api.example.test"+protectedResourceMetadataPath {
		t.Fatalf("root resource metadata URL = %q %t", root, ok)
	}
}
