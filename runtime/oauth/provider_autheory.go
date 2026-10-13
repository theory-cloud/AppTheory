package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
)

// Autheory is the first Provider adapter of the MCP auth facade (DESIGN §6):
// an RFC 8414-discovering adapter for the Autheory authorization server. It
// reuses the package's hardened fetch (bounded body, fetch timeout, redirect
// refusal, SSRF host guard) rather than re-plumbing transport hygiene.
const (
	// autheoryWellKnownPath is the RFC 8414 discovery path appended to the
	// configured issuer when no discovery URL is configured explicitly.
	autheoryWellKnownPath = "/.well-known/oauth-authorization-server"

	// pkceMethodS256 is the only code challenge method the adapter sends. PKCE
	// method names are case-sensitive, and a fail-closed adapter refuses
	// anything else rather than downgrading.
	pkceMethodS256 = "S256"

	// providerKeySeparator joins list members inside a validator cache key. It
	// cannot appear in an issuer, audience, scope, or client id.
	providerKeySeparator = "\x1f"

	// maxCachedValidators bounds the per-expectation-set validator cache, so a
	// caller cannot grow the adapter's state with distinct expectation sets.
	maxCachedValidators = 32
)

// Adapter operations. Every typed error names the operation it came from.
const (
	providerOpConstruct           = "construct"
	providerOpDiscovery           = "discovery"
	providerOpAuthorizationURL    = "authorization_url"
	providerOpExchangeCode        = "exchange_code"
	providerOpRefresh             = "refresh"
	providerOpValidateAccessToken = "validate_access_token"
)

// Fixed, upstream-body-free error messages. An adapter error message is a
// constant: an upstream response body may echo hidden material, so no part of
// one is ever rendered.
const (
	providerMsgIssuerInvalid         = "issuer must be an absolute URL"
	providerMsgRequestInvalid        = "request is missing a required field or carries an unsupported PKCE method"
	providerMsgDiscoveryUnavailable  = "upstream discovery document could not be fetched or verified"
	providerMsgEndpointNotSecure     = "upstream endpoint is not an https URL"
	providerMsgTokenEndpointFailed   = "upstream token endpoint call failed"
	providerMsgGrantRejected         = "upstream rejected the grant"
	providerMsgReauthRequired        = "upstream reported the recorded material stale or replaced"
	providerMsgAccessTokenMissing    = "upstream token response is missing an access token"
	providerMsgTokenValidationFailed = "upstream access token validation failed"
)

// Upstream token-endpoint error codes that carry an adapter-level meaning. The
// remaining terminal codes all map to the invalid_grant class, and an
// unrecognized code stays an upstream_error so an unknown signal is never
// upgraded into a client-facing decision.
const (
	tokenErrorReauthRequired      = "reauth_required"
	tokenErrorTemporarilyUnavail  = "temporarily_unavailable"
	tokenErrorInvalidGrant        = "invalid_grant"
	tokenErrorInvalidClient       = "invalid_client"
	tokenErrorUnauthorizedClient  = "unauthorized_client"
	tokenErrorInvalidScope        = "invalid_scope"
	tokenErrorInvalidRequest      = "invalid_request"
	tokenErrorAccessDenied        = "access_denied"
	tokenErrorExpiredToken        = "expired_token"
	tokenErrorInvalidToken        = "invalid_token"
	authorizationResponseTypeCode = "code"
	grantTypeAuthorizationCode    = "authorization_code"
	grantTypeRefreshToken         = "refresh_token"
	formFieldGrantType            = "grant_type"
	formFieldClientID             = "client_id"
	formFieldRedirectURI          = "redirect_uri"
	formFieldCode                 = "code"
	formFieldCodeVerifier         = "code_verifier"
	formFieldRefreshToken         = "refresh_token"
	queryFieldResponseType        = "response_type"
	queryFieldCodeChallenge       = "code_challenge"
	queryFieldCodeChallengeMethod = "code_challenge_method"
	queryFieldState               = "state"
	queryFieldResource            = "resource"
	queryFieldScope               = "scope"
	formContentType               = "application/x-www-form-urlencoded"
	jsonContentType               = "application/json"
	acceptHeader                  = "accept"
	contentTypeHeader             = "content-type"
)

// AutheoryProviderOptions configures NewAutheoryProvider.
type AutheoryProviderOptions struct {
	// Issuer is the expected upstream issuer, for example
	// https://auth.autheory.app. It is required.
	Issuer string

	// ClientID is the adapter's own upstream client registration id. The adapter
	// never derives a request's client id from it: a request that omits its
	// upstream client id fails closed with invalid_request.
	ClientID string

	// DiscoveryURL overrides the discovery document URL. Zero value means the
	// issuer plus /.well-known/oauth-authorization-server.
	DiscoveryURL string

	// TokenEndpoint, JWKSURI, and AuthorizationEndpoint override the endpoints
	// the discovery document publishes. Each must be an https URL.
	TokenEndpoint         string
	JWKSURI               string
	AuthorizationEndpoint string

	// HTTPClient is reused for every discovery, token, and JWKS call. Redirects
	// are refused regardless; a caller-supplied transport keeps its own
	// connection policy.
	HTTPClient *http.Client

	// AllowPrivateHosts disables the framework's non-public-host guard on the
	// calls the adapter makes with the framework's own transport. It is off by
	// default; local development and loopback test suites opt in explicitly.
	AllowPrivateHosts bool

	// FetchTimeout bounds one discovery, token, or JWKS call. Zero means the
	// framework default shared with discovery and JWKS fetching.
	FetchTimeout time.Duration

	// Now overrides the clock used for token expiry and key caching. Zero means
	// time.Now().UTC.
	Now func() time.Time

	// AllowedAuthorizedParties is an exact-match allow-list applied to the
	// validated token's azp claim (falling back to client_id). It is the default
	// for expectation sets that do not carry their own list.
	AllowedAuthorizedParties []string
}

// tokenExpectationKey is the validator cache key: one entry per expectation
// set.
type tokenExpectationKey struct {
	issuer            string
	audience          string
	scopes            string
	authorizedParties string
}

// AutheoryProvider is the Autheory implementation of Provider.
type AutheoryProvider struct {
	issuer        string
	discoveryURL  string
	client        *http.Client
	fetchTimeout  time.Duration
	allowPrivate  bool
	now           func() time.Time
	defaultAZP    []string
	tokenOverride string
	jwksOverride  string
	authzOverride string

	mu             sync.Mutex
	metadata       *ProviderMetadata
	validators     map[tokenExpectationKey]BearerTokenClaimsValidator
	validatorOrder []tokenExpectationKey
}

// NewAutheoryProvider returns a fail-closed Autheory provider adapter. The
// issuer must be an absolute URL; Discovery refuses a non-https discovery URL,
// a document issuer that does not match, and any redirect.
func NewAutheoryProvider(opts AutheoryProviderOptions) (*AutheoryProvider, error) {
	issuer, ok := CanonicalizeIssuerURL(opts.Issuer)
	if !ok {
		return nil, NewProviderError(ProviderInvalidRequest, providerOpConstruct, providerMsgIssuerInvalid)
	}

	discoveryURL := strings.TrimSpace(opts.DiscoveryURL)
	if discoveryURL == "" {
		discoveryURL = issuer + autheoryWellKnownPath
	}

	now := opts.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}

	return &AutheoryProvider{
		issuer:        issuer,
		discoveryURL:  discoveryURL,
		client:        jwksHTTPClient(opts.HTTPClient, opts.FetchTimeout, opts.AllowPrivateHosts),
		fetchTimeout:  resolvedFetchTimeout(opts.HTTPClient, opts.FetchTimeout),
		allowPrivate:  opts.AllowPrivateHosts,
		now:           now,
		defaultAZP:    append([]string(nil), opts.AllowedAuthorizedParties...),
		tokenOverride: strings.TrimSpace(opts.TokenEndpoint),
		jwksOverride:  strings.TrimSpace(opts.JWKSURI),
		authzOverride: strings.TrimSpace(opts.AuthorizationEndpoint),
		validators:    make(map[tokenExpectationKey]BearerTokenClaimsValidator),
	}, nil
}

// autheoryDiscoveryDocument is the RFC 8414 subset the adapter reads.
type autheoryDiscoveryDocument struct {
	Issuer                                     string   `json:"issuer"`
	AuthorizationEndpoint                      string   `json:"authorization_endpoint"`
	TokenEndpoint                              string   `json:"token_endpoint"`
	JWKSURI                                    string   `json:"jwks_uri"`
	CodeChallengeMethodsSupported              []string `json:"code_challenge_methods_supported"`
	AuthorizationResponseIssParameterSupported bool     `json:"authorization_response_iss_parameter_supported"`
	ResourceParameterSupported                 bool     `json:"resource_parameter_supported"`
}

// Discovery fetches and verifies the upstream RFC 8414 document, then caches
// the result. Every published endpoint must be an https URL and the document
// issuer must equal the configured issuer before anything is trusted.
func (p *AutheoryProvider) Discovery(ctx context.Context) (*ProviderMetadata, error) {
	if cached := p.cachedMetadata(); cached != nil {
		return cached, nil
	}
	metadata, err := p.fetchMetadata(ctx)
	if err != nil {
		return nil, err
	}
	p.storeMetadata(metadata)
	return metadata, nil
}

func (p *AutheoryProvider) fetchMetadata(ctx context.Context) (*ProviderMetadata, error) {
	if _, ok := normalizeSecureURL(p.discoveryURL); !ok {
		return nil, NewProviderError(ProviderUpstreamError, providerOpDiscovery, providerMsgEndpointNotSecure)
	}

	body, err := fetchBoundedDocument(ctx, p.client, p.discoveryURL)
	if err != nil {
		return nil, providerFetchError(providerOpDiscovery, providerMsgDiscoveryUnavailable, err)
	}

	var document autheoryDiscoveryDocument
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, NewProviderError(ProviderUpstreamError, providerOpDiscovery, providerMsgDiscoveryUnavailable)
	}
	documentIssuer, ok := CanonicalizeIssuerURL(document.Issuer)
	if !ok || documentIssuer != p.issuer {
		return nil, NewProviderError(ProviderUpstreamError, providerOpDiscovery, providerMsgDiscoveryUnavailable)
	}

	metadata, ok := document.metadata(documentIssuer)
	if !ok {
		return nil, NewProviderError(ProviderUpstreamError, providerOpDiscovery, providerMsgDiscoveryUnavailable)
	}
	p.applyEndpointOverrides(metadata)
	return metadata, nil
}

// metadata returns the trusted metadata subset, or false when a required
// endpoint is missing or is not an https URL.
func (d autheoryDiscoveryDocument) metadata(issuer string) (*ProviderMetadata, bool) {
	authorizationEndpoint, ok := normalizeSecureURL(d.AuthorizationEndpoint)
	if !ok {
		return nil, false
	}
	tokenEndpoint, ok := normalizeSecureURL(d.TokenEndpoint)
	if !ok {
		return nil, false
	}
	jwksURI, ok := normalizeSecureURL(d.JWKSURI)
	if !ok {
		return nil, false
	}
	return &ProviderMetadata{
		Issuer:                        issuer,
		AuthorizationEndpoint:         authorizationEndpoint,
		TokenEndpoint:                 tokenEndpoint,
		JWKSURI:                       jwksURI,
		CodeChallengeMethodsSupported: append([]string(nil), d.CodeChallengeMethodsSupported...),
		AuthorizationResponseIssParameterSupported: d.AuthorizationResponseIssParameterSupported,
		ResourceParameterSupported:                 d.ResourceParameterSupported,
	}, true
}

func (p *AutheoryProvider) applyEndpointOverrides(metadata *ProviderMetadata) {
	if p.authzOverride != "" {
		metadata.AuthorizationEndpoint = p.authzOverride
	}
	if p.tokenOverride != "" {
		metadata.TokenEndpoint = p.tokenOverride
	}
	if p.jwksOverride != "" {
		metadata.JWKSURI = p.jwksOverride
	}
}

func (p *AutheoryProvider) cachedMetadata() *ProviderMetadata {
	p.mu.Lock()
	defer p.mu.Unlock()
	return cloneProviderMetadata(p.metadata)
}

func (p *AutheoryProvider) storeMetadata(metadata *ProviderMetadata) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.metadata == nil {
		p.metadata = cloneProviderMetadata(metadata)
	}
}

func cloneProviderMetadata(metadata *ProviderMetadata) *ProviderMetadata {
	if metadata == nil {
		return nil
	}
	clone := *metadata
	clone.CodeChallengeMethodsSupported = append([]string(nil), metadata.CodeChallengeMethodsSupported...)
	return &clone
}

// endpoint resolves one upstream endpoint: an explicit override wins, else the
// discovered and cached document value.
func (p *AutheoryProvider) endpoint(
	ctx context.Context,
	op string,
	override string,
	selectEndpoint func(*ProviderMetadata) string,
) (string, error) {
	if override != "" {
		normalized, ok := normalizeSecureURL(override)
		if !ok {
			return "", NewProviderError(ProviderUpstreamError, op, providerMsgEndpointNotSecure)
		}
		return normalized, nil
	}
	metadata, err := p.Discovery(ctx)
	if err != nil {
		return "", err
	}
	return selectEndpoint(metadata), nil
}

func (p *AutheoryProvider) authorizationEndpoint(ctx context.Context) (string, error) {
	return p.endpoint(ctx, providerOpAuthorizationURL, p.authzOverride, func(metadata *ProviderMetadata) string {
		return metadata.AuthorizationEndpoint
	})
}

func (p *AutheoryProvider) tokenEndpoint(ctx context.Context, op string) (string, error) {
	return p.endpoint(ctx, op, p.tokenOverride, func(metadata *ProviderMetadata) string {
		return metadata.TokenEndpoint
	})
}

func (p *AutheoryProvider) jwksEndpoint(ctx context.Context) (string, error) {
	return p.endpoint(ctx, providerOpValidateAccessToken, p.jwksOverride, func(metadata *ProviderMetadata) string {
		return metadata.JWKSURI
	})
}

// validate applies the adapter's fail-closed request checks. A request that
// cannot be sent never reaches the upstream.
func (req AuthorizationRequest) validate() error {
	if strings.TrimSpace(req.UpstreamClientID) == "" ||
		strings.TrimSpace(req.CallbackURL) == "" ||
		strings.TrimSpace(req.CodeChallenge) == "" ||
		strings.TrimSpace(req.State) == "" ||
		strings.TrimSpace(req.Resource) == "" {
		return NewProviderError(ProviderInvalidRequest, providerOpAuthorizationURL, providerMsgRequestInvalid)
	}
	if req.CodeChallengeMethod != pkceMethodS256 {
		return NewProviderError(ProviderInvalidRequest, providerOpAuthorizationURL, providerMsgRequestInvalid)
	}
	return nil
}

// AuthorizationURL builds the upstream authorize URL. The adapter always sends
// resource (Autheory requires it, RFC 8707); hints are applied before the
// required parameters so a hint can never override one.
func (p *AutheoryProvider) AuthorizationURL(req AuthorizationRequest) (string, error) {
	if err := req.validate(); err != nil {
		return "", err
	}
	endpoint, err := p.authorizationEndpoint(context.Background())
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return "", NewProviderError(ProviderUpstreamError, providerOpAuthorizationURL, providerMsgEndpointNotSecure)
	}

	query := parsed.Query()
	for name, value := range req.Hints {
		if strings.TrimSpace(name) == "" {
			continue
		}
		query.Set(name, value)
	}
	query.Set(queryFieldResponseType, authorizationResponseTypeCode)
	query.Set(formFieldClientID, req.UpstreamClientID)
	query.Set(formFieldRedirectURI, req.CallbackURL)
	query.Set(queryFieldCodeChallenge, req.CodeChallenge)
	query.Set(queryFieldCodeChallengeMethod, pkceMethodS256)
	query.Set(queryFieldState, req.State)
	query.Set(queryFieldResource, req.Resource)
	if len(req.Scopes) > 0 {
		query.Set(queryFieldScope, strings.Join(req.Scopes, " "))
	}
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

// ExchangeCode performs the upstream authorization-code exchange with PKCE.
func (p *AutheoryProvider) ExchangeCode(ctx context.Context, req CodeExchangeRequest) (*TokenSet, error) {
	if strings.TrimSpace(req.Code) == "" ||
		strings.TrimSpace(req.UpstreamClientID) == "" ||
		strings.TrimSpace(req.CallbackURL) == "" ||
		strings.TrimSpace(req.CodeVerifier) == "" {
		return nil, NewProviderError(ProviderInvalidRequest, providerOpExchangeCode, providerMsgRequestInvalid)
	}
	endpoint, err := p.tokenEndpoint(ctx, providerOpExchangeCode)
	if err != nil {
		return nil, err
	}
	form := url.Values{
		formFieldGrantType:    {grantTypeAuthorizationCode},
		formFieldCode:         {req.Code},
		formFieldRedirectURI:  {req.CallbackURL},
		formFieldClientID:     {req.UpstreamClientID},
		formFieldCodeVerifier: {req.CodeVerifier},
	}
	return p.postToken(ctx, providerOpExchangeCode, endpoint, form)
}

// Refresh rotates the recorded upstream material, presenting the OAuth client
// that owns it.
func (p *AutheoryProvider) Refresh(ctx context.Context, req RefreshRequest) (*TokenSet, error) {
	if strings.TrimSpace(req.RefreshMaterial) == "" || strings.TrimSpace(req.UpstreamClientID) == "" {
		return nil, NewProviderError(ProviderInvalidRequest, providerOpRefresh, providerMsgRequestInvalid)
	}
	endpoint, err := p.tokenEndpoint(ctx, providerOpRefresh)
	if err != nil {
		return nil, err
	}
	form := url.Values{
		formFieldGrantType:    {grantTypeRefreshToken},
		formFieldRefreshToken: {req.RefreshMaterial},
		formFieldClientID:     {req.UpstreamClientID},
	}
	return p.postToken(ctx, providerOpRefresh, endpoint, form)
}

// postToken performs one bounded, size-capped, redirect-refusing token call and
// maps the result onto the closed provider vocabulary. No part of the upstream
// body reaches the returned error.
func (p *AutheoryProvider) postToken(ctx context.Context, op, endpoint string, form url.Values) (*TokenSet, error) {
	status, body, err := postBoundedForm(ctx, p.client, endpoint, form)
	if err != nil {
		return nil, providerFetchError(op, providerMsgTokenEndpointFailed, err)
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return nil, tokenResponseError(op, status, tokenErrorCode(body))
	}

	var tokenSet TokenSet
	if err := json.Unmarshal(body, &tokenSet); err != nil {
		return nil, NewProviderError(ProviderUpstreamError, op, providerMsgAccessTokenMissing)
	}
	if strings.TrimSpace(tokenSet.AccessToken) == "" {
		return nil, NewProviderError(ProviderUpstreamError, op, providerMsgAccessTokenMissing)
	}
	return &tokenSet, nil
}

// ValidateAccessToken verifies the token against the expectation set and
// returns safe claims. The expectation set selects (and caches) one RS256/JWKS
// validator, so the key cache is reused across calls with the same
// expectations. Any validator failure is an upstream_error: a token the
// upstream cannot vouch for is never accepted, and the reason is never
// forwarded to the client.
func (p *AutheoryProvider) ValidateAccessToken(
	ctx context.Context,
	token string,
	expected TokenExpectations,
) (*TokenClaims, error) {
	jwksURI, err := p.jwksEndpoint(ctx)
	if err != nil {
		return nil, err
	}
	validator, err := p.validatorFor(jwksURI, expected)
	if err != nil {
		return nil, err
	}

	// The expectation set is fixed, so the validator's route-derived audience and
	// scope closures are constants and the SPI's plain context is enough. The
	// key-set fetch stays bounded by the adapter's client timeout.
	claims, err := validator(nil, token)
	if err != nil {
		return nil, providerClassError(
			ProviderUpstreamError, providerOpValidateAccessToken, providerMsgTokenValidationFailed, err)
	}

	return &TokenClaims{
		Subject:         claims.Subject,
		Audience:        claims.Audience,
		Scopes:          append([]string(nil), claims.Scopes...),
		ExpiresAt:       claims.ExpiresAt,
		AuthorizedParty: authorizedPartyFromToken(token),
	}, nil
}

// validatorFor returns the cached validator for one expectation set, building
// it on first use. The cache is insertion-ordered and bounded, so distinct
// expectation sets cannot grow the adapter's state without bound.
func (p *AutheoryProvider) validatorFor(jwksURI string, expected TokenExpectations) (BearerTokenClaimsValidator, error) {
	key := expectationKey(expected)
	p.mu.Lock()
	cached, ok := p.validators[key]
	p.mu.Unlock()
	if ok {
		return cached, nil
	}

	requiredAudience := strings.TrimSpace(expected.ExpectedAudience)
	requiredScopes := append([]string(nil), expected.RequiredScopes...)
	validator, err := NewJWKSValidator(JWKSValidatorOptions{
		Issuer:            strings.TrimSpace(expected.ExpectedIssuer),
		JWKSURI:           jwksURI,
		HTTPClient:        p.client,
		Now:               p.now,
		FetchTimeout:      p.fetchTimeout,
		AllowPrivateHosts: p.allowPrivate,
		AllowedAZP:        expectationAuthorizedParties(expected, p.defaultAZP),
		RequiredAudience: func(*apptheory.Context) (string, error) {
			return requiredAudience, nil
		},
		RequiredScopes: func(*apptheory.Context) ([]string, error) {
			return requiredScopes, nil
		},
	})
	if err != nil {
		return nil, providerClassError(
			ProviderUpstreamError, providerOpValidateAccessToken, providerMsgTokenValidationFailed, err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if existing, ok := p.validators[key]; ok {
		return existing, nil
	}
	if len(p.validatorOrder) >= maxCachedValidators {
		delete(p.validators, p.validatorOrder[0])
		p.validatorOrder = p.validatorOrder[1:]
	}
	p.validators[key] = validator
	p.validatorOrder = append(p.validatorOrder, key)
	return validator, nil
}

// expectationKey derives the validator cache key for one expectation set.
func expectationKey(expected TokenExpectations) tokenExpectationKey {
	return tokenExpectationKey{
		issuer:            strings.TrimSpace(expected.ExpectedIssuer),
		audience:          strings.TrimSpace(expected.ExpectedAudience),
		scopes:            strings.Join(expected.RequiredScopes, providerKeySeparator),
		authorizedParties: strings.Join(expected.AllowedAuthorizedParties, providerKeySeparator),
	}
}

// expectationAuthorizedParties returns the expectation set's own allow-list, or
// the adapter default when the expectation set carries none.
func expectationAuthorizedParties(expected TokenExpectations, fallback []string) []string {
	if len(expected.AllowedAuthorizedParties) > 0 {
		return append([]string(nil), expected.AllowedAuthorizedParties...)
	}
	return append([]string(nil), fallback...)
}

// authorizedPartyFromToken reports the verified token's azp claim, falling back
// to client_id. It only reads claims: the signature was already verified by the
// caller's validator.
func authorizedPartyFromToken(token string) string {
	parsed, err := parseCompactJWS(token)
	if err != nil {
		return ""
	}
	claims, err := parseJWKSClaims(parsed.payload)
	if err != nil {
		return ""
	}
	if value := strings.TrimSpace(claims.AZP); value != "" {
		return value
	}
	return strings.TrimSpace(claims.ClientID)
}

// tokenErrorCode reads the upstream OAuth error code without retaining any
// other part of the body.
func tokenErrorCode(body []byte) string {
	var document struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return ""
	}
	return strings.TrimSpace(document.Error)
}

// isTerminalTokenErrorCode reports whether the upstream named a terminal OAuth
// error, which the facade maps onto the invalid_grant class.
func isTerminalTokenErrorCode(code string) bool {
	switch code {
	case tokenErrorInvalidGrant,
		tokenErrorInvalidClient,
		tokenErrorUnauthorizedClient,
		tokenErrorInvalidScope,
		tokenErrorInvalidRequest,
		tokenErrorAccessDenied,
		tokenErrorExpiredToken,
		tokenErrorInvalidToken:
		return true
	default:
		return false
	}
}

// tokenResponseError maps a non-2xx token response onto the closed provider
// vocabulary. Only an explicit upstream signal produces reauth_required or
// temporarily_unavailable; a 4xx with a terminal OAuth code is a definitive
// grant rejection, and everything else is an upstream_error.
func tokenResponseError(op string, status int, code string) *ProviderError {
	switch code {
	case tokenErrorReauthRequired:
		return NewProviderError(ProviderReauthRequired, op, providerMsgReauthRequired)
	case tokenErrorTemporarilyUnavail:
		return NewProviderError(ProviderTemporarilyUnavailable, op, providerMsgTokenEndpointFailed)
	}
	if status >= http.StatusBadRequest && status < http.StatusInternalServerError && isTerminalTokenErrorCode(code) {
		return NewProviderError(ProviderInvalidGrant, op, providerMsgGrantRejected)
	}
	return NewProviderError(ProviderUpstreamError, op, providerMsgTokenEndpointFailed)
}

// providerFetchError classifies a transport failure: a timeout or connect
// failure is retryable, everything else is an upstream_error. The cause is
// attached for errors.Is/errors.As only.
func providerFetchError(op, message string, err error) *ProviderError {
	if providerTransientFailure(err) {
		return providerClassError(ProviderTemporarilyUnavailable, op, message, err)
	}
	return providerClassError(ProviderUpstreamError, op, message, err)
}

// providerTransientFailure reports whether err is a timeout or connect failure
// the facade may retry.
func providerTransientFailure(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	if errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.EHOSTUNREACH) ||
		errors.Is(err, syscall.ENETUNREACH) {
		return true
	}
	var timeoutErr net.Error
	if errors.As(err, &timeoutErr) && timeoutErr.Timeout() {
		return true
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr)
}

// postBoundedForm performs one bounded upstream POST. It reuses the package's
// transport hygiene (fetch timeout, redirect refusal, SSRF host guard) and the
// same 1 MiB document cap as discovery and JWKS fetching, so the token
// endpoint cannot return an unbounded or redirected body.
func postBoundedForm(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	form url.Values,
) (status int, body []byte, err error) {
	if ctx == nil {
		ctx = context.Background()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, nil, fmt.Errorf("%w: %w", errFetchUnavailable, errDocumentInvalid)
	}
	request.Header.Set(contentTypeHeader, formContentType)
	request.Header.Set(acceptHeader, jsonContentType)

	response, err := client.Do(request)
	if err != nil {
		return 0, nil, fmt.Errorf("%w: %w", errFetchUnavailable, err)
	}
	defer func() {
		if closeErr := response.Body.Close(); closeErr != nil {
			_ = closeErr
		}
	}()

	if response.StatusCode >= http.StatusMultipleChoices && response.StatusCode < http.StatusBadRequest {
		return response.StatusCode, nil, redirectFailure(request.URL, response)
	}

	limit := int64(jwksMaxDocumentBytes)
	body, err = io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return response.StatusCode, nil, fmt.Errorf("%w: %w", errFetchUnavailable, err)
	}
	if int64(len(body)) > limit {
		return response.StatusCode, nil, errResponseTooLarge
	}
	return response.StatusCode, body, nil
}
