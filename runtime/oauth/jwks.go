package oauth

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
)

const (
	// jwksAlgorithmRS256 is the only JWS algorithm this validator accepts. The
	// algorithm is pinned rather than negotiated so an RSA public key can never
	// be reinterpreted as an HMAC secret (algorithm confusion).
	jwksAlgorithmRS256 = "RS256"
	// jsonNullLiteral is the JSON null spelling, compared against raw message
	// bytes that have already been whitespace-trimmed.
	jsonNullLiteral = "null"

	// jwksMaxDocumentBytes bounds every discovery and JWKS response body.
	jwksMaxDocumentBytes = 1 << 20 // 1 MiB
	// jwksMaxKeys bounds the number of keys accepted from one JWKS document.
	jwksMaxKeys = 64

	defaultJWKSCacheTTL        = 15 * time.Minute
	defaultJWKSRefreshCooldown = 30 * time.Second
	defaultMaxRefreshPerKid    = 1
	// defaultJWKSFetchTimeout bounds one discovery or JWKS fetch. It matches the
	// Python validator's default so all three runtimes share one fetch bound.
	defaultJWKSFetchTimeout = 10 * time.Second
	// jwksRefreshWaitSlack is added to the fetch timeout to bound how long a
	// validation waits on a refresh another validation already started.
	jwksRefreshWaitSlack = 250 * time.Millisecond
)

// Validator failure markers. Every one of them is wrapped together with an
// ErrBearer* sentinel so RequireBearerTokenMiddleware maps the request to the
// right 401/403 surface while callers can still tell the failures apart.
var (
	errAlgorithmNotAllowed = errors.New("jwks: token algorithm is not RS256")
	errMissingKid          = errors.New("jwks: token header must carry a kid")
	errMalformedToken      = errors.New("jwks: malformed compact JWS")
	errSignatureInvalid    = errors.New("jwks: signature verification failed")
	errUnknownKey          = errors.New("jwks: no usable key for kid")
	errIssuerMismatch      = errors.New("jwks: issuer does not match the configured issuer")
	errAudienceMismatch    = errors.New("jwks: audience does not match the required audience")
	errAZPNotAllowed       = errors.New("jwks: azp is not allowed")
	errClaimInvalid        = errors.New("jwks: claim is missing or invalid")
	errNotYetValid         = errors.New("jwks: token is not yet valid")

	errInsecureURL         = errors.New("oauth: url must be https")
	errCrossOriginRedirect = errors.New("oauth: cross-origin redirect rejected")
	errRedirectRejected    = errors.New("oauth: redirect rejected")
	errMissingJWKSURI      = errors.New("oauth: document omits jwks_uri")
	errDocumentInvalid     = errors.New("oauth: document is invalid")
	errResponseTooLarge    = errors.New("oauth: response exceeds the maximum size")
	errTooManyKeys         = errors.New("oauth: key set exceeds the maximum key count")
	errFetchUnavailable    = errors.New("oauth: document fetch failed")
)

// JWKSValidatorOptions configures NewJWKSValidator.
type JWKSValidatorOptions struct {
	// Issuer is the expected token issuer. It is required.
	Issuer string

	// JWKSURI is the absolute HTTPS JSON Web Key Set URL. When it is empty,
	// DiscoveryURL bootstraps it.
	JWKSURI string

	// DiscoveryURL is the absolute OIDC discovery document URL. It is consulted
	// only when JWKSURI is empty, and its document issuer must equal Issuer
	// before its jwks_uri is trusted.
	DiscoveryURL string

	// HTTPClient is reused for every discovery and JWKS fetch. Redirects are
	// disabled regardless: a 3xx response fails closed.
	HTTPClient *http.Client

	// Now overrides the clock used for exp/nbf, cache expiry, and cooldown.
	Now func() time.Time

	// ClockSkew is the tolerance applied to exp and nbf.
	ClockSkew time.Duration

	// FetchTimeout bounds one discovery or JWKS fetch. Zero means the default of
	// 10s, shared with the TypeScript and Python validators; an HTTPClient that
	// already carries its own Timeout keeps that Timeout unless FetchTimeout is
	// set explicitly.
	FetchTimeout time.Duration

	// CacheTTL is how long a fetched key stays usable before a refresh. Zero
	// means the default.
	CacheTTL time.Duration

	// RefreshCooldown bounds how often one unknown kid may trigger fetches.
	// Zero means the default.
	RefreshCooldown time.Duration

	// MaxRefreshPerKid bounds the refresh fetches a single unknown kid may
	// trigger beyond the fetch that populates the cache. Zero means the default
	// of 1.
	MaxRefreshPerKid int

	// AllowedAZP is an exact-match allow-list for the token's azp claim, falling
	// back to client_id. An empty list disables the check.
	AllowedAZP []string

	// RequiredAudience derives the route-bound audience. A non-empty result must
	// equal one aud entry exactly; there is no substring or wildcard match.
	RequiredAudience func(*apptheory.Context) (string, error)

	// RequiredScopes derives the route-bound scope set. Every entry must be
	// present in the token.
	RequiredScopes func(*apptheory.Context) ([]string, error)
}

// NewJWKSValidator returns a fail-closed RS256/JWKS claims validator.
//
// The returned validator resolves signing keys from a bounded kid cache that
// RefreshCooldown rate-limits, verifies RSASSA-PKCS1-v1_5/SHA-256 signatures,
// and refuses the request on every doubt: a malformed token, a non-RS256
// algorithm, a missing kid, an unknown or inconsistent key, a signature
// mismatch, an issuer mismatch, an expired/not-yet-valid token, an audience or
// scope mismatch, or a disallowed azp. It never returns claims for a token it
// could not fully verify, and it never logs the token or key material.
func NewJWKSValidator(opts JWKSValidatorOptions) (BearerTokenClaimsValidator, error) {
	issuer, ok := CanonicalizeIssuerURL(opts.Issuer)
	if !ok {
		return nil, fmt.Errorf("%w: jwks validator issuer must be an absolute URL", ErrInvalidURL)
	}

	client := jwksHTTPClient(opts.HTTPClient, opts.FetchTimeout)
	fetchTimeout := resolvedFetchTimeout(opts.HTTPClient, opts.FetchTimeout)

	discoveryURL := strings.TrimSpace(opts.DiscoveryURL)
	if discoveryURL != "" {
		if _, ok := normalizeSecureURL(discoveryURL); !ok {
			return nil, fmt.Errorf("%w: %w", ErrInvalidURL, errInsecureURL)
		}
	}

	jwksURI := strings.TrimSpace(opts.JWKSURI)
	switch {
	case jwksURI != "":
		normalized, ok := normalizeSecureURL(jwksURI)
		if !ok {
			return nil, fmt.Errorf("%w: %w", ErrInvalidURL, errInsecureURL)
		}
		jwksURI = normalized
	case discoveryURL != "":
		bootstrapped, err := BootstrapOIDCDiscovery(context.Background(), discoveryURL, issuer, client)
		if err != nil {
			return nil, err
		}
		jwksURI = bootstrapped
	default:
		return nil, fmt.Errorf("%w: jwks validator requires a jwks uri or a discovery url", ErrInvalidURL)
	}

	now := opts.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}

	cacheTTL := opts.CacheTTL
	if cacheTTL <= 0 {
		cacheTTL = defaultJWKSCacheTTL
	}
	refreshCooldown := opts.RefreshCooldown
	if refreshCooldown <= 0 {
		refreshCooldown = defaultJWKSRefreshCooldown
	}
	maxRefreshPerKid := opts.MaxRefreshPerKid
	if maxRefreshPerKid <= 0 {
		maxRefreshPerKid = defaultMaxRefreshPerKid
	}

	validator := &jwksValidator{
		issuer:           issuer,
		jwksURI:          jwksURI,
		client:           client,
		fetchTimeout:     fetchTimeout,
		now:              now,
		clockSkew:        opts.ClockSkew,
		cacheTTL:         cacheTTL,
		refreshCooldown:  refreshCooldown,
		maxRefreshPerKid: maxRefreshPerKid,
		allowedAZP:       allowedAZPSet(opts.AllowedAZP),
		requiredAudience: opts.RequiredAudience,
		requiredScopes:   opts.RequiredScopes,
		keys:             make(map[string]jwksCachedKey),
		windows:          make(map[string]time.Time),
	}
	return validator.validate, nil
}

// BootstrapOIDCDiscovery fetches an OIDC discovery document, verifies that the
// document's issuer equals the configured issuer, and returns the document's
// jwks_uri. The discovery URL and the returned key-set URL must both be
// absolute HTTPS URLs; a document that omits jwks_uri, an issuer mismatch, and
// any redirect all fail closed.
func BootstrapOIDCDiscovery(ctx context.Context, discoveryURL string, issuer string, client *http.Client) (jwksURI string, err error) {
	configuredIssuer, ok := CanonicalizeIssuerURL(issuer)
	if !ok {
		return "", fmt.Errorf("%w: configured issuer must be an absolute URL", ErrInvalidURL)
	}
	requestURL, ok := normalizeSecureURL(discoveryURL)
	if !ok {
		return "", fmt.Errorf("%w: %w", ErrInvalidURL, errInsecureURL)
	}

	body, err := fetchBoundedDocument(ctx, jwksHTTPClient(client, 0), requestURL)
	if err != nil {
		return "", err
	}

	var document struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return "", fmt.Errorf("%w: %w", ErrInvalidURL, errDocumentInvalid)
	}

	documentIssuer, ok := CanonicalizeIssuerURL(document.Issuer)
	if !ok || documentIssuer != configuredIssuer {
		return "", fmt.Errorf("%w: %w", ErrInvalidURL, errIssuerMismatch)
	}

	if strings.TrimSpace(document.JWKSURI) == "" {
		return "", fmt.Errorf("%w: %w", ErrInvalidURL, errMissingJWKSURI)
	}
	normalized, ok := normalizeSecureURL(document.JWKSURI)
	if !ok {
		return "", fmt.Errorf("%w: %w", ErrInvalidURL, errInsecureURL)
	}
	return normalized, nil
}

// jwksCachedKey is one bounded, expiry-driven cache entry.
type jwksCachedKey struct {
	key       *rsa.PublicKey
	expiresAt time.Time
}

// jwksValidator is the stateful validator behind NewJWKSValidator. The mutex
// covers key resolution only, so the fetch that populates the cache and the
// cooldown bookkeeping that bounds it observe one consistent state per token.
type jwksValidator struct {
	issuer           string
	jwksURI          string
	client           *http.Client
	fetchTimeout     time.Duration
	now              func() time.Time
	clockSkew        time.Duration
	cacheTTL         time.Duration
	refreshCooldown  time.Duration
	maxRefreshPerKid int
	allowedAZP       map[string]struct{}
	requiredAudience func(*apptheory.Context) (string, error)
	requiredScopes   func(*apptheory.Context) ([]string, error)

	mu      sync.Mutex
	keys    map[string]jwksCachedKey
	windows map[string]time.Time
	// flight is the one refresh fetch currently in progress, if any. Validations
	// that need a fetch join it instead of starting their own, so a hung upstream
	// costs one connection and no goroutine holds mu while waiting on the network.
	flight *jwksRefreshFlight
}

// jwksRefreshFlight is a single in-flight key-set fetch shared by every
// validation that needs it.
type jwksRefreshFlight struct {
	done chan struct{}
	err  error
}

type parsedCompactJWS struct {
	alg          string
	kid          string
	signingInput []byte
	signature    []byte
	payload      []byte
}

func (v *jwksValidator) validate(ctx *apptheory.Context, token string) (*BearerTokenClaims, error) {
	parsed, err := parseCompactJWS(token)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidBearerToken, err)
	}
	if parsed.alg != jwksAlgorithmRS256 {
		return nil, fmt.Errorf("%w: %w", ErrInvalidBearerToken, errAlgorithmNotAllowed)
	}
	if parsed.kid == "" {
		return nil, fmt.Errorf("%w: %w", ErrInvalidBearerToken, errMissingKid)
	}

	claims, err := parseJWKSClaims(parsed.payload)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidBearerToken, err)
	}
	// The issuer is checked before the key lookup so a token for another issuer
	// can never steer a fetch, and again after verification so nothing observed
	// before the signature is what authorizes the request.
	if err = v.checkIssuer(claims.Issuer); err != nil {
		return nil, err
	}

	key, err := v.keyForKid(requestContext(ctx), parsed.kid)
	if err != nil {
		return nil, err
	}
	if !verifyRS256(key, parsed.signingInput, parsed.signature) {
		return nil, fmt.Errorf("%w: %w", ErrInvalidBearerToken, errSignatureInvalid)
	}

	if err = v.checkIssuer(claims.Issuer); err != nil {
		return nil, err
	}
	if err = v.checkTimes(claims); err != nil {
		return nil, err
	}
	audience, err := v.checkAudience(ctx, claims)
	if err != nil {
		return nil, err
	}
	scopes, err := v.checkScopes(ctx, claims)
	if err != nil {
		return nil, err
	}
	if err = v.checkAZP(claims); err != nil {
		return nil, err
	}

	return &BearerTokenClaims{
		Subject:   strings.TrimSpace(claims.Subject),
		Audience:  audience,
		Scopes:    scopes,
		ExpiresAt: claims.ExpiresAt,
	}, nil
}

func (v *jwksValidator) checkIssuer(issuer string) error {
	canonical, ok := CanonicalizeIssuerURL(issuer)
	if !ok || canonical != v.issuer {
		return fmt.Errorf("%w: %w", ErrInvalidBearerToken, errIssuerMismatch)
	}
	return nil
}

func (v *jwksValidator) checkTimes(claims jwksClaims) error {
	if !claims.HasExpiry {
		return fmt.Errorf("%w: %w", ErrInvalidBearerToken, errClaimInvalid)
	}
	now := v.now()
	if !now.Before(claims.ExpiresAt.Add(v.clockSkew)) {
		return fmt.Errorf("%w: token exp is in the past", ErrBearerTokenExpired)
	}
	if claims.HasNotBefore && claims.NotBefore.After(now.Add(v.clockSkew)) {
		return fmt.Errorf("%w: %w", ErrInvalidBearerToken, errNotYetValid)
	}
	return nil
}

func (v *jwksValidator) checkAudience(ctx *apptheory.Context, claims jwksClaims) (string, error) {
	required := ""
	if v.requiredAudience != nil {
		derived, err := v.requiredAudience(ctx)
		if err != nil {
			return "", err
		}
		required = strings.TrimSpace(derived)
	}
	if required != "" {
		for _, candidate := range claims.Audience {
			if candidate == required {
				return required, nil
			}
		}
		return "", fmt.Errorf("%w: %w", ErrBearerTokenInvalidAudience, errAudienceMismatch)
	}
	if len(claims.Audience) > 0 {
		return claims.Audience[0], nil
	}
	return "", nil
}

func (v *jwksValidator) checkScopes(ctx *apptheory.Context, claims jwksClaims) ([]string, error) {
	var required []string
	if v.requiredScopes != nil {
		derived, err := v.requiredScopes(ctx)
		if err != nil {
			return nil, err
		}
		required = derived
	}
	if len(missingScopes(claims.Scopes, required)) > 0 {
		return nil, fmt.Errorf("%w: %w", ErrBearerTokenInsufficientScope, errClaimInvalid)
	}
	return append([]string(nil), claims.Scopes...), nil
}

func (v *jwksValidator) checkAZP(claims jwksClaims) error {
	if len(v.allowedAZP) == 0 {
		return nil
	}
	value := strings.TrimSpace(claims.AZP)
	if value == "" {
		value = strings.TrimSpace(claims.ClientID)
	}
	if _, ok := v.allowedAZP[value]; !ok {
		return fmt.Errorf("%w: %w", ErrInvalidBearerToken, errAZPNotAllowed)
	}
	return nil
}

// keyForKid resolves a signing key for kid from the bounded cache. An unknown
// kid opens one resolution window per RefreshCooldown: the first fetch
// populates the cache and up to MaxRefreshPerKid further fetches absorb key
// publication lag. Every further unknown-kid token inside the cooldown is
// rejected without another fetch, so an attacker cannot amplify token traffic
// into key-set traffic. No lock is held across the network: a hung upstream
// costs one connection and one bounded wait.
func (v *jwksValidator) keyForKid(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.Lock()
	now := v.now()
	if key, ok := v.cachedKey(kid, now); ok {
		v.mu.Unlock()
		return key, nil
	}
	if startedAt, ok := v.windows[kid]; ok && now.Sub(startedAt) < v.refreshCooldown {
		v.mu.Unlock()
		return nil, fmt.Errorf("%w: %w", ErrInvalidBearerToken, errUnknownKey)
	}
	// The window is recorded before the fetch, so a failed or hung fetch cannot
	// be re-triggered by the same kid inside the cooldown.
	v.windows[kid] = now
	v.mu.Unlock()

	for attempt := 0; attempt <= v.maxRefreshPerKid; attempt++ {
		if err := v.refresh(ctx, now); err != nil {
			return nil, err
		}
		v.mu.Lock()
		key, ok := v.cachedKey(kid, now)
		v.mu.Unlock()
		if ok {
			return key, nil
		}
	}
	return nil, fmt.Errorf("%w: %w", ErrInvalidBearerToken, errUnknownKey)
}

func (v *jwksValidator) cachedKey(kid string, now time.Time) (*rsa.PublicKey, bool) {
	entry, ok := v.keys[kid]
	if !ok || entry.key == nil || !now.Before(entry.expiresAt) {
		return nil, false
	}
	return entry.key, true
}

// refresh performs one key-set fetch. Concurrent validations share a single
// in-flight fetch: the first caller performs it and the rest wait at most the
// fetch timeout plus a small slack before failing closed. The state mutex is
// never held across the network, so a hung or hostile upstream cannot stall
// other validations beyond that bound.
func (v *jwksValidator) refresh(ctx context.Context, now time.Time) error {
	v.mu.Lock()
	if flight := v.flight; flight != nil {
		v.mu.Unlock()
		return v.awaitFlight(ctx, flight)
	}
	flight := &jwksRefreshFlight{done: make(chan struct{})}
	v.flight = flight
	v.mu.Unlock()

	err := v.fetchKeys(ctx, now)

	v.mu.Lock()
	flight.err = err
	v.flight = nil
	close(flight.done)
	v.mu.Unlock()
	return err
}

// fetchKeys fetches and parses one key set and stores its keys.
func (v *jwksValidator) fetchKeys(ctx context.Context, now time.Time) error {
	body, err := fetchBoundedDocument(ctx, v.client, v.jwksURI)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidBearerToken, err)
	}
	keys, err := parseJWKSKeys(body)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidBearerToken, err)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for kid, key := range keys {
		v.keys[kid] = jwksCachedKey{key: key, expiresAt: now.Add(v.cacheTTL)}
	}
	return nil
}

// awaitFlight waits for another validation's fetch without holding any lock.
// The wait is bounded by the fetch timeout, so a hung upstream degrades to a
// fail-closed rejection instead of an unbounded stall.
func (v *jwksValidator) awaitFlight(ctx context.Context, flight *jwksRefreshFlight) error {
	timer := time.NewTimer(v.fetchTimeout + jwksRefreshWaitSlack)
	defer timer.Stop()
	select {
	case <-flight.done:
		return flight.err
	case <-timer.C:
		return fmt.Errorf("%w: %w", ErrInvalidBearerToken, errFetchUnavailable)
	case <-ctx.Done():
		return fmt.Errorf("%w: %w", ErrInvalidBearerToken, errFetchUnavailable)
	}
}

// requestContext returns the request's Go context so a fetch is bounded by the
// caller's deadline as well as the fetch timeout.
func requestContext(ctx *apptheory.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	if derived := ctx.Context(); derived != nil {
		return derived
	}
	return context.Background()
}

func parseCompactJWS(token string) (parsedCompactJWS, error) {
	segments := strings.Split(strings.TrimSpace(token), ".")
	if len(segments) != 3 || segments[0] == "" || segments[1] == "" {
		return parsedCompactJWS{}, errMalformedToken
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(segments[0])
	if err != nil {
		return parsedCompactJWS{}, errMalformedToken
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		return parsedCompactJWS{}, errMalformedToken
	}
	signature, err := base64.RawURLEncoding.DecodeString(segments[2])
	if err != nil {
		return parsedCompactJWS{}, errMalformedToken
	}

	var header struct {
		Alg  string          `json:"alg"`
		Kid  string          `json:"kid"`
		Crit json.RawMessage `json:"crit"`
	}
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return parsedCompactJWS{}, errMalformedToken
	}
	// An unrecognized critical header must fail closed rather than be ignored.
	if len(header.Crit) > 0 && string(header.Crit) != jsonNullLiteral {
		return parsedCompactJWS{}, errMalformedToken
	}

	return parsedCompactJWS{
		alg:          header.Alg,
		kid:          strings.TrimSpace(header.Kid),
		signingInput: []byte(segments[0] + "." + segments[1]),
		signature:    signature,
		payload:      payloadBytes,
	}, nil
}

type jwksClaims struct {
	Issuer       string
	Subject      string
	Audience     []string
	Scopes       []string
	AZP          string
	ClientID     string
	ExpiresAt    time.Time
	HasExpiry    bool
	NotBefore    time.Time
	HasNotBefore bool
}

func parseJWKSClaims(payload []byte) (jwksClaims, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()

	var raw struct {
		Issuer   string          `json:"iss"`
		Subject  string          `json:"sub"`
		Audience json.RawMessage `json:"aud"`
		Scope    string          `json:"scope"`
		SCP      json.RawMessage `json:"scp"`
		AZP      string          `json:"azp"`
		ClientID string          `json:"client_id"`
		Exp      json.Number     `json:"exp"`
		Nbf      json.Number     `json:"nbf"`
	}
	if err := decoder.Decode(&raw); err != nil {
		return jwksClaims{}, errClaimInvalid
	}

	claims := jwksClaims{
		Issuer:   strings.TrimSpace(raw.Issuer),
		Subject:  raw.Subject,
		AZP:      raw.AZP,
		ClientID: raw.ClientID,
	}
	audience, err := parseStringOrStringList(raw.Audience)
	if err != nil {
		return jwksClaims{}, err
	}
	claims.Audience = audience
	scp, err := parseStringOrStringList(raw.SCP)
	if err != nil {
		return jwksClaims{}, err
	}
	claims.Scopes = normalizeClaimValues(append(scopeFields(raw.Scope), scp...))

	if raw.Exp != "" {
		expiresAt, ok := numericDate(raw.Exp)
		if !ok {
			return jwksClaims{}, errClaimInvalid
		}
		claims.ExpiresAt = expiresAt
		claims.HasExpiry = true
	}
	if raw.Nbf != "" {
		notBefore, ok := numericDate(raw.Nbf)
		if !ok {
			return jwksClaims{}, errClaimInvalid
		}
		claims.NotBefore = notBefore
		claims.HasNotBefore = true
	}
	return claims, nil
}

func parseStringOrStringList(raw json.RawMessage) ([]string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == jsonNullLiteral {
		return nil, nil
	}
	if trimmed[0] == '[' {
		var values []string
		if err := json.Unmarshal(trimmed, &values); err != nil {
			return nil, errClaimInvalid
		}
		return normalizeClaimValues(values), nil
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return nil, errClaimInvalid
	}
	return normalizeClaimValues([]string{value}), nil
}

func normalizeClaimValues(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			if _, duplicate := seen[value]; duplicate {
				continue
			}
			seen[value] = struct{}{}
			out = append(out, value)
		}
	}
	return out
}

func numericDate(value json.Number) (time.Time, bool) {
	if seconds, err := value.Int64(); err == nil {
		return time.Unix(seconds, 0).UTC(), true
	}
	if seconds, err := strconv.ParseFloat(value.String(), 64); err == nil {
		whole := int64(seconds)
		return time.Unix(whole, int64((seconds-float64(whole))*float64(time.Second))).UTC(), true
	}
	return time.Time{}, false
}

func verifyRS256(key *rsa.PublicKey, signingInput, signature []byte) bool {
	if key == nil || len(signature) == 0 {
		return false
	}
	digest := sha256.Sum256(signingInput)
	return rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature) == nil
}

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func parseJWKSKeys(body []byte) (map[string]*rsa.PublicKey, error) {
	var document struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, errDocumentInvalid
	}
	if len(document.Keys) == 0 {
		return nil, errDocumentInvalid
	}
	if len(document.Keys) > jwksMaxKeys {
		return nil, errTooManyKeys
	}

	keys := make(map[string]*rsa.PublicKey, len(document.Keys))
	for _, entry := range document.Keys {
		kid := strings.TrimSpace(entry.Kid)
		if kid == "" {
			continue
		}
		if _, exists := keys[kid]; exists {
			continue
		}
		if key, ok := rsaPublicKeyFromJWK(entry); ok {
			keys[kid] = key
		}
	}
	return keys, nil
}

func rsaPublicKeyFromJWK(entry jwk) (*rsa.PublicKey, bool) {
	if !strings.EqualFold(strings.TrimSpace(entry.Kty), "RSA") {
		return nil, false
	}
	if alg := strings.TrimSpace(entry.Alg); alg != "" && alg != jwksAlgorithmRS256 {
		return nil, false
	}
	if use := strings.TrimSpace(entry.Use); use != "" && !strings.EqualFold(use, "sig") {
		return nil, false
	}
	modulus, ok := decodeBase64URLUInt(entry.N)
	if !ok {
		return nil, false
	}
	exponent, ok := decodeExponent(entry.E)
	if !ok {
		return nil, false
	}
	return &rsa.PublicKey{N: modulus, E: exponent}, true
}

func decodeBase64URLUInt(raw string) (*big.Int, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) == 0 {
		return nil, false
	}
	return new(big.Int).SetBytes(decoded), true
}

func decodeExponent(raw string) (int, bool) {
	decoded, ok := decodeBase64URLUInt(raw)
	if !ok || !decoded.IsInt64() {
		return 0, false
	}
	exponent := decoded.Int64()
	if exponent < 3 || exponent > int64(^uint32(0)>>1) {
		return 0, false
	}
	return int(exponent), true
}

// fetchBoundedDocument performs one GET and returns at most jwksMaxDocumentBytes
// of body. A 3xx is never followed: a redirect to another origin is reported as
// a cross-origin redirect and every other redirect is a plain failure.
func fetchBoundedDocument(ctx context.Context, client *http.Client, rawURL string) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errFetchUnavailable, errDocumentInvalid)
	}
	request.Header.Set("accept", "application/json")

	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errFetchUnavailable, err)
	}
	defer func() {
		if closeErr := response.Body.Close(); closeErr != nil {
			_ = closeErr
		}
	}()

	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return nil, redirectFailure(request.URL, response)
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: unexpected status %d", errFetchUnavailable, response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, jwksMaxDocumentBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errFetchUnavailable, err)
	}
	if len(body) > jwksMaxDocumentBytes {
		return nil, errResponseTooLarge
	}
	return body, nil
}

func redirectFailure(requestURL *url.URL, response *http.Response) error {
	location := strings.TrimSpace(response.Header.Get("location"))
	if location == "" {
		return errRedirectRejected
	}
	parsed, err := url.Parse(location)
	if err != nil {
		return errRedirectRejected
	}
	if !sameOrigin(requestURL, requestURL.ResolveReference(parsed)) {
		return errCrossOriginRedirect
	}
	return errRedirectRejected
}

func sameOrigin(a, b *url.URL) bool {
	if a == nil || b == nil {
		return false
	}
	return strings.EqualFold(a.Scheme, b.Scheme) &&
		strings.EqualFold(canonicalHostnameForCompare(a), canonicalHostnameForCompare(b)) &&
		effectivePort(a) == effectivePort(b)
}

func canonicalHostnameForCompare(u *url.URL) string {
	return strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
}

func effectivePort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	return defaultPortForScheme(strings.ToLower(u.Scheme))
}

func normalizeSecureURL(raw string) (string, bool) {
	u, ok := parseAbsoluteURL(raw)
	if !ok || !strings.EqualFold(u.Scheme, httpsScheme) || u.User != nil || u.Hostname() == "" {
		return "", false
	}
	if u.Fragment != "" || u.RawFragment != "" {
		return "", false
	}
	u.Scheme = httpsScheme
	u.RawPath = ""
	return u.String(), true
}

// resolvedFetchTimeout returns the fetch bound: the explicit override, else the
// caller's client timeout, else the framework default shared with the other
// runtimes.
func resolvedFetchTimeout(base *http.Client, override time.Duration) time.Duration {
	if override > 0 {
		return override
	}
	if base != nil && base.Timeout > 0 {
		return base.Timeout
	}
	return defaultJWKSFetchTimeout
}

func jwksHTTPClient(client *http.Client, fetchTimeout time.Duration) *http.Client {
	base := client
	if base == nil {
		base = http.DefaultClient
	}
	clone := *base
	// Every discovery and JWKS fetch is bounded, so a hung or hostile upstream
	// cannot stall a validation indefinitely.
	clone.Timeout = resolvedFetchTimeout(client, fetchTimeout)
	// Never follow a redirect: the caller must not be steered to another
	// origin, and a 3xx is reported as a failure by fetchBoundedDocument.
	clone.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &clone
}

func allowedAZPSet(values []string) map[string]struct{} {
	if len(values) == 0 {
		return nil
	}
	allowed := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			allowed[value] = struct{}{}
		}
	}
	if len(allowed) == 0 {
		return nil
	}
	return allowed
}
