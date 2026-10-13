package oauthprovider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// fatalTB captures Fatalf without failing the running test, so the fake's
// fail-closed constructor paths can be exercised. Fatalf panics because the
// production code stops executing after it.
type fatalTB struct {
	testing.TB
	onFatal func(format string, args ...any)
}

func (tb fatalTB) Helper() {}

func (tb fatalTB) Fatalf(format string, args ...any) {
	tb.onFatal(format, args...)
	panic("oauthprovider: Fatalf")
}

// doGet issues one GET with a background context and fails the test on a
// transport error.
func doGet(t *testing.T, client *http.Client, rawURL string) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatalf("build GET %s: %v", rawURL, err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", rawURL, err)
	}
	return response
}

// doPostForm issues one urlencoded form POST with a background context.
func doPostForm(t *testing.T, client *http.Client, rawURL string, form url.Values) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(
		context.Background(), http.MethodPost, rawURL, strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatalf("build POST %s: %v", rawURL, err)
	}
	request.Header.Set("content-type", "application/x-www-form-urlencoded")
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", rawURL, err)
	}
	return response
}

// closeBody closes one response body, reporting a close failure.
func closeBody(t *testing.T, response *http.Response) {
	t.Helper()
	if err := response.Body.Close(); err != nil {
		t.Errorf("close response body: %v", err)
	}
}

// readBody reads one response body, reporting a read failure.
func readBody(t *testing.T, response *http.Response) []byte {
	t.Helper()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}
	return body
}

// decodeSegment base64url-decodes and parses one JWS segment.
func decodeSegment(t *testing.T, segment string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		t.Fatalf("decode segment: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("parse segment %q: %v", raw, err)
	}
	return document
}

func TestNewServerRejectsRelativeIssuer(t *testing.T) {
	var message string
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("NewServer did not report the relative issuer")
			}
		}()
		NewServer(fatalTB{TB: t, onFatal: func(format string, args ...any) {
			message = fmt.Sprintf(format, args...)
		}}, Options{Issuer: "auth.example.test"})
	}()
	if !strings.Contains(message, "absolute URL") {
		t.Fatalf("fatal message = %q, want it to name the absolute-URL requirement", message)
	}
}

func TestServerAccessorsAndClose(t *testing.T) {
	server := NewServer(t, Options{Issuer: "  https://auth.example.test/tenant/  "})
	defer server.Close()

	if got := server.Issuer(); got != "https://auth.example.test/tenant/" {
		t.Fatalf("Issuer() = %q", got)
	}
	if got := server.BaseURL(); !strings.HasPrefix(got, "http://127.0.0.1:") {
		t.Fatalf("BaseURL() = %q, want a loopback listener", got)
	}
	if got := server.DiscoveryURL(); got != "https://auth.example.test/tenant/.well-known/oauth-authorization-server" {
		t.Fatalf("DiscoveryURL() = %q", got)
	}
	if got := server.JWKSURL(); got != "https://auth.example.test/.well-known/jwks.json" {
		t.Fatalf("JWKSURL() = %q", got)
	}
	if got := server.TokenEndpoint(); got != "https://auth.example.test/token" {
		t.Fatalf("TokenEndpoint() = %q", got)
	}

	// Close is idempotent.
	server.Close()
	server.Close()
}

// getJSON issues one GET through the fake's origin-rewriting client and decodes
// a JSON object response.
func getJSON(t *testing.T, server *Server, rawURL string) (int, http.Header, map[string]any) {
	t.Helper()
	response := doGet(t, server.HTTPClient(), rawURL)
	defer closeBody(t, response)
	body := readBody(t, response)
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("decode %s body %q: %v", rawURL, body, err)
	}
	return response.StatusCode, response.Header, document
}

func TestDiscoveryDocumentDefault(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test"})
	defer server.Close()

	status, header, document := getJSON(t, server, server.DiscoveryURL())
	if status != http.StatusOK {
		t.Fatalf("discovery status = %d, want 200", status)
	}
	if ct := header.Get("content-type"); ct != jsonContentType {
		t.Fatalf("discovery content-type = %q", ct)
	}
	if document["issuer"] != "https://auth.example.test" {
		t.Fatalf("discovery issuer = %v", document["issuer"])
	}
	if document["token_endpoint"] != "https://auth.example.test/token" {
		t.Fatalf("discovery token_endpoint = %v", document["token_endpoint"])
	}
	if document["jwks_uri"] != "https://auth.example.test/.well-known/jwks.json" {
		t.Fatalf("discovery jwks_uri = %v", document["jwks_uri"])
	}
	methods, ok := document["code_challenge_methods_supported"].([]any)
	if !ok || len(methods) != 1 || methods[0] != "S256" {
		t.Fatalf("discovery code_challenge_methods_supported = %v", document["code_challenge_methods_supported"])
	}
	if document["authorization_response_iss_parameter_supported"] != true {
		t.Fatalf("discovery iss-parameter flag = %v", document["authorization_response_iss_parameter_supported"])
	}
}

func TestDiscoveryDocumentIssuerOverrides(t *testing.T) {
	override := NewServer(t, Options{
		Issuer:          "https://auth.example.test",
		DiscoveryIssuer: "https://other.example.test",
	})
	defer override.Close()
	if _, _, document := getJSON(t, override, override.DiscoveryURL()); document["issuer"] != "https://other.example.test" {
		t.Fatalf("discovery issuer = %v, want the override", document["issuer"])
	}

	omitted := NewServer(t, Options{Issuer: "https://auth.example.test", OmitDiscoveryIssuer: true})
	defer omitted.Close()
	if _, _, document := getJSON(t, omitted, omitted.DiscoveryURL()); document["issuer"] != nil {
		t.Fatalf("discovery issuer = %v, want it omitted", document["issuer"])
	}
}

func TestDiscoveryRedirectIsServed(t *testing.T) {
	server := NewServer(t, Options{
		Issuer:     "https://auth.example.test",
		RedirectTo: "https://auth.example.test/elsewhere",
	})
	defer server.Close()

	// The client refuses redirects, so the 302 is observable as-is.
	response := doGet(t, server.HTTPClient(), server.DiscoveryURL())
	defer closeBody(t, response)
	if response.StatusCode != http.StatusFound {
		t.Fatalf("discovery status = %d, want 302", response.StatusCode)
	}
	if location := response.Header.Get("location"); location != "https://auth.example.test/elsewhere" {
		t.Fatalf("redirect location = %q", location)
	}
}

func TestJWKSDocument(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test"})
	defer server.Close()

	status, _, document := getJSON(t, server, server.JWKSURL())
	if status != http.StatusOK {
		t.Fatalf("jwks status = %d", status)
	}
	keys, ok := document["keys"].([]any)
	if !ok || len(keys) != 1 {
		t.Fatalf("jwks keys = %v", document["keys"])
	}
	key, ok := keys[0].(map[string]any)
	if !ok {
		t.Fatalf("jwks key = %v", keys[0])
	}
	for name, expected := range map[string]string{"kty": "RSA", "kid": keyID, "use": "sig", "alg": "RS256"} {
		if key[name] != expected {
			t.Errorf("jwks key %s = %v, want %q", name, key[name], expected)
		}
	}
	modulus, ok := key["n"].(string)
	if !ok {
		t.Fatalf("jwks modulus is not a string: %v", key["n"])
	}
	if _, err := base64.RawURLEncoding.DecodeString(modulus); err != nil {
		t.Errorf("jwks modulus is not base64url: %v", err)
	}
	if key["e"] != "AQAB" {
		t.Errorf("jwks exponent = %v, want AQAB", key["e"])
	}
}

func TestUnknownPathIsNotFound(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test"})
	defer server.Close()

	response := doGet(t, http.DefaultClient, server.BaseURL()+"/missing")
	defer closeBody(t, response)
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown path status = %d, want 404", response.StatusCode)
	}
}

func TestAuthorizationAndRegistrationEndpoints(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test"})
	defer server.Close()

	authorize := doGet(t, server.HTTPClient(), "https://auth.example.test/oauth/authorize")
	defer closeBody(t, authorize)
	if body := readBody(t, authorize); authorize.StatusCode != http.StatusOK || string(body) != "authorization endpoint" {
		t.Fatalf("authorize = %d %q", authorize.StatusCode, body)
	}

	registration := doGet(t, server.HTTPClient(), "https://auth.example.test/register")
	defer closeBody(t, registration)
	registrationBody := readBody(t, registration)
	if registration.StatusCode != http.StatusOK || !strings.Contains(string(registrationBody), "client_id") {
		t.Fatalf("registration = %d %q", registration.StatusCode, registrationBody)
	}
}

func TestHTTPClientRefusesOtherOrigins(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test"})
	defer server.Close()

	request, err := http.NewRequestWithContext(
		context.Background(), http.MethodGet, "https://elsewhere.example.test/token", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	response, err := server.HTTPClient().Do(request)
	if err == nil {
		closeBody(t, response)
		t.Fatal("the test transport followed a request to another origin")
	}
}

// postForm issues one form POST through the fake's origin-rewriting client.
func postForm(t *testing.T, server *Server, form url.Values) *http.Response {
	t.Helper()
	return doPostForm(t, server.HTTPClient(), server.TokenEndpoint(), form)
}

func TestTokenEndpointDefaultBody(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test"})
	defer server.Close()

	if calls := server.TokenCallCount(); calls != 0 {
		t.Fatalf("token calls before any request = %d", calls)
	}
	response := postForm(t, server, url.Values{"grant_type": {"authorization_code"}, "code": {"upstream-code"}})
	defer closeBody(t, response)
	body := readBody(t, response)
	if response.StatusCode != http.StatusOK || string(body) != `{"token_type":"Bearer"}` {
		t.Fatalf("default token response = %d %q", response.StatusCode, body)
	}
	if calls := server.TokenCallCount(); calls != 1 {
		t.Fatalf("token calls = %d, want 1", calls)
	}
	last := server.LastTokenRequest()
	if last.Get("grant_type") != "authorization_code" || last.Get("code") != "upstream-code" {
		t.Fatalf("last token request = %v", last)
	}
	// LastTokenRequest returns a copy: mutating it cannot corrupt the recorded form.
	last.Set("code", "mutated")
	if server.LastTokenRequest().Get("code") != "upstream-code" {
		t.Fatal("LastTokenRequest handed out the recorded form instead of a copy")
	}
}

func TestTokenEndpointConfiguredBodyAndStatus(t *testing.T) {
	server := NewServer(t, Options{
		Issuer:      "https://auth.example.test",
		TokenStatus: http.StatusBadRequest,
		TokenBody: map[string]any{
			"error":             "invalid_grant",
			"error_description": "UPSTREAM-SECRET-MARKER",
		},
	})
	defer server.Close()

	response := postForm(t, server, url.Values{"grant_type": {"refresh_token"}})
	defer closeBody(t, response)
	body := readBody(t, response)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("token status = %d, want 400", response.StatusCode)
	}
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("decode token error body %q: %v", body, err)
	}
	if document["error"] != "invalid_grant" {
		t.Fatalf("token error body = %v", document)
	}
}

func TestTokenEndpointRotatedRefreshToken(t *testing.T) {
	server := NewServer(t, Options{
		Issuer: "https://auth.example.test",
		TokenBody: map[string]any{
			"access_token":  "rotated-access-token",
			"refresh_token": "rotated-refresh-token",
			"token_type":    "Bearer",
			"expires_in":    900,
		},
	})
	defer server.Close()

	response := postForm(t, server, url.Values{"refresh_token": {"presented-refresh-token"}})
	defer func() {
		if err := response.Body.Close(); err != nil {
			t.Errorf("close response body: %v", err)
		}
	}()
	body := readBody(t, response)
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("decode token body %q: %v", body, err)
	}
	if document["refresh_token"] != "rotated-refresh-token" {
		t.Fatalf("rotated refresh_token = %v", document["refresh_token"])
	}
	if presented := server.LastTokenRequest().Get("refresh_token"); presented != "presented-refresh-token" {
		t.Fatalf("recorded refresh_token = %q", presented)
	}
}

func TestTokenEndpointDelayIsServed(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test", TokenDelay: 40 * time.Millisecond})
	defer server.Close()

	started := time.Now()
	response := postForm(t, server, url.Values{"grant_type": {"authorization_code"}})
	defer closeBody(t, response)
	if elapsed := time.Since(started); elapsed < 25*time.Millisecond {
		t.Fatalf("token response returned after %s, want it delayed", elapsed)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("delayed token status = %d", response.StatusCode)
	}
}

func TestTokenEndpointDelayIsCutByTheCallerBound(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test", TokenDelay: 10 * time.Second})
	defer server.Close()

	client := server.HTTPClient()
	client.Timeout = 150 * time.Millisecond
	request, err := http.NewRequestWithContext(
		context.Background(), http.MethodPost, server.TokenEndpoint(), strings.NewReader("grant_type=authorization_code"))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("content-type", "application/x-www-form-urlencoded")
	response, err := client.Do(request)
	if err == nil {
		closeBody(t, response)
		t.Fatal("a delayed token response survived the caller's bound")
	}
}

func TestTokenEndpointOversizedFillerBody(t *testing.T) {
	const size = 100_000
	server := NewServer(t, Options{Issuer: "https://auth.example.test", TokenBodyBytes: size})
	defer server.Close()

	response := postForm(t, server, url.Values{"grant_type": {"authorization_code"}})
	defer closeBody(t, response)
	body := readBody(t, response)
	if len(body) != size {
		t.Fatalf("oversized body length = %d, want %d", len(body), size)
	}
	if response.Header.Get("content-length") != fmt.Sprintf("%d", size) {
		t.Fatalf("oversized content-length = %q", response.Header.Get("content-length"))
	}
}

func TestTokenEndpointOversizedPaddingIsValidJSON(t *testing.T) {
	const padding = 4096
	server := NewServer(t, Options{Issuer: "https://auth.example.test", TokenBodyPaddingBytes: padding})
	defer server.Close()

	response := postForm(t, server, url.Values{"grant_type": {"authorization_code"}})
	defer func() {
		if err := response.Body.Close(); err != nil {
			t.Errorf("close response body: %v", err)
		}
	}()
	body := readBody(t, response)
	var document paddedTokenBody
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("padded body is not valid JSON: %v", err)
	}
	if len(document.AccessToken) != padding {
		t.Fatalf("padded access_token length = %d, want %d", len(document.AccessToken), padding)
	}
	if document.TokenType != "Bearer" || document.ExpiresIn != defaultExpiresIn {
		t.Fatalf("padded token body = %+v", document)
	}
}

func TestTokenEndpointRejectsMalformedForm(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test"})
	defer server.Close()

	// A body that is not a valid urlencoded form makes ParseForm fail, which the
	// endpoint reports as a bad request and never records.
	request, err := http.NewRequestWithContext(
		context.Background(), http.MethodPost, server.BaseURL()+tokenPath, strings.NewReader("grant_type=%zz"))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("content-type", "application/x-www-form-urlencoded")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("malformed token request: %v", err)
	}
	defer closeBody(t, response)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("malformed form status = %d, want 400", response.StatusCode)
	}
	if calls := server.TokenCallCount(); calls != 0 {
		t.Fatalf("malformed form was recorded as a token call: %d", calls)
	}
}

func TestMintAccessToken(t *testing.T) {
	at := time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC)
	server := NewServer(t, Options{Issuer: "https://auth.example.test", Now: func() time.Time { return at }})
	defer server.Close()

	token := server.MintAccessToken(Claims{
		Issuer:          "https://auth.example.test",
		Audience:        "https://mcp.example.test/mcp",
		AuthorizedParty: "facade-client",
		Subject:         "user-1",
		Scope:           "mcp:tools",
	})
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		t.Fatalf("token has %d segments, want 3", len(segments))
	}

	header := decodeSegment(t, segments[0])
	if header["alg"] != "RS256" || header["kid"] != keyID || header["typ"] != "JWT" {
		t.Fatalf("token header = %v", header)
	}
	payload := decodeSegment(t, segments[1])
	if payload["iss"] != "https://auth.example.test" || payload["sub"] != "user-1" ||
		payload["aud"] != "https://mcp.example.test/mcp" || payload["azp"] != "facade-client" ||
		payload["scope"] != "mcp:tools" {
		t.Fatalf("token payload = %v", payload)
	}
	if payload["iat"] != float64(at.Unix()) {
		t.Fatalf("token iat = %v, want %d", payload["iat"], at.Unix())
	}
	if payload["exp"] != float64(at.Add(defaultExpiresIn*time.Second).Unix()) {
		t.Fatalf("token exp = %v", payload["exp"])
	}
	if _, err := base64.RawURLEncoding.DecodeString(segments[2]); err != nil {
		t.Fatalf("token signature is not base64url: %v", err)
	}
}

func TestMintAccessTokenOmitsEmptyClaims(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test"})
	defer server.Close()

	token := server.MintAccessToken(Claims{ExpiresIn: 60})
	payload := decodeSegment(t, strings.Split(token, ".")[1])
	for _, absent := range []string{"iss", "aud", "sub", "azp", "scope"} {
		if _, ok := payload[absent]; ok {
			t.Errorf("payload carries %q for an empty claim: %v", absent, payload)
		}
	}
}

func TestMintAccessTokenTamperedSignature(t *testing.T) {
	server := NewServer(t, Options{Issuer: "https://auth.example.test"})
	defer server.Close()

	claims := Claims{Issuer: "https://auth.example.test", Subject: "user-1", ExpiresIn: 60}
	honest := server.MintAccessToken(claims)
	claims.TamperSignature = true
	tampered := server.MintAccessToken(claims)

	honestSegments := strings.Split(honest, ".")
	tamperedSegments := strings.Split(tampered, ".")
	if honestSegments[0] != tamperedSegments[0] || honestSegments[1] != tamperedSegments[1] {
		t.Fatal("tampering changed the signing input, not just the signature")
	}
	if honestSegments[2] == tamperedSegments[2] {
		t.Fatal("tampered signature equals the honest signature")
	}
}

func TestIssuerRewriteTransportTargetFailure(t *testing.T) {
	// A transport whose rewrite target refuses connections surfaces the
	// underlying round-trip failure rather than silently succeeding.
	transport := &issuerRewriteTransport{
		fromOrigin: "https://auth.example.test",
		toOrigin:   "https://127.0.0.1:1",
		base:       http.DefaultTransport,
	}
	client := &http.Client{Transport: transport}
	request, err := http.NewRequestWithContext(
		context.Background(), http.MethodGet, "https://auth.example.test/token", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	response, err := client.Do(request)
	if err == nil {
		closeBody(t, response)
		t.Fatal("a connection to the refused rewrite target unexpectedly succeeded")
	}
}

func TestOriginOfNormalizesCase(t *testing.T) {
	parsed, err := url.Parse("HTTPS://AUTH.Example.TEST/token")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := originOf(parsed); got != "https://auth.example.test" {
		t.Fatalf("originOf = %q", got)
	}
}

// failingResponseWriter fails every body write, so the fake's write-error
// branches are exercised without a real socket.
type failingResponseWriter struct {
	header http.Header
}

func (w *failingResponseWriter) Header() http.Header {
	if w.header == nil {
		w.header = http.Header{}
	}
	return w.header
}

func (w *failingResponseWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}

func (w *failingResponseWriter) WriteHeader(int) {}

func TestWriteHelpersReportWriteFailure(t *testing.T) {
	writer := &failingResponseWriter{}
	writeBody(writer, http.StatusOK, jsonContentType, []byte("body"))
	if writer.Header().Get("content-type") != jsonContentType {
		t.Fatalf("writeBody content-type = %q", writer.Header().Get("content-type"))
	}

	// A short remainder forces the final-chunk branch and the write error.
	writeRepeated(&failingResponseWriter{}, 100)
	writeRepeated(&failingResponseWriter{}, oversizedChunkSize*2)
	writeBodyStart(&failingResponseWriter{}, http.StatusAccepted, textContentType)
	writeBodyStart(&failingResponseWriter{}, http.StatusOK, jsonContentType)
}

func TestEncodeHelpers(t *testing.T) {
	if body := encodeTokenBody(t, nil); string(body) != `{"token_type":"Bearer"}` {
		t.Fatalf("encodeTokenBody(nil) = %q", body)
	}
	if body := encodeTokenBody(t, map[string]any{"a": 1}); string(body) != `{"a":1}` {
		t.Fatalf("encodeTokenBody = %q", body)
	}
	if padded := encodePaddedTokenBody(t, 0); padded != nil {
		t.Fatalf("encodePaddedTokenBody(0) = %q, want nil", padded)
	}
	if padded := encodePaddedTokenBody(t, 4); !strings.Contains(string(padded), `"access_token":"aaaa"`) {
		t.Fatalf("encodePaddedTokenBody = %q", padded)
	}
	segment := encodeSegment(t, map[string]any{"alg": "RS256"})
	if decoded := decodeSegment(t, segment); decoded["alg"] != "RS256" {
		t.Fatalf("encodeSegment round trip = %v", decoded)
	}
}
