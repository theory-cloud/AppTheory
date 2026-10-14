// Package oauthprovider is test support: a dependency-free (standard-library
// only) fake upstream OAuth authorization server for exercising provider
// adapters against a real local HTTP server with a real RSA key.
//
// The fake serves an RFC 8414 discovery document, a JWKS, and a token endpoint,
// and it can mint RS256-signed access tokens with the same key. Every
// configurable behavior a provider conformance table needs is reachable through
// Options and Claims:
//
//   - success: the default discovery/JWKS/token responses
//   - error classes: TokenStatus with a TokenBody carrying an OAuth error code
//   - slow/hung: TokenDelay (a delayed response the caller's fetch bound must cut)
//   - rotated refresh: a TokenBody whose refresh_token differs from the one
//     presented (the presented form is recorded as LastTokenRequest)
//   - refresh: RefreshTokenStatus and RefreshTokenBody serve a
//     grant_type=refresh_token response distinct from the code exchange — its own
//     access token, its own upstream refresh token, and its own id_token — so a
//     facade that hides upstream material is observable, while
//     RefreshTokenStages stages the leading refresh responses in call order so a
//     transient upstream failure that clears is observable too; RefreshCallCount
//     and LastRefreshRequest report the refresh calls separately from the total
//     TokenCallCount
//   - oversized body: TokenBodyBytes serves filler that is not JSON, while
//     TokenBodyPaddingBytes serves a well-formed token document whose
//     access_token is itself longer than the caller's cap, so a size bound is
//     observable without the body also being unparseable
//   - missing iss: OmitDiscoveryIssuer on the document, or an empty
//     Claims.Issuer, which omits the token's iss claim
//   - bad signature: Claims.TamperSignature, which corrupts the token signature
//
// Nothing in production imports this package.
package oauthprovider

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Well-known and endpoint paths the fake serves.
const (
	wellKnownAuthorizationServerPath = "/.well-known/oauth-authorization-server"
	wellKnownJWKSPath                = "/.well-known/jwks.json"
	tokenPath                        = "/token"
	authorizePath                    = "/oauth/authorize"
	registrationPath                 = "/register"

	keyID              = "oauthprovider-test-key"
	jsonContentType    = "application/json; charset=utf-8"
	textContentType    = "text/plain; charset=utf-8"
	defaultExpiresIn   = 900
	oversizedChunkSize = 32 * 1024

	// grantTypeRefreshToken is the form value that selects the refresh grant, so
	// the fake can serve that grant a response distinct from the code exchange.
	grantTypeRefreshToken = "refresh_token"
)

// Options configures NewServer.
type Options struct {
	// Issuer is the issuer URL the fake publishes and the origin every endpoint
	// points at. The caller routes that origin to this server's listener with
	// HTTPClient. It must be an absolute URL and is required.
	Issuer string

	// DiscoveryIssuer overrides the issuer the discovery document claims, for a
	// document the adapter must reject. Zero value means Issuer.
	DiscoveryIssuer string

	// OmitDiscoveryIssuer serves a discovery document with no issuer claim.
	OmitDiscoveryIssuer bool

	// RedirectTo answers the discovery endpoint with a 302 to this location.
	RedirectTo string

	// TokenStatus is the token endpoint's status code. Zero means 200.
	TokenStatus int

	// TokenBody is the JSON body the token endpoint returns.
	TokenBody map[string]any

	// TokenBodyBytes serves that many bytes instead of TokenBody, for a body
	// bound that must be enforced. The bytes are filler, so the body is not
	// JSON and any bound it triggers is indistinguishable from a parse failure.
	TokenBodyBytes int

	// TokenBodyPaddingBytes serves a well-formed token document whose
	// access_token value is this many bytes long. It differs from a body that
	// is merely oversized by being valid JSON, so a case that expects an error
	// only while the response cap holds fails once the cap is removed.
	TokenBodyPaddingBytes int

	// TokenDelay delays the token response, for a fetch timeout that must cut it.
	TokenDelay time.Duration

	// RefreshTokenStatus is the status of a grant_type=refresh_token response.
	// Zero means TokenStatus.
	RefreshTokenStatus int

	// RefreshTokenBody is the JSON body of a grant_type=refresh_token response.
	// Nil means TokenBody. It is how a test gives the refresh grant its own
	// access token, its own upstream refresh token, and its own id_token, so a
	// caller that must hide upstream material is observable.
	RefreshTokenBody map[string]any

	// RefreshTokenStages stages the leading grant_type=refresh_token responses in
	// call order: the nth refresh call takes the nth stage, and every later call
	// takes the steady-state response above. A stage whose Body is nil or whose
	// Status is zero falls back to the steady-state value. It exists so a
	// transient upstream failure that clears is observable.
	RefreshTokenStages []RefreshStage

	// Now is the mint clock for iat/exp. Nil means time.Now().UTC.
	Now func() time.Time
}

// RefreshStage is one staged grant_type=refresh_token response.
type RefreshStage struct {
	// Status is the HTTP status. Zero means the steady-state refresh status.
	Status int
	// Body is the JSON body. Nil means the steady-state refresh body.
	Body map[string]any
}

// Claims are the access-token claims MintAccessToken signs. The JSON tags match
// the shared provider conformance fixture's token object, so a fixture row can
// be decoded straight into Claims. An empty Issuer omits the iss claim.
type Claims struct {
	Issuer          string `json:"iss"`
	Audience        string `json:"aud"`
	AuthorizedParty string `json:"azp"`
	Subject         string `json:"sub"`
	Scope           string `json:"scope"`
	ExpiresIn       int    `json:"expires_in"`
	TamperSignature bool   `json:"tamper_signature"`
}

// Server is one running fake upstream.
type Server struct {
	tb     testing.TB
	server *httptest.Server
	key    *rsa.PrivateKey

	origin              string
	issuer              string
	discoveryPath       string
	discoveryIssuer     string
	omitDiscoveryIssuer bool
	redirectTo          string
	tokenStatus         int
	tokenBody           []byte
	tokenBodyBytes      int
	tokenBodyPadding    []byte
	tokenDelay          time.Duration
	refreshStatus       int
	refreshBody         []byte
	refreshStages       []stagedRefreshResponse
	now                 func() time.Time

	closeOnce sync.Once

	mu                 sync.Mutex
	lastTokenRequest   url.Values
	lastRefreshRequest url.Values
	tokenCalls         int
	refreshCalls       int
}

// stagedRefreshResponse is one pre-encoded grant_type=refresh_token response.
type stagedRefreshResponse struct {
	status int
	body   []byte
}

// NewServer starts a real local HTTP server that impersonates the configured
// issuer. It registers Close with the test's cleanup, so a caller that does not
// call Close itself still releases the listener.
func NewServer(tb testing.TB, opts Options) *Server {
	tb.Helper()

	issuer, err := url.Parse(strings.TrimSpace(opts.Issuer))
	if err != nil || issuer.Scheme == "" || issuer.Host == "" {
		tb.Fatalf("oauthprovider: issuer %q must be an absolute URL", opts.Issuer)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		tb.Fatalf("oauthprovider: generate RSA key: %v", err)
	}

	now := opts.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	discoveryIssuer := strings.TrimSpace(opts.DiscoveryIssuer)
	if discoveryIssuer == "" && !opts.OmitDiscoveryIssuer {
		discoveryIssuer = opts.Issuer
	}
	tokenStatus := opts.TokenStatus
	if tokenStatus == 0 {
		tokenStatus = http.StatusOK
	}
	// The refresh grant falls back to the ordinary token response, so a caller
	// that configures nothing keeps the single-response behavior it had before.
	tokenBody := encodeTokenBody(tb, opts.TokenBody)
	refreshStatus := opts.RefreshTokenStatus
	if refreshStatus == 0 {
		refreshStatus = tokenStatus
	}
	refreshBody := tokenBody
	if opts.RefreshTokenBody != nil {
		refreshBody = encodeTokenBody(tb, opts.RefreshTokenBody)
	}

	server := &Server{
		tb:                  tb,
		key:                 key,
		origin:              issuer.Scheme + "://" + issuer.Host,
		issuer:              strings.TrimSpace(opts.Issuer),
		discoveryPath:       strings.TrimRight(issuer.Path, "/") + wellKnownAuthorizationServerPath,
		discoveryIssuer:     discoveryIssuer,
		omitDiscoveryIssuer: opts.OmitDiscoveryIssuer,
		redirectTo:          opts.RedirectTo,
		tokenStatus:         tokenStatus,
		tokenBody:           tokenBody,
		tokenBodyBytes:      opts.TokenBodyBytes,
		tokenBodyPadding:    encodePaddedTokenBody(tb, opts.TokenBodyPaddingBytes),
		tokenDelay:          opts.TokenDelay,
		refreshStatus:       refreshStatus,
		refreshBody:         refreshBody,
		refreshStages:       encodeRefreshStages(tb, opts.RefreshTokenStages, refreshStatus, refreshBody),
		now:                 now,
	}
	server.server = httptest.NewServer(http.HandlerFunc(server.handle))
	tb.Cleanup(server.Close)
	return server
}

// Close stops the server. It is idempotent.
func (s *Server) Close() {
	s.closeOnce.Do(func() {
		s.server.CloseClientConnections()
		s.server.Close()
	})
}

// HTTPClient returns a client that rewrites the configured issuer origin onto
// this server's loopback listener, so an adapter built for the real issuer URL
// reaches the fake. It refuses any other origin, so a redirect to another host
// is never followed to something unintended.
func (s *Server) HTTPClient() *http.Client {
	return &http.Client{
		Transport: &issuerRewriteTransport{
			fromOrigin: s.origin,
			toOrigin:   s.server.URL,
			base:       http.DefaultTransport,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// BaseURL is the loopback listener URL the transport rewrites onto.
func (s *Server) BaseURL() string { return s.server.URL }

// Issuer is the configured issuer URL the fake publishes and every endpoint
// points at.
func (s *Server) Issuer() string { return s.issuer }

// DiscoveryURL is the issuer-relative RFC 8414 discovery URL.
func (s *Server) DiscoveryURL() string { return s.origin + s.discoveryPath }

// JWKSURL is the issuer-relative JWKS URL.
func (s *Server) JWKSURL() string { return s.origin + wellKnownJWKSPath }

// TokenEndpoint is the issuer-relative token endpoint URL.
func (s *Server) TokenEndpoint() string { return s.origin + tokenPath }

// LastTokenRequest returns a copy of the form the token endpoint last received,
// which is how a test observes the material and client a caller presented.
func (s *Server) LastTokenRequest() url.Values {
	s.mu.Lock()
	defer s.mu.Unlock()
	clone := make(url.Values, len(s.lastTokenRequest))
	for name, values := range s.lastTokenRequest {
		clone[name] = append([]string(nil), values...)
	}
	return clone
}

// TokenCallCount reports how many token requests the fake served.
func (s *Server) TokenCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tokenCalls
}

// LastRefreshRequest returns a copy of the form the last grant_type=refresh_token
// request presented, so a test can observe the material and client that refresh
// leg carried.
func (s *Server) LastRefreshRequest() url.Values {
	s.mu.Lock()
	defer s.mu.Unlock()
	clone := make(url.Values, len(s.lastRefreshRequest))
	for name, values := range s.lastRefreshRequest {
		clone[name] = append([]string(nil), values...)
	}
	return clone
}

// RefreshCallCount reports how many grant_type=refresh_token requests the fake
// served, counted separately from the total TokenCallCount, so a facade's
// single-flight rotation is observable.
func (s *Server) RefreshCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refreshCalls
}

// MintAccessToken returns a compact RS256 JWS over claims, signed with the
// fake's key and carrying the kid the fake publishes in its JWKS.
func (s *Server) MintAccessToken(claims Claims) string {
	s.tb.Helper()
	header := map[string]any{"alg": "RS256", "kid": keyID, "typ": "JWT"}
	payload := s.tokenClaims(claims)
	signingInput := encodeSegment(s.tb, header) + "." + encodeSegment(s.tb, payload)

	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, s.key, crypto.SHA256, digest[:])
	if err != nil {
		s.tb.Fatalf("oauthprovider: sign access token: %v", err)
	}
	if claims.TamperSignature && len(signature) > 0 {
		signature[0] ^= 0xff
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func (s *Server) tokenClaims(claims Claims) map[string]any {
	expiresIn := claims.ExpiresIn
	if expiresIn == 0 {
		expiresIn = defaultExpiresIn
	}
	issuedAt := s.now()
	payload := map[string]any{
		"iat": issuedAt.Unix(),
		"exp": issuedAt.Add(time.Duration(expiresIn) * time.Second).Unix(),
	}
	if claims.Issuer != "" {
		payload["iss"] = claims.Issuer
	}
	if claims.Audience != "" {
		payload["aud"] = claims.Audience
	}
	if claims.Subject != "" {
		payload["sub"] = claims.Subject
	}
	if claims.AuthorizedParty != "" {
		payload["azp"] = claims.AuthorizedParty
	}
	if claims.Scope != "" {
		payload["scope"] = claims.Scope
	}
	return payload
}

func (s *Server) handle(writer http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case s.discoveryPath:
		s.handleDiscovery(writer)
	case wellKnownJWKSPath:
		s.handleJWKS(writer)
	case tokenPath:
		s.handleToken(writer, request)
	case authorizePath:
		writeBody(writer, http.StatusOK, textContentType, []byte("authorization endpoint"))
	case registrationPath:
		writeBody(writer, http.StatusOK, jsonContentType, []byte(`{"client_id":"mcp_test_client"}`))
	default:
		http.NotFound(writer, request)
	}
}

func (s *Server) handleDiscovery(writer http.ResponseWriter) {
	if s.redirectTo != "" {
		writer.Header().Set("location", s.redirectTo)
		writer.WriteHeader(http.StatusFound)
		return
	}

	document := map[string]any{
		"authorization_endpoint":                         s.origin + authorizePath,
		"token_endpoint":                                 s.origin + tokenPath,
		"jwks_uri":                                       s.origin + wellKnownJWKSPath,
		"registration_endpoint":                          s.origin + registrationPath,
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"authorization_response_iss_parameter_supported": true,
		"resource_parameter_supported":                   true,
	}
	if !s.omitDiscoveryIssuer {
		document["issuer"] = s.discoveryIssuer
	}
	body, err := json.Marshal(document)
	if err != nil {
		http.Error(writer, "oauthprovider: encode discovery document", http.StatusInternalServerError)
		return
	}
	writeBody(writer, http.StatusOK, jsonContentType, body)
}

func (s *Server) handleJWKS(writer http.ResponseWriter) {
	document := map[string]any{
		"keys": []map[string]any{{
			"kty": "RSA",
			"kid": keyID,
			"use": "sig",
			"alg": "RS256",
			"n":   base64.RawURLEncoding.EncodeToString(s.key.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(s.key.E)).Bytes()),
		}},
	}
	body, err := json.Marshal(document)
	if err != nil {
		http.Error(writer, "oauthprovider: encode jwks", http.StatusInternalServerError)
		return
	}
	writeBody(writer, http.StatusOK, jsonContentType, body)
}

func (s *Server) handleToken(writer http.ResponseWriter, request *http.Request) {
	if err := request.ParseForm(); err != nil {
		http.Error(writer, "oauthprovider: bad token form", http.StatusBadRequest)
		return
	}
	refreshCall := s.recordTokenRequest(request.PostForm)

	if s.tokenDelay > 0 {
		timer := time.NewTimer(s.tokenDelay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-request.Context().Done():
			// The caller's fetch bound cut the request: stop waiting, so cleanup
			// does not block on a hung response.
			return
		}
	}

	if refreshCall > 0 {
		response := s.refreshResponseFor(refreshCall)
		writeBody(writer, response.status, jsonContentType, response.body)
		return
	}
	if s.tokenBodyPadding != nil {
		writeBody(writer, s.tokenStatus, jsonContentType, s.tokenBodyPadding)
		return
	}
	if s.tokenBodyBytes > 0 {
		writer.Header().Set("content-length", strconv.Itoa(s.tokenBodyBytes))
		writeBodyStart(writer, s.tokenStatus, jsonContentType)
		writeRepeated(writer, s.tokenBodyBytes)
		return
	}
	writeBody(writer, s.tokenStatus, jsonContentType, s.tokenBody)
}

// refreshResponseFor returns the staged or steady-state response of the nth
// grant_type=refresh_token call (one-based).
func (s *Server) refreshResponseFor(call int) stagedRefreshResponse {
	index := call - 1
	if index >= 0 && index < len(s.refreshStages) {
		return s.refreshStages[index]
	}
	return stagedRefreshResponse{status: s.refreshStatus, body: s.refreshBody}
}

// recordTokenRequest counts the call and records the form. It returns the
// one-based index of a grant_type=refresh_token call, or zero for any other
// grant, so the caller can select a staged refresh response.
func (s *Server) recordTokenRequest(form url.Values) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokenCalls++
	s.lastTokenRequest = make(url.Values, len(form))
	for name, values := range form {
		s.lastTokenRequest[name] = append([]string(nil), values...)
	}
	if form.Get("grant_type") != grantTypeRefreshToken {
		return 0
	}
	s.refreshCalls++
	s.lastRefreshRequest = make(url.Values, len(form))
	for name, values := range form {
		s.lastRefreshRequest[name] = append([]string(nil), values...)
	}
	return s.refreshCalls
}

// encodeRefreshStages pre-encodes the staged refresh responses, falling back to
// the steady-state status and body for any stage that does not override them.
func encodeRefreshStages(
	tb testing.TB,
	stages []RefreshStage,
	status int,
	body []byte,
) []stagedRefreshResponse {
	tb.Helper()
	if len(stages) == 0 {
		return nil
	}
	encoded := make([]stagedRefreshResponse, 0, len(stages))
	for _, stage := range stages {
		staged := stagedRefreshResponse{status: status, body: body}
		if stage.Status != 0 {
			staged.status = stage.Status
		}
		if stage.Body != nil {
			staged.body = encodeTokenBody(tb, stage.Body)
		}
		encoded = append(encoded, staged)
	}
	return encoded
}

// encodeTokenBody pre-encodes the configured token body, so a handler never
// fails on encoding.
func encodeTokenBody(tb testing.TB, body map[string]any) []byte {
	tb.Helper()
	if body == nil {
		return []byte(`{"token_type":"Bearer"}`)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		tb.Fatalf("oauthprovider: encode token body: %v", err)
	}
	return encoded
}

// encodePaddedTokenBody pre-encodes a valid token document whose access_token
// is paddingBytes long. A non-positive size encodes nothing, which the handler
// reads as "serve the ordinary body".
func encodePaddedTokenBody(tb testing.TB, paddingBytes int) []byte {
	tb.Helper()
	if paddingBytes <= 0 {
		return nil
	}
	encoded, err := json.Marshal(paddedTokenBody{
		AccessToken: strings.Repeat("a", paddingBytes),
		TokenType:   "Bearer",
		ExpiresIn:   defaultExpiresIn,
	})
	if err != nil {
		tb.Fatalf("oauthprovider: encode padded token body: %v", err)
	}
	return encoded
}

// paddedTokenBody is the token document encodePaddedTokenBody serves, in the
// field order a real authorization server would emit.
type paddedTokenBody struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
}

func encodeSegment(tb testing.TB, value map[string]any) string {
	tb.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		tb.Fatalf("oauthprovider: encode JWS segment: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func writeBody(writer http.ResponseWriter, status int, contentType string, body []byte) {
	writer.Header().Set("content-length", strconv.Itoa(len(body)))
	writeBodyStart(writer, status, contentType)
	if _, err := writer.Write(body); err != nil {
		// The test server owns the connection; a failed write just ends the response.
		return
	}
}

func writeBodyStart(writer http.ResponseWriter, status int, contentType string) {
	writer.Header().Set("content-type", contentType)
	writer.WriteHeader(status)
}

// writeRepeated writes size bytes, stopping if the caller closed the connection
// (an oversized body is exactly the case where it will).
func writeRepeated(writer http.ResponseWriter, size int) {
	chunk := make([]byte, oversizedChunkSize)
	for written := 0; written < size; written += len(chunk) {
		if remaining := size - written; remaining < len(chunk) {
			chunk = chunk[:remaining]
		}
		if _, err := writer.Write(chunk); err != nil {
			return
		}
	}
}

// issuerRewriteTransport maps one issuer origin onto the loopback listener and
// refuses every other origin.
type issuerRewriteTransport struct {
	fromOrigin string
	toOrigin   string
	base       http.RoundTripper
}

func (t *issuerRewriteTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL == nil || originOf(request.URL) != strings.ToLower(t.fromOrigin) {
		host := ""
		if request.URL != nil {
			host = request.URL.Host
		}
		return nil, fmt.Errorf("oauthprovider: test transport refused a request to %q", host)
	}
	target, err := url.Parse(t.toOrigin)
	if err != nil {
		return nil, fmt.Errorf("oauthprovider: test transport target: %w", err)
	}
	clone := request.Clone(request.Context())
	clone.URL.Scheme = target.Scheme
	clone.URL.Host = target.Host
	clone.Host = ""
	return t.base.RoundTrip(clone)
}

func originOf(target *url.URL) string {
	return strings.ToLower(target.Scheme + "://" + target.Host)
}
