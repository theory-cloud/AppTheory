package main

// A real local authorization server for the example, co-hosted by the Lambda
// handler as an in-process oauth.Provider plus one HTTP authorize endpoint.
//
// It exists because no local OIDC provider path ships with the local runner:
// the runner serves the application under test, not an identity provider. This
// is a complete OAuth 2.1 authorization-code + PKCE + rotating-refresh server
// with real RS256 signing, a real JWKS, real single-use codes, and real
// refresh-token rotation with reuse detection. Nothing here is a shortcut over
// an HTTP hop the facade would otherwise make: the facade calls the provider
// interface in process, exactly as it would call a provider adapter that talks
// to Autheory in a deployment. TMS proves the Autheory path against the same
// facade; this example proves the facade's own policy over real HTTP locally.
//
// The upstream's reuse detection is deliberately strict (a superseded refresh
// token is a terminal invalid_grant and revokes the grant), so every row that
// exercises normal client behavior also proves the facade never presents
// material the upstream has already rotated.

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
)

const (
	upstreamKeyID = "apptheory-local-mcp-example-key"

	authorizationCodeLifetime = 2 * time.Minute
)

// localUpstream is the example's authorization server and oauth.Provider.
type localUpstream struct {
	issuer        string
	publicBaseURL string
	clientID      string
	callback      string
	subject       string
	scope         string
	accessTTL     time.Duration
	now           func() time.Time
	key           *rsa.PrivateKey

	mu        sync.Mutex
	codes     map[string]*upstreamCode
	grants    map[string]*upstreamGrant
	refresh   map[string]*upstreamRefresh
	issued    int
	refreshed int
	reused    int
}

// upstreamCode is one single-use authorization code.
type upstreamCode struct {
	challenge   string
	redirectURI string
	resource    string
	scope       string
	subject     string
	expiresAt   time.Time
}

// upstreamGrant is one refresh family at the upstream: the grant every refresh
// token of one authorization belongs to.
type upstreamGrant struct {
	id         string
	subject    string
	resource   string
	scope      string
	revoked    bool
	generation int
}

// upstreamRefresh is one refresh token. A token whose successor has been minted
// is superseded: presenting it again is reuse.
type upstreamRefresh struct {
	grantID    string
	superseded bool
}

// upstreamMetadata is the discovery document the provider returns.
func (u *localUpstream) discoveryDocument() map[string]any {
	return map[string]any{
		"issuer":                                         u.issuer,
		"authorization_endpoint":                         u.issuer + "/authorize",
		"token_endpoint":                                 u.issuer + "/token",
		"jwks_uri":                                       u.issuer + "/jwks.json",
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"authorization_response_iss_parameter_supported": true,
		"resource_parameter_supported":                   true,
	}
}

// Discovery returns the upstream metadata the facade pins.
func (u *localUpstream) Discovery(context.Context) (*oauth.ProviderMetadata, error) {
	return &oauth.ProviderMetadata{
		Issuer:                        u.issuer,
		AuthorizationEndpoint:         u.issuer + "/authorize",
		TokenEndpoint:                 u.issuer + "/token",
		JWKSURI:                       u.issuer + "/jwks.json",
		CodeChallengeMethodsSupported: []string{"S256"},
		AuthorizationResponseIssParameterSupported: true,
		ResourceParameterSupported:                 true,
	}, nil
}

// AuthorizationURL builds the URL the client's browser is sent to. The example
// upstream auto-approves at that endpoint: there is no human at the keyboard in
// a local run, and the consent decision is the example's own test seam.
func (u *localUpstream) AuthorizationURL(req oauth.AuthorizationRequest) (string, error) {
	if req.UpstreamClientID != u.clientID {
		return "", fmt.Errorf("upstream: unknown client %q", req.UpstreamClientID)
	}
	if strings.TrimSpace(req.CallbackURL) != u.callback {
		return "", fmt.Errorf("upstream: callback %q is not registered", req.CallbackURL)
	}
	target, err := url.Parse(u.issuer + "/authorize")
	if err != nil {
		return "", err
	}
	query := target.Query()
	query.Set("client_id", u.clientID)
	query.Set("redirect_uri", req.CallbackURL)
	query.Set("response_type", "code")
	query.Set("code_challenge", req.CodeChallenge)
	query.Set("code_challenge_method", req.CodeChallengeMethod)
	query.Set("state", req.State)
	if strings.TrimSpace(req.Resource) != "" {
		query.Set("resource", req.Resource)
	}
	query.Set("scope", strings.Join(req.Scopes, " "))
	target.RawQuery = query.Encode()
	return target.String(), nil
}

// ExchangeCode performs the server-side code exchange with real PKCE checking.
func (u *localUpstream) ExchangeCode(_ context.Context, req oauth.CodeExchangeRequest) (*oauth.TokenSet, error) {
	if req.UpstreamClientID != u.clientID {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidRequest, "exchange_code", "unknown client")
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	code, ok := u.codes[req.Code]
	if !ok {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "exchange_code", "unknown code")
	}
	if u.now().After(code.expiresAt) {
		delete(u.codes, req.Code)
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "exchange_code", "expired code")
	}
	if code.redirectURI != req.CallbackURL {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "exchange_code", "redirect mismatch")
	}
	if !pkceMatches(req.CodeVerifier, code.challenge) {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "exchange_code", "pkce mismatch")
	}
	delete(u.codes, req.Code)
	grant := &upstreamGrant{
		id:         opaqueToken(),
		subject:    code.subject,
		resource:   code.resource,
		scope:      code.scope,
		generation: 1,
	}
	u.grants[grant.id] = grant
	refresh := opaqueToken()
	u.refresh[refresh] = &upstreamRefresh{grantID: grant.id, superseded: false}
	return u.tokenSetLocked(grant, refresh), nil
}

// Refresh rotates the presented refresh token. A superseded token is reuse: the
// grant is revoked and the caller gets invalid_grant, which is the terminal
// class the facade turns into one re-authorize response for the client.
func (u *localUpstream) Refresh(_ context.Context, req oauth.RefreshRequest) (*oauth.TokenSet, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	token, ok := u.refresh[req.RefreshMaterial]
	if !ok {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "refresh", "unknown refresh token")
	}
	grant := u.grants[token.grantID]
	if grant == nil || grant.revoked {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "refresh", "grant revoked")
	}
	if token.superseded {
		u.reused++
		grant.revoked = true
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "refresh", "refresh token reuse")
	}
	token.superseded = true
	refresh := opaqueToken()
	u.refresh[refresh] = &upstreamRefresh{grantID: grant.id}
	grant.generation++
	u.refreshed++
	return u.tokenSetLocked(grant, refresh), nil
}

// ValidateAccessToken verifies the facade's server-side exchange result.
func (u *localUpstream) ValidateAccessToken(_ context.Context, token string, expected oauth.TokenExpectations) (*oauth.TokenClaims, error) {
	claims, err := u.verifyAccessToken(token)
	if err != nil {
		return nil, err
	}
	if expected.ExpectedIssuer != "" && claims.issuer != expected.ExpectedIssuer {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "validate", "issuer mismatch")
	}
	if expected.ExpectedAudience != "" && claims.audience != expected.ExpectedAudience {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "validate", "audience mismatch")
	}
	if len(expected.AllowedAuthorizedParties) > 0 && !containsString(expected.AllowedAuthorizedParties, claims.authorizedParty) {
		return nil, oauth.NewProviderError(oauth.ProviderInvalidGrant, "validate", "authorized party mismatch")
	}
	return &oauth.TokenClaims{
		Subject:         claims.subject,
		Audience:        claims.audience,
		Scopes:          strings.Fields(claims.scope),
		ExpiresAt:       claims.expiresAt,
		AuthorizedParty: claims.authorizedParty,
	}, nil
}

// authorize handles GET /_upstream/authorize: it validates the registered
// client and redirect, mints a single-use code bound to the PKCE challenge, and
// redirects to the facade callback with the RFC 9207 iss parameter.
func (u *localUpstream) authorize(ctx *apptheory.Context) (*apptheory.Response, error) {
	query := ctx.Request.Query
	get := func(name string) string {
		if values := query[name]; len(values) > 0 {
			return values[0]
		}
		return ""
	}
	if get("client_id") != u.clientID {
		return textResponse(http.StatusBadRequest, "unknown client"), nil
	}
	if get("redirect_uri") != u.callback {
		return textResponse(http.StatusBadRequest, "unregistered redirect_uri"), nil
	}
	if get("response_type") != "code" {
		return textResponse(http.StatusBadRequest, "unsupported response_type"), nil
	}
	challenge := get("code_challenge")
	if challenge == "" || get("code_challenge_method") != "S256" {
		return textResponse(http.StatusBadRequest, "pkce required"), nil
	}
	code := opaqueToken()
	u.mu.Lock()
	u.codes[code] = &upstreamCode{
		challenge:   challenge,
		redirectURI: get("redirect_uri"),
		resource:    get("resource"),
		scope:       get("scope"),
		subject:     u.subject,
		expiresAt:   u.now().Add(authorizationCodeLifetime),
	}
	u.mu.Unlock()
	target, err := url.Parse(get("redirect_uri"))
	if err != nil {
		return nil, err
	}
	redirect := target.Query()
	redirect.Set("code", code)
	redirect.Set("state", get("state"))
	redirect.Set("iss", u.issuer)
	target.RawQuery = redirect.Encode()
	return redirectResponse(target.String()), nil
}

// jwks serves the public key the access tokens are signed with.
func (u *localUpstream) jwks() (any, error) {
	return map[string]any{
		"keys": []map[string]any{{
			"kty": "RSA",
			"kid": upstreamKeyID,
			"use": "sig",
			"alg": "RS256",
			"n":   base64.RawURLEncoding.EncodeToString(u.key.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(u.key.E)).Bytes()),
		}},
	}, nil
}

// tokenSetLocked mints the access token and returns the token set for a grant.
func (u *localUpstream) tokenSetLocked(grant *upstreamGrant, refresh string) *oauth.TokenSet {
	access := u.mintAccessToken(accessClaims{
		issuer:          u.issuer,
		audience:        grant.resource,
		subject:         grant.subject,
		authorizedParty: u.clientID,
		scope:           grant.scope,
		expiresIn:       u.accessTTL,
	})
	u.issued++
	return &oauth.TokenSet{
		AccessToken:  access,
		RefreshToken: refresh,
		TokenType:    "Bearer",
		ExpiresIn:    int(u.accessTTL / time.Second),
		Scope:        grant.scope,
	}
}

// accessClaims are the claims one minted access token carries.
type accessClaims struct {
	issuer          string
	audience        string
	subject         string
	authorizedParty string
	scope           string
	expiresIn       time.Duration
}

// verifiedClaims is the parsed claim subset the example validates.
type verifiedClaims struct {
	issuer          string
	audience        string
	subject         string
	authorizedParty string
	scope           string
	expiresAt       time.Time
}

// mintAccessToken signs a compact RS256 JWS with the example's key.
func (u *localUpstream) mintAccessToken(claims accessClaims) string {
	issuedAt := u.now()
	header := map[string]any{"alg": "RS256", "kid": upstreamKeyID, "typ": "JWT"}
	payload := map[string]any{
		"iss": claims.issuer,
		"aud": claims.audience,
		"sub": claims.subject,
		"azp": claims.authorizedParty,
		"iat": issuedAt.Unix(),
		"exp": issuedAt.Add(claims.expiresIn).Unix(),
		// A unique id per minted token: RS256 over identical claims is
		// deterministic, and two rotations inside one second must still hand the
		// client two distinct credentials, as a real authorization server does.
		"jti": opaqueToken(),
	}
	if claims.scope != "" {
		payload["scope"] = claims.scope
	}
	signingInput := encodeSegment(header) + "." + encodeSegment(payload)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, u.key, crypto.SHA256, digest[:])
	if err != nil {
		return ""
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

// verifyAccessToken checks the signature and the time window and returns the
// claims the facade's transport validator and the callback both rely on.
func (u *localUpstream) verifyAccessToken(token string) (verifiedClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return verifiedClaims{}, errors.New("example: access token is not a JWS")
	}
	signingInput := parts[0] + "." + parts[1]
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return verifiedClaims{}, err
	}
	digest := sha256.Sum256([]byte(signingInput))
	if err := rsa.VerifyPKCS1v15(&u.key.PublicKey, crypto.SHA256, digest[:], signature); err != nil {
		return verifiedClaims{}, err
	}
	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return verifiedClaims{}, err
	}
	var payload struct {
		Issuer   string `json:"iss"`
		Audience string `json:"aud"`
		Subject  string `json:"sub"`
		AZP      string `json:"azp"`
		Scope    string `json:"scope"`
		Expires  int64  `json:"exp"`
	}
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		return verifiedClaims{}, err
	}
	expiresAt := time.Unix(payload.Expires, 0).UTC()
	if !u.now().Before(expiresAt) {
		return verifiedClaims{}, errors.New("example: access token expired")
	}
	return verifiedClaims{
		issuer:          payload.Issuer,
		audience:        payload.Audience,
		subject:         payload.Subject,
		authorizedParty: payload.AZP,
		scope:           payload.Scope,
		expiresAt:       expiresAt,
	}, nil
}

// bearerClaimsValidator validates an ACCESS token presented on the MCP
// transport routes: the resource must accept every credential the facade issues
// for the whole lifetime the token response stated.
func (u *localUpstream) bearerClaimsValidator(ctx *apptheory.Context, token string) (*oauth.BearerTokenClaims, error) {
	if token == "" {
		return nil, oauth.ErrBearerTokenInvalidAudience
	}
	claims, err := u.verifyAccessToken(token)
	if err != nil {
		return nil, err
	}
	if claims.issuer != u.issuer || claims.audience != resourceForMCPPath(u.publicBaseURL, ctx.Request.Path) {
		return nil, oauth.ErrBearerTokenInvalidAudience
	}
	return &oauth.BearerTokenClaims{
		Subject:   claims.subject,
		Audience:  claims.audience,
		Scopes:    strings.Fields(claims.scope),
		ExpiresAt: claims.expiresAt,
	}, nil
}

// newUpstream builds the example's authorization server with a fresh key.
func newUpstream(publicBaseURL, issuer, clientID, callback, subject string, accessTTL time.Duration) (*localUpstream, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	return &localUpstream{
		issuer:        strings.TrimRight(issuer, "/"),
		publicBaseURL: strings.TrimRight(publicBaseURL, "/"),
		clientID:      clientID,
		callback:      callback,
		subject:       subject,
		scope:         exampleScope,
		accessTTL:     accessTTL,
		now:           func() time.Time { return time.Now().UTC() },
		key:           key,
		codes:         map[string]*upstreamCode{},
		grants:        map[string]*upstreamGrant{},
		refresh:       map[string]*upstreamRefresh{},
	}, nil
}

// mintRefreshForSeed mints upstream material a pre-policy (family-less) broker
// record can carry, so the legacy-continuity row starts from a record the
// facade's migration path can actually refresh.
func (u *localUpstream) mintRefreshForSeed(resource string) string {
	u.mu.Lock()
	defer u.mu.Unlock()
	grant := &upstreamGrant{
		id:         opaqueToken(),
		subject:    u.subject,
		resource:   resource,
		scope:      u.scope,
		generation: 1,
	}
	u.grants[grant.id] = grant
	token := opaqueToken()
	u.refresh[token] = &upstreamRefresh{grantID: grant.id}
	return token
}

// revokeGrant makes every refresh token of one grant terminally dead, the way
// an upstream does when the person's authorization is withdrawn.
func (u *localUpstream) revokeAllGrants() {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, grant := range u.grants {
		grant.revoked = true
	}
}

// stats reports the upstream call counters the rows assert.
func (u *localUpstream) stats() (issued, refreshed, reused int) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.issued, u.refreshed, u.reused
}

func pkceMatches(verifier, challenge string) bool {
	if verifier == "" || challenge == "" {
		return false
	}
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:]) == challenge
}

func opaqueToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func encodeSegment(value map[string]any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func bearerToken(header string) string {
	const prefix = "bearer "
	trimmed := strings.TrimSpace(header)
	if len(trimmed) < len(prefix) || strings.ToLower(trimmed[:len(prefix)]) != prefix {
		return ""
	}
	return strings.TrimSpace(trimmed[len(prefix):])
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
