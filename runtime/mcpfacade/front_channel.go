package mcpfacade

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

// Status values the front channel writes into the store records it mints.
const (
	frontChannelTransactionStatusPending = "pending"
	frontChannelCodeStatusIssued         = "issued"
)

// facadeErrorDescriptions is the closed, fixed client-facing error vocabulary
// of the front channel (DESIGN §8). Every rejection of one error code carries
// the same description, so the response never distinguishes an unknown key from
// a used one (THREAT_MODEL cross-cutting: no oracle).
var facadeErrorDescriptions = map[string]string{
	"invalid_client":         "the client is not registered",
	"invalid_request":        "the request is missing or has an invalid parameter",
	"invalid_target":         "the resource is not the resource this route authorizes",
	"invalid_grant":          "the grant is invalid, expired, or already used",
	"unsupported_grant_type": "the grant type is not supported",
	"upstream_error":         "the upstream authorization server could not complete the request",
}

// frontChannelConfig is the validated front-channel field set of FacadeConfig
// (DESIGN §8): the provider adapter and stores the front channel drives, the
// facade's own upstream client, the expected upstream issuer, the injectable
// lifecycle scopes, and the opaque provider-hint seam.
type frontChannelConfig struct {
	provider         oauth.Provider
	stores           oauthstore.Stores
	upstreamClientID string
	upstreamIssuer   string
	lifecycleScopes  []string
	providerHints    func(*apptheory.Context) (map[string]string, error)
}

// normalizeFrontChannel validates the front-channel field set and returns it.
// A nil result means the front channel is not declared: the application either
// owns the OAuth surface through its handler factories or registers none.
func normalizeFrontChannel(config FacadeConfig) (*frontChannelConfig, error) {
	if config.Provider == nil {
		if name, set := frontChannelFieldOutsideProvider(config); set {
			return nil, fmt.Errorf(
				"mcpfacade: %s is set without Provider; the front-channel field set is anchored by Provider",
				name,
			)
		}
		return nil, nil
	}
	upstreamIssuer, ok := normalizeHTTPSURL(config.UpstreamIssuer, true)
	if !ok {
		return nil, fmt.Errorf("mcpfacade: front channel upstream issuer must be an absolute HTTPS URL without query or fragment")
	}
	if !validUpstreamClientID(config.UpstreamClientID) {
		return nil, fmt.Errorf("mcpfacade: front channel upstream client id is required and must be well-formed")
	}
	if len(config.LifecycleScopes) > 0 {
		if _, err := normalizeNonEmptyList("lifecycle scope", config.LifecycleScopes); err != nil {
			return nil, fmt.Errorf("mcpfacade: %w", err)
		}
	}
	if err := validateFrontChannelStores(config.Stores); err != nil {
		return nil, err
	}
	if config.AuthorizeHandler != nil || config.TokenHandler != nil {
		return nil, fmt.Errorf("mcpfacade: Provider owns the authorize and token routes; AuthorizeHandler and TokenHandler must not be configured with a front channel")
	}
	if config.CallbackHandler != nil {
		return nil, fmt.Errorf("mcpfacade: Provider owns the stage-global callback; CallbackHandler must not be configured with a front channel")
	}
	return &frontChannelConfig{
		provider:         config.Provider,
		stores:           config.Stores,
		upstreamClientID: strings.TrimSpace(config.UpstreamClientID),
		upstreamIssuer:   upstreamIssuer,
		lifecycleScopes:  append([]string(nil), config.LifecycleScopes...),
		providerHints:    config.ProviderHints,
	}, nil
}

// handleAuthorize terminates the client-facing front channel (DESIGN §8.1):
// it validates the registered client and its exact redirect URI before any
// redirect, requires S256 PKCE, records a single-use transaction, and sends the
// browser upstream with the facade's own client, callback, PKCE verifier, fresh
// state, resource, hints, and clamped scope set.
func (config normalizedConfig) handleAuthorize(kind mcproutes.EndpointKind, ctx *apptheory.Context) (*apptheory.Response, error) {
	front := config.frontChannel
	if front == nil {
		return nil, fmt.Errorf("mcpfacade: front channel is not configured")
	}
	endpoint, err := endpointFromRouteParams(ctx, kind)
	if err != nil {
		return nil, err
	}
	resource, routeFailure, err := config.frontChannelRouteResource(ctx, endpoint)
	if err != nil || routeFailure != nil {
		return routeFailure, err
	}
	issuer, routeFailure, err := config.frontChannelRouteIssuer(ctx, endpoint)
	if err != nil || routeFailure != nil {
		return routeFailure, err
	}

	// Validation order (DESIGN §8.1): client, redirect URI, response_type,
	// S256 PKCE, state, resource, scope. Errors raised before the redirect URI
	// is validated render an error page and never redirect.
	clientID := firstQueryValue(ctx.Request.Query, "client_id")
	if strings.TrimSpace(clientID) == "" {
		return facadeErrorPage(400, "invalid_request"), nil
	}
	client, err := front.stores.Client.Get(ctx.Context(), facadeKeyHash(clientID))
	if err != nil {
		if errors.Is(err, oauthstore.ErrClientNotFound) {
			return facadeErrorPage(400, "invalid_client"), nil
		}
		return nil, err
	}

	redirectURI := firstQueryValue(ctx.Request.Query, "redirect_uri")
	if !registeredRedirectURI(client.RedirectURIs, redirectURI) {
		// Open-redirect defense: an unmatched redirect URI never redirects.
		return facadeErrorPage(400, "invalid_request"), nil
	}
	clientState := firstQueryValue(ctx.Request.Query, "state")
	if firstQueryValue(ctx.Request.Query, "response_type") != "code" {
		return facadeClientErrorRedirect(redirectURI, issuer, clientState, "invalid_request")
	}
	challenge := firstQueryValue(ctx.Request.Query, "code_challenge")
	if firstQueryValue(ctx.Request.Query, "code_challenge_method") != "S256" ||
		!validS256Challenge(challenge) {
		return facadeClientErrorRedirect(redirectURI, issuer, clientState, "invalid_request")
	}
	requestedResource := strings.TrimSpace(firstQueryValue(ctx.Request.Query, "resource"))
	if requestedResource != "" && oauth.CanonicalResourceURL(requestedResource) != resource {
		return facadeClientErrorRedirect(redirectURI, issuer, clientState, "invalid_target")
	}
	scopes, ok := clampRequestedScopes(ctx.Request.Query["scope"], config.scopes[kind])
	if !ok {
		return facadeClientErrorRedirect(redirectURI, issuer, clientState, "invalid_request")
	}
	upstreamScopes := append(append([]string(nil), scopes...), front.lifecycleScopes...)

	hints := map[string]string(nil)
	if front.providerHints != nil {
		hints, err = front.providerHints(ctx)
		if err != nil {
			return facadeErrorPage(400, "invalid_request"), nil
		}
	}

	upstreamState, err := oauth.NewOpaqueToken()
	if err != nil {
		return nil, err
	}
	codeVerifier, err := oauth.NewPKCECodeVerifier()
	if err != nil {
		return nil, err
	}
	upstreamChallenge, err := oauth.PKCEChallengeS256(codeVerifier)
	if err != nil {
		return nil, err
	}
	callbackURL, routeFailure, err := config.frontChannelCallbackURL(ctx)
	if err != nil || routeFailure != nil {
		return routeFailure, err
	}

	transaction := &oauthstore.TransactionRecord{
		StateHash:                     facadeKeyHash(upstreamState),
		ClientIDHash:                  facadeKeyHash(clientID),
		ClientID:                      clientID,
		RedirectURI:                   redirectURI,
		CodeChallenge:                 challenge,
		CodeChallengeMethod:           "S256",
		ClientState:                   clientState,
		EncryptedUpstreamCodeVerifier: codeVerifier,
		Scopes:                        append([]string(nil), scopes...),
		CanonicalResource:             resource,
		EndpointKind:                  string(kind),
		ClientNamespace:               endpoint.ClientNamespace,
		PartnerID:                     endpoint.PartnerID,
		AgentID:                       endpoint.AgentID,
		Status:                        frontChannelTransactionStatusPending,
	}
	if err := front.stores.Transaction.Put(ctx.Context(), transaction); err != nil {
		return nil, err
	}

	upstreamURL, err := front.provider.AuthorizationURL(oauth.AuthorizationRequest{
		UpstreamClientID:    front.upstreamClientID,
		CallbackURL:         callbackURL,
		CodeChallenge:       upstreamChallenge,
		CodeChallengeMethod: "S256",
		State:               upstreamState,
		Resource:            resource,
		Scopes:              upstreamScopes,
		Hints:               hints,
	})
	if err != nil {
		return facadeUpstreamErrorPage(), nil
	}
	return facadeUpstreamRedirect(upstreamURL), nil
}

// handleCallback completes the upstream leg (DESIGN §8.2). It verifies the
// upstream RFC 9207 iss before consuming the transaction or exchanging the
// code, so an absent or mismatched iss fails closed without touching state; any
// provider failure after that is the distinct 502 upstream_error class, never
// the facade's own 400.
func (config normalizedConfig) handleCallback(ctx *apptheory.Context) (*apptheory.Response, error) {
	front := config.frontChannel
	if front == nil {
		return nil, fmt.Errorf("mcpfacade: front channel is not configured")
	}
	expectedIssuer, ok := oauth.CanonicalizeIssuerURL(front.upstreamIssuer)
	if !ok {
		return nil, fmt.Errorf("mcpfacade: front channel upstream issuer is not canonicalizable")
	}
	claimedIssuer, ok := oauth.CanonicalizeIssuerURL(firstQueryValue(ctx.Request.Query, "iss"))
	if !ok || claimedIssuer != expectedIssuer {
		return facadeErrorPage(400, "invalid_request"), nil
	}
	code := strings.TrimSpace(firstQueryValue(ctx.Request.Query, "code"))
	state := strings.TrimSpace(firstQueryValue(ctx.Request.Query, "state"))
	if code == "" || state == "" {
		return facadeErrorPage(400, "invalid_request"), nil
	}

	transaction, err := front.stores.Transaction.Consume(ctx.Context(), facadeKeyHash(state))
	if err != nil {
		// An unminted, replayed, and expired state are one response class: the
		// transaction store burns on first consume, so they are indistinguishable
		// and stay indistinguishable on purpose (T10).
		if errors.Is(err, oauthstore.ErrTransactionNotFound) || errors.Is(err, oauthstore.ErrTransactionExpired) {
			return facadeErrorPage(400, "invalid_request"), nil
		}
		return nil, err
	}

	callbackURL, routeFailure, err := config.frontChannelCallbackURL(ctx)
	if err != nil || routeFailure != nil {
		return routeFailure, err
	}
	tokenSet, err := front.provider.ExchangeCode(ctx.Context(), oauth.CodeExchangeRequest{
		Code:             code,
		UpstreamClientID: front.upstreamClientID,
		CallbackURL:      callbackURL,
		CodeVerifier:     transaction.EncryptedUpstreamCodeVerifier,
	})
	if err != nil {
		return facadeUpstreamErrorPage(), nil
	}
	claims, err := front.provider.ValidateAccessToken(ctx.Context(), tokenSet.AccessToken, oauth.TokenExpectations{
		ExpectedIssuer:           front.upstreamIssuer,
		ExpectedAudience:         transaction.CanonicalResource,
		AllowedAuthorizedParties: []string{front.upstreamClientID},
	})
	if err != nil {
		return facadeUpstreamErrorPage(), nil
	}

	handle, err := oauth.NewOpaqueToken()
	if err != nil {
		return nil, err
	}
	seeder, ok := front.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerSeeder)
	if !ok {
		return nil, fmt.Errorf("mcpfacade: route refresh broker store cannot be seeded")
	}
	broker := &oauthstore.RouteRefreshBrokerRecord{
		HandleHash:                    facadeKeyHash(handle),
		Issuer:                        front.upstreamIssuer,
		CanonicalResource:             transaction.CanonicalResource,
		ClientNamespace:               transaction.ClientNamespace,
		EndpointKind:                  transaction.EndpointKind,
		PartnerID:                     transaction.PartnerID,
		AgentID:                       transaction.AgentID,
		ClientIDHash:                  transaction.ClientIDHash,
		SubjectIDHash:                 facadeKeyHash(claims.Subject),
		Scopes:                        append([]string(nil), transaction.Scopes...),
		ScopeFingerprint:              facadeScopeFingerprint(transaction.Scopes),
		EncryptedUpstreamRefreshToken: tokenSet.RefreshToken,
		UpstreamRefreshTokenHash:      facadeKeyHash(tokenSet.RefreshToken),
		UpstreamClientID:              front.upstreamClientID,
		Status:                        oauthstore.BrokerStatusIssued,
	}
	if err := seeder.Put(ctx.Context(), broker); err != nil {
		return nil, err
	}

	facadeCode, err := oauth.NewOpaqueToken()
	if err != nil {
		return nil, err
	}
	encodedTokenSet, err := json.Marshal(tokenSet)
	if err != nil {
		return nil, err
	}
	codeRecord := &oauthstore.AuthorizationCodeRecord{
		CodeHash:                    facadeKeyHash(facadeCode),
		ClientIDHash:                transaction.ClientIDHash,
		ClientID:                    transaction.ClientID,
		RedirectURI:                 transaction.RedirectURI,
		CodeChallenge:               transaction.CodeChallenge,
		CodeChallengeMethod:         transaction.CodeChallengeMethod,
		Scopes:                      append([]string(nil), transaction.Scopes...),
		CanonicalResource:           transaction.CanonicalResource,
		EndpointKind:                transaction.EndpointKind,
		ClientNamespace:             transaction.ClientNamespace,
		PartnerID:                   transaction.PartnerID,
		AgentID:                     transaction.AgentID,
		RouteRefreshHandleHash:      broker.HandleHash,
		EncryptedRouteRefreshHandle: handle,
		EncryptedTokenResponse:      string(encodedTokenSet),
		Status:                      frontChannelCodeStatusIssued,
	}
	if err := front.stores.AuthorizationCode.Put(ctx.Context(), codeRecord); err != nil {
		return nil, err
	}

	issuer, routeFailure, err := config.frontChannelRouteIssuer(ctx, endpointPathFromRecord(transaction))
	if err != nil || routeFailure != nil {
		return routeFailure, err
	}
	values := url.Values{"code": {facadeCode}, "iss": {issuer}}
	if transaction.ClientState != "" {
		values.Set("state", transaction.ClientState)
	}
	return facadeClientRedirect(transaction.RedirectURI, values), nil
}

// handleToken serves the token endpoint (DESIGN §8.4). M3b owns the
// authorization_code grant; the brokered refresh grant is M3c and answers
// unsupported_grant_type until it lands, so no adopter assumes it works.
func (config normalizedConfig) handleToken(kind mcproutes.EndpointKind, ctx *apptheory.Context) (*apptheory.Response, error) {
	front := config.frontChannel
	if front == nil {
		return nil, fmt.Errorf("mcpfacade: front channel is not configured")
	}
	form, err := url.ParseQuery(string(ctx.Request.Body))
	if err != nil {
		return facadeErrorPage(400, "invalid_request"), nil
	}
	switch form.Get("grant_type") {
	case "":
		return facadeErrorPage(400, "invalid_request"), nil
	case "authorization_code":
		return config.handleAuthorizationCodeGrant(ctx, kind, form)
	case "refresh_token":
		// Ruled: the token response issues the refresh handle, but the
		// refresh_token grant is M3c and is refused until then.
		return facadeErrorPage(400, "unsupported_grant_type"), nil
	default:
		return facadeErrorPage(400, "unsupported_grant_type"), nil
	}
}

func (config normalizedConfig) handleAuthorizationCodeGrant(
	ctx *apptheory.Context,
	kind mcproutes.EndpointKind,
	form url.Values,
) (*apptheory.Response, error) {
	front := config.frontChannel
	code := strings.TrimSpace(form.Get("code"))
	redirectURI := form.Get("redirect_uri")
	verifier := form.Get("code_verifier")
	if code == "" || strings.TrimSpace(redirectURI) == "" || strings.TrimSpace(verifier) == "" {
		return facadeErrorPage(400, "invalid_request"), nil
	}
	clientID := strings.TrimSpace(form.Get("client_id"))
	if clientID == "" {
		return facadeErrorPage(400, "invalid_client"), nil
	}
	client, err := front.stores.Client.Get(ctx.Context(), facadeKeyHash(clientID))
	if err != nil {
		if errors.Is(err, oauthstore.ErrClientNotFound) {
			return facadeErrorPage(400, "invalid_client"), nil
		}
		return nil, err
	}
	// Only public clients are registered through the facade; a client record
	// that claims another authentication method fails closed.
	if method := strings.TrimSpace(client.TokenEndpointAuthMethod); method != "" && method != "none" {
		return facadeErrorPage(400, "invalid_client"), nil
	}

	record, err := front.stores.AuthorizationCode.Consume(ctx.Context(), facadeKeyHash(code))
	switch {
	case errors.Is(err, oauthstore.ErrAuthorizationCodeReplayed):
		// T2: a replayed code revokes the broker record it minted, so the
		// refresh handle from that authorization dies with the replay.
		if record != nil && record.RouteRefreshHandleHash != "" {
			if _, revokeErr := front.stores.RouteRefreshBroker.Revoke(ctx.Context(), record.RouteRefreshHandleHash); revokeErr != nil && !errors.Is(revokeErr, oauthstore.ErrBrokerNotFound) {
				return nil, revokeErr
			}
		}
		return facadeErrorPage(400, "invalid_grant"), nil
	case errors.Is(err, oauthstore.ErrAuthorizationCodeNotFound), errors.Is(err, oauthstore.ErrAuthorizationCodeExpired):
		return facadeErrorPage(400, "invalid_grant"), nil
	case err != nil:
		return nil, err
	}

	if record.ClientID != clientID ||
		record.RedirectURI != redirectURI ||
		record.EndpointKind != string(kind) ||
		record.CodeChallengeMethod != "S256" {
		return facadeErrorPage(400, "invalid_grant"), nil
	}
	verified, err := oauth.PKCEVerifyS256(verifier, record.CodeChallenge)
	if err != nil || !verified {
		return facadeErrorPage(400, "invalid_grant"), nil
	}
	if resource := strings.TrimSpace(form.Get("resource")); resource != "" &&
		oauth.CanonicalResourceURL(resource) != record.CanonicalResource {
		return facadeErrorPage(400, "invalid_target"), nil
	}

	var tokenSet oauth.TokenSet
	if err := json.Unmarshal([]byte(record.EncryptedTokenResponse), &tokenSet); err != nil {
		return nil, fmt.Errorf("mcpfacade: facade code record does not carry a token response: %w", err)
	}
	body, err := json.Marshal(facadeTokenPayload{
		AccessToken:  tokenSet.AccessToken,
		TokenType:    tokenSet.TokenType,
		ExpiresIn:    tokenSet.ExpiresIn,
		Scope:        tokenSet.Scope,
		RefreshToken: record.EncryptedRouteRefreshHandle,
	})
	if err != nil {
		return nil, err
	}
	return &apptheory.Response{
		Status: 200,
		Headers: map[string][]string{
			"content-type":  {"application/json; charset=utf-8"},
			"cache-control": {"no-store"},
			"pragma":        {"no-cache"},
		},
		Body: body,
	}, nil
}

// facadeTokenPayload is the token response the facade returns (DESIGN §8.4):
// the upstream access token byte-for-byte unmodified, the upstream token type,
// expiry, and scope, and the framework-minted opaque refresh handle. It never
// carries an id_token or any upstream refresh material.
type facadeTokenPayload struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in,omitempty"`
	Scope        string `json:"scope,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

type facadeErrorPayload struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// facadeErrorPage renders a facade rejection that never redirects (DESIGN
// §8.1/§8.2): the fixed error vocabulary, no upstream material, and no
// cacheable representation.
func facadeErrorPage(status int, code string) *apptheory.Response {
	body, _ := json.Marshal(facadeErrorPayload{Error: code, ErrorDescription: facadeErrorDescriptions[code]})
	return &apptheory.Response{
		Status: status,
		Headers: map[string][]string{
			"content-type":  {"application/json; charset=utf-8"},
			"cache-control": {"no-store"},
			"pragma":        {"no-cache"},
		},
		Body: body,
	}
}

// facadeUpstreamErrorPage is the gateway-class provider failure (DESIGN §8.2):
// a distinct 502 carrying upstream_error, never the facade's 400 vocabulary.
func facadeUpstreamErrorPage() *apptheory.Response {
	return facadeErrorPage(502, "upstream_error")
}

// facadeClientErrorRedirect sends an authorization error back to the client's
// validated redirect URI, carrying the fixed error code, the client's own
// state, and the client-facing RFC 9207 iss (FRAMEWORK_VS_POLICY row 1).
func facadeClientErrorRedirect(redirectURI, issuer, clientState, code string) (*apptheory.Response, error) {
	values := url.Values{"error": {code}, "iss": {issuer}}
	if description := facadeErrorDescriptions[code]; description != "" {
		values.Set("error_description", description)
	}
	if clientState != "" {
		values.Set("state", clientState)
	}
	return facadeClientRedirect(redirectURI, values), nil
}

// facadeClientRedirect appends values to the client's redirect URI without
// rewriting the URI itself, so the redirect target stays byte-identical to the
// registered value.
func facadeClientRedirect(target string, values url.Values) *apptheory.Response {
	location := target
	if encoded := values.Encode(); encoded != "" {
		separator := "?"
		if strings.Contains(location, "?") {
			separator = "&"
		}
		location += separator + encoded
	}
	return &apptheory.Response{
		Status: 302,
		Headers: map[string][]string{
			"location":      {location},
			"cache-control": {"no-store"},
			"pragma":        {"no-cache"},
		},
	}
}

// facadeUpstreamRedirect sends the browser to the upstream authorize URL.
func facadeUpstreamRedirect(target string) *apptheory.Response {
	return &apptheory.Response{
		Status: 302,
		Headers: map[string][]string{
			"location":      {target},
			"cache-control": {"no-store"},
			"pragma":        {"no-cache"},
		},
	}
}

func (config normalizedConfig) frontChannelRouteResource(
	ctx *apptheory.Context,
	endpoint mcproutes.EndpointPath,
) (string, *apptheory.Response, error) {
	mcpPath, err := endpoint.MCPPath()
	if err != nil {
		return "", nil, err
	}
	resource, err := config.absoluteURL(ctx, mcpPath)
	if err != nil {
		if response, ok := metadataRequestFailure(err); ok {
			return "", response, nil
		}
		return "", nil, err
	}
	return resource, nil, nil
}

// frontChannelRouteIssuer is the client-facing issuer: the route URL in route
// issuer mode and the configured family issuer otherwise (DESIGN §3.3).
func (config normalizedConfig) frontChannelRouteIssuer(
	ctx *apptheory.Context,
	endpoint mcproutes.EndpointPath,
) (string, *apptheory.Response, error) {
	if config.issuerMode != mcproutes.IssuerModeRoute {
		return config.issuerURL, nil, nil
	}
	return config.frontChannelRouteResource(ctx, endpoint)
}

func (config normalizedConfig) frontChannelCallbackURL(
	ctx *apptheory.Context,
) (string, *apptheory.Response, error) {
	callbackURL, err := config.absoluteURL(ctx, config.upstreamCallbackPath)
	if err != nil {
		if response, ok := metadataRequestFailure(err); ok {
			return "", response, nil
		}
		return "", nil, err
	}
	return callbackURL, nil, nil
}

func endpointPathFromRecord(record *oauthstore.TransactionRecord) mcproutes.EndpointPath {
	return mcproutes.EndpointPath{
		Kind:            mcproutes.EndpointKind(record.EndpointKind),
		ClientNamespace: record.ClientNamespace,
		PartnerID:       record.PartnerID,
		AgentID:         record.AgentID,
	}
}

// registeredRedirectURI reports whether the request redirect URI matches one of
// the client's registered URIs exactly, allowing RFC 8252 §7.3 loopback port
// flexibility only.
func registeredRedirectURI(registered []string, requested string) bool {
	if strings.TrimSpace(requested) == "" {
		return false
	}
	for _, candidate := range registered {
		if candidate == requested {
			return true
		}
		if loopbackRedirectMatch(candidate, requested) {
			return true
		}
	}
	return false
}

// loopbackRedirectMatch allows the ephemeral-port form of RFC 8252 §7.3: a
// loopback IP-literal redirect may be presented with a different port.
func loopbackRedirectMatch(registered, requested string) bool {
	registeredURL, ok := parseAbsoluteURL(registered)
	if !ok {
		return false
	}
	requestedURL, ok := parseAbsoluteURL(requested)
	if !ok {
		return false
	}
	if !isLoopbackHost(registeredURL.Hostname()) || !isLoopbackHost(requestedURL.Hostname()) {
		return false
	}
	if registeredURL.Scheme != requestedURL.Scheme || registeredURL.Path != requestedURL.Path {
		return false
	}
	if registeredURL.RawQuery != requestedURL.RawQuery || registeredURL.Fragment != requestedURL.Fragment {
		return false
	}
	if registeredURL.Port() == "" || requestedURL.Port() == "" {
		return false
	}
	return registeredURL.Port() != requestedURL.Port()
}

func isLoopbackHost(hostname string) bool {
	switch strings.ToLower(hostname) {
	case "127.0.0.1", "::1", "localhost":
		return true
	default:
		return false
	}
}

// validS256Challenge reports whether a PKCE challenge is the RFC 7636 S256
// shape: 43 base64url characters.
func validS256Challenge(challenge string) bool {
	if len(challenge) != 43 {
		return false
	}
	for _, character := range challenge {
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '-', character == '_':
		default:
			return false
		}
	}
	return true
}

// clampRequestedScopes clamps a client request to the route scope set: an
// absent request takes the route set, a present one is intersected with it in
// route order, and a request that survives to nothing fails closed instead of
// silently broadening to the route set.
func clampRequestedScopes(requested []string, allowed []string) ([]string, bool) {
	if len(requested) == 0 {
		return append([]string(nil), allowed...), true
	}
	wanted := make(map[string]struct{})
	for _, raw := range requested {
		for _, value := range strings.Fields(raw) {
			wanted[value] = struct{}{}
		}
	}
	clamped := make([]string, 0, len(allowed))
	for _, value := range allowed {
		if _, ok := wanted[value]; ok {
			clamped = append(clamped, value)
		}
	}
	if len(clamped) == 0 {
		return nil, false
	}
	return clamped, true
}

func facadeScopeFingerprint(scopes []string) string {
	sorted := append([]string(nil), scopes...)
	sort.Strings(sorted)
	return facadeKeyHash(strings.Join(sorted, " "))
}

// facadeKeyHash is the store key derivation of DESIGN §7, shared with
// oauthstore.HashKey so a caller that seeds a record and the facade that looks
// it up derive the same key.
func facadeKeyHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func firstQueryValue(query map[string][]string, name string) string {
	values := query[name]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

// authorizeHandlerFor and tokenHandlerFor build the framework-owned per-kind
// OAuth handlers; callbackHandlerFor builds the one stage-global callback. They
// are only called when the front-channel field set is declared.
func (config normalizedConfig) authorizeHandlerFor(kind mcproutes.EndpointKind) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return config.handleAuthorize(kind, ctx)
	}
}

func (config normalizedConfig) tokenHandlerFor(kind mcproutes.EndpointKind) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return config.handleToken(kind, ctx)
	}
}

func (config normalizedConfig) callbackHandlerFor() apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return config.handleCallback(ctx)
	}
}
