package mcpfacade

import (
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

// frontChannelMaxRequestBodyBytes bounds every front-channel POST body before it
// is parsed. The bound is a framework default, deliberately not a FacadeConfig
// field or an environment variable, so no adopter can widen the door; it applies
// to the raw request bytes and a body strictly larger than it fails closed with
// invalid_request. The token endpoint consumes it today and the DCR JSON body
// will inherit the same bound, so the name stays endpoint-neutral.
const frontChannelMaxRequestBodyBytes = 16384

// Status values the front channel writes into the store records it mints.
const (
	frontChannelTransactionStatusPending = "pending"
	frontChannelCodeStatusIssued         = "issued"
)

// facadeError* are the closed client-facing error codes of DESIGN §8. Every
// rejection uses one of these and the fixed description facadeErrorDescriptions
// maps it to, so no response can widen the vocabulary.
const (
	facadeErrorInvalidClient        = "invalid_client"
	facadeErrorInvalidRequest       = "invalid_request"
	facadeErrorInvalidTarget        = "invalid_target"
	facadeErrorInvalidGrant         = "invalid_grant"
	facadeErrorUnsupportedGrantType = "unsupported_grant_type"
	facadeErrorUpstream             = "upstream_error"
)

// errFrontChannelMissing reports a front-channel handler invoked while the
// front-channel field set is not configured. A mounted route can never reach
// it; it exists so a direct call fails closed instead of half-working.
var errFrontChannelMissing = errors.New("mcpfacade: front channel is not configured")

// facadeErrorDescriptions is the closed, fixed client-facing error vocabulary
// of the front channel (DESIGN §8). Every rejection of one error code carries
// the same description, so the response never distinguishes an unknown key from
// a used one (THREAT_MODEL cross-cutting: no oracle).
var facadeErrorDescriptions = map[string]string{
	facadeErrorInvalidClient:        "the client is not registered",
	facadeErrorInvalidRequest:       "the request is missing or has an invalid parameter",
	facadeErrorInvalidTarget:        "the resource is not the resource this route authorizes",
	facadeErrorInvalidGrant:         "the grant is invalid, expired, or already used",
	facadeErrorUnsupportedGrantType: "the grant type is not supported",
	facadeErrorUpstream:             "the upstream authorization server could not complete the request",
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
		return nil, errFrontChannelMissing
	}
	endpoint, err := endpointFromRouteParams(ctx, kind)
	if err != nil {
		return nil, err
	}
	resource, issuer, failure, err := config.authorizeTarget(ctx, endpoint)
	if err != nil || failure != nil {
		return failure, err
	}
	client, failure, err := front.authorizeClient(ctx, firstQueryValue(ctx.Request.Query, "client_id"))
	if err != nil || failure != nil {
		return failure, err
	}
	// Validation order (DESIGN §8.1): client, redirect URI, response_type,
	// S256 PKCE, state, resource, scope. Errors raised before the redirect URI
	// is validated render an error page and never redirect.
	redirectURI := firstQueryValue(ctx.Request.Query, "redirect_uri")
	if !registeredRedirectURI(client.RedirectURIs, redirectURI) {
		// Open-redirect defense: an unmatched redirect URI never redirects.
		return facadeErrorPage(400, facadeErrorInvalidRequest), nil
	}
	clientState := firstQueryValue(ctx.Request.Query, "state")
	challenge, scopes, errCode := config.authorizeParameters(ctx, kind, resource)
	if errCode != "" {
		return facadeClientErrorRedirect(redirectURI, issuer, clientState, errCode)
	}
	upstreamURL, err := config.authorizeUpstreamURL(ctx, front, authorizeUpstreamRequest{
		kind:        kind,
		endpoint:    endpoint,
		clientID:    client.ClientID,
		redirectURI: redirectURI,
		clientState: clientState,
		challenge:   challenge,
		scopes:      scopes,
		resource:    resource,
	})
	if err != nil {
		return nil, err
	}
	if upstreamURL == "" {
		return facadeUpstreamErrorPage(), nil
	}
	return facadeUpstreamRedirect(upstreamURL), nil
}

// authorizeTarget resolves the route resource and the client-facing issuer,
// rendering a request-host failure as its own response.
func (config normalizedConfig) authorizeTarget(
	ctx *apptheory.Context,
	endpoint mcproutes.EndpointPath,
) (string, string, *apptheory.Response, error) {
	resource, failure, err := config.frontChannelRouteResource(ctx, endpoint)
	if err != nil || failure != nil {
		return "", "", failure, err
	}
	issuer, failure, err := config.frontChannelRouteIssuer(ctx, endpoint)
	if err != nil || failure != nil {
		return "", "", failure, err
	}
	return resource, issuer, nil, nil
}

// authorizeClient resolves the registered client or the pre-redirect failure:
// a missing client id is invalid_request and an unknown one is invalid_client,
// both rendered as an error page that never redirects.
func (front *frontChannelConfig) authorizeClient(
	ctx *apptheory.Context,
	rawClientID string,
) (*oauthstore.ClientRecord, *apptheory.Response, error) {
	if strings.TrimSpace(rawClientID) == "" {
		return nil, facadeErrorPage(400, facadeErrorInvalidRequest), nil
	}
	client, err := front.stores.Client.Get(ctx.Context(), oauthstore.HashKey(rawClientID))
	if err != nil {
		if errors.Is(err, oauthstore.ErrClientNotFound) {
			return nil, facadeErrorPage(400, facadeErrorInvalidClient), nil
		}
		return nil, nil, err
	}
	return client, nil, nil
}

// authorizeParameters validates the parameters that follow redirect-URI
// validation and returns the fixed error code to redirect with, or an empty
// code when the request is valid.
func (config normalizedConfig) authorizeParameters(
	ctx *apptheory.Context,
	kind mcproutes.EndpointKind,
	resource string,
) (string, []string, string) {
	query := ctx.Request.Query
	if firstQueryValue(query, "response_type") != "code" {
		return "", nil, facadeErrorInvalidRequest
	}
	challenge := firstQueryValue(query, "code_challenge")
	if firstQueryValue(query, "code_challenge_method") != "S256" || !validS256Challenge(challenge) {
		return "", nil, facadeErrorInvalidRequest
	}
	if requested := strings.TrimSpace(firstQueryValue(query, "resource")); requested != "" &&
		oauth.CanonicalResourceURL(requested) != resource {
		return "", nil, facadeErrorInvalidTarget
	}
	scopes, ok := clampRequestedScopes(query["scope"], config.scopes[kind])
	if !ok {
		return "", nil, facadeErrorInvalidRequest
	}
	return challenge, scopes, ""
}

// authorizeUpstreamRequest carries the validated parts of one authorize request
// to the upstream leg.
type authorizeUpstreamRequest struct {
	kind        mcproutes.EndpointKind
	endpoint    mcproutes.EndpointPath
	clientID    string
	redirectURI string
	clientState string
	challenge   string
	scopes      []string
	resource    string
}

// authorizeUpstreamURL records the single-use transaction and returns the
// upstream authorize URL. An empty URL with a nil error is the provider-call
// failure class.
func (config normalizedConfig) authorizeUpstreamURL(
	ctx *apptheory.Context,
	front *frontChannelConfig,
	request authorizeUpstreamRequest,
) (string, error) {
	hints, err := front.providerHintValues(ctx)
	if err != nil {
		return "", err
	}
	upstreamState, err := oauth.NewOpaqueToken()
	if err != nil {
		return "", err
	}
	codeVerifier, err := oauth.NewPKCECodeVerifier()
	if err != nil {
		return "", err
	}
	upstreamChallenge, err := oauth.PKCEChallengeS256(codeVerifier)
	if err != nil {
		return "", err
	}
	callbackURL, failure, err := config.frontChannelCallbackURL(ctx)
	if err != nil || failure != nil {
		return "", err
	}
	transaction := &oauthstore.TransactionRecord{
		StateHash:                     oauthstore.HashKey(upstreamState),
		ClientIDHash:                  oauthstore.HashKey(request.clientID),
		ClientID:                      request.clientID,
		RedirectURI:                   request.redirectURI,
		CodeChallenge:                 request.challenge,
		CodeChallengeMethod:           "S256",
		ClientState:                   request.clientState,
		EncryptedUpstreamCodeVerifier: codeVerifier,
		Scopes:                        append([]string(nil), request.scopes...),
		CanonicalResource:             request.resource,
		EndpointKind:                  string(request.kind),
		ClientNamespace:               request.endpoint.ClientNamespace,
		PartnerID:                     request.endpoint.PartnerID,
		AgentID:                       request.endpoint.AgentID,
		Status:                        frontChannelTransactionStatusPending,
	}
	if err = front.stores.Transaction.Put(ctx.Context(), transaction); err != nil {
		return "", err
	}
	return front.provider.AuthorizationURL(oauth.AuthorizationRequest{
		UpstreamClientID:    front.upstreamClientID,
		CallbackURL:         callbackURL,
		CodeChallenge:       upstreamChallenge,
		CodeChallengeMethod: "S256",
		State:               upstreamState,
		Resource:            request.resource,
		Scopes:              append(append([]string(nil), request.scopes...), front.lifecycleScopes...),
		Hints:               hints,
	})
}

func (front *frontChannelConfig) providerHintValues(ctx *apptheory.Context) (map[string]string, error) {
	if front.providerHints == nil {
		return nil, nil
	}
	return front.providerHints(ctx)
}

// handleCallback completes the upstream leg (DESIGN §8.2). It verifies the
// upstream RFC 9207 iss before consuming the transaction or exchanging the
// code, so an absent or mismatched iss fails closed without touching state; any
// provider failure after that is the distinct 502 upstream_error class, never
// the facade's own 400.
func (config normalizedConfig) handleCallback(ctx *apptheory.Context) (*apptheory.Response, error) {
	front := config.frontChannel
	if front == nil {
		return nil, errFrontChannelMissing
	}
	if failure := front.verifyUpstreamIssuer(ctx); failure != nil {
		return failure, nil
	}
	code, state, failure := callbackParameters(ctx)
	if failure != nil {
		return failure, nil
	}
	transaction, failure, err := front.consumeTransaction(ctx, state)
	if err != nil || failure != nil {
		return failure, err
	}
	callbackURL, failure, err := config.frontChannelCallbackURL(ctx)
	if err != nil || failure != nil {
		return failure, err
	}
	tokenSet, claims, failure, err := front.exchangeAndValidate(ctx, transaction, code, callbackURL)
	if err != nil || failure != nil {
		return failure, err
	}
	brokerHandle, broker, err := front.openBrokerRecord(ctx, transaction, tokenSet, claims)
	if err != nil {
		return nil, err
	}
	facadeCode, err := front.mintFacadeCode(ctx, transaction, tokenSet, brokerHandle, broker)
	if err != nil {
		return nil, err
	}
	return config.callbackClientRedirect(ctx, transaction, facadeCode)
}

// verifyUpstreamIssuer pins the upstream RFC 9207 iss before anything else is
// consumed or exchanged. An absent or mismatched iss is one 400 class.
func (front *frontChannelConfig) verifyUpstreamIssuer(ctx *apptheory.Context) *apptheory.Response {
	expectedIssuer, ok := oauth.CanonicalizeIssuerURL(front.upstreamIssuer)
	if !ok {
		return facadeErrorPage(400, facadeErrorInvalidRequest)
	}
	claimedIssuer, ok := oauth.CanonicalizeIssuerURL(firstQueryValue(ctx.Request.Query, "iss"))
	if !ok || claimedIssuer != expectedIssuer {
		return facadeErrorPage(400, facadeErrorInvalidRequest)
	}
	return nil
}

func callbackParameters(ctx *apptheory.Context) (string, string, *apptheory.Response) {
	code := strings.TrimSpace(firstQueryValue(ctx.Request.Query, "code"))
	state := strings.TrimSpace(firstQueryValue(ctx.Request.Query, "state"))
	if code == "" || state == "" {
		return "", "", facadeErrorPage(400, facadeErrorInvalidRequest)
	}
	return code, state, nil
}

// consumeTransaction burns the single-use transaction. An unminted, replayed,
// and expired state are one response class: the transaction store burns on
// first consume, so they are indistinguishable and stay indistinguishable on
// purpose (T10).
func (front *frontChannelConfig) consumeTransaction(
	ctx *apptheory.Context,
	state string,
) (*oauthstore.TransactionRecord, *apptheory.Response, error) {
	transaction, err := front.stores.Transaction.Consume(ctx.Context(), oauthstore.HashKey(state))
	if err != nil {
		if errors.Is(err, oauthstore.ErrTransactionNotFound) || errors.Is(err, oauthstore.ErrTransactionExpired) {
			return nil, facadeErrorPage(400, facadeErrorInvalidRequest), nil
		}
		return nil, nil, err
	}
	return transaction, nil, nil
}

// exchangeAndValidate performs the server-side upstream exchange and the
// fail-closed upstream token validation. Every provider failure here is the
// callback's gateway-class 502, never the facade's own 400 vocabulary.
func (front *frontChannelConfig) exchangeAndValidate(
	ctx *apptheory.Context,
	transaction *oauthstore.TransactionRecord,
	code, callbackURL string,
) (*oauth.TokenSet, *oauth.TokenClaims, *apptheory.Response, error) {
	tokenSet, err := front.provider.ExchangeCode(ctx.Context(), oauth.CodeExchangeRequest{
		Code:             code,
		UpstreamClientID: front.upstreamClientID,
		CallbackURL:      callbackURL,
		CodeVerifier:     transaction.EncryptedUpstreamCodeVerifier,
	})
	if err != nil {
		return nil, nil, facadeUpstreamErrorPage(), nil
	}
	claims, err := front.provider.ValidateAccessToken(ctx.Context(), tokenSet.AccessToken, oauth.TokenExpectations{
		ExpectedIssuer:           front.upstreamIssuer,
		ExpectedAudience:         transaction.CanonicalResource,
		AllowedAuthorizedParties: []string{front.upstreamClientID},
	})
	if err != nil {
		return nil, nil, facadeUpstreamErrorPage(), nil
	}
	return tokenSet, claims, nil, nil
}

// openBrokerRecord writes the durable broker record: the only place upstream
// refresh material lands, keyed by hash(route handle). It returns the opaque
// handle as well, because the facade code record carries it so the code
// exchange can hand it to the client.
func (front *frontChannelConfig) openBrokerRecord(
	ctx *apptheory.Context,
	transaction *oauthstore.TransactionRecord,
	tokenSet *oauth.TokenSet,
	claims *oauth.TokenClaims,
) (string, *oauthstore.RouteRefreshBrokerRecord, error) {
	handle, err := oauth.NewOpaqueToken()
	if err != nil {
		return "", nil, err
	}
	seeder, ok := front.stores.RouteRefreshBroker.(oauthstore.RouteRefreshBrokerSeeder)
	if !ok {
		return "", nil, fmt.Errorf("mcpfacade: route refresh broker store cannot be seeded")
	}
	broker := &oauthstore.RouteRefreshBrokerRecord{
		HandleHash:                    oauthstore.HashKey(handle),
		Issuer:                        front.upstreamIssuer,
		CanonicalResource:             transaction.CanonicalResource,
		ClientNamespace:               transaction.ClientNamespace,
		EndpointKind:                  transaction.EndpointKind,
		PartnerID:                     transaction.PartnerID,
		AgentID:                       transaction.AgentID,
		ClientIDHash:                  transaction.ClientIDHash,
		SubjectIDHash:                 oauthstore.HashKey(claims.Subject),
		Scopes:                        append([]string(nil), transaction.Scopes...),
		ScopeFingerprint:              facadeScopeFingerprint(transaction.Scopes),
		EncryptedUpstreamRefreshToken: tokenSet.RefreshToken,
		UpstreamRefreshTokenHash:      oauthstore.HashKey(tokenSet.RefreshToken),
		UpstreamClientID:              front.upstreamClientID,
		Status:                        oauthstore.BrokerStatusIssued,
	}
	if err = seeder.Put(ctx.Context(), broker); err != nil {
		return "", nil, err
	}
	return handle, broker, nil
}

// mintFacadeCode stores the single-use facade code bound to the client, its
// redirect URI, the S256 challenge, the route resource, and the scopes, and
// carrying the opaque route handle and the encrypted token response.
func (front *frontChannelConfig) mintFacadeCode(
	ctx *apptheory.Context,
	transaction *oauthstore.TransactionRecord,
	tokenSet *oauth.TokenSet,
	handle string,
	broker *oauthstore.RouteRefreshBrokerRecord,
) (string, error) {
	facadeCode, err := oauth.NewOpaqueToken()
	if err != nil {
		return "", err
	}
	encodedTokenSet, err := json.Marshal(tokenSet) // #nosec G117 -- the upstream token set is deliberately encrypted at rest by the store, per DESIGN §7; it is not a leaked credential.
	if err != nil {
		return "", err
	}
	record := &oauthstore.AuthorizationCodeRecord{
		CodeHash:                    oauthstore.HashKey(facadeCode),
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
	if err = front.stores.AuthorizationCode.Put(ctx.Context(), record); err != nil {
		return "", err
	}
	return facadeCode, nil
}

// callbackClientRedirect returns the client to its registered redirect URI with
// the facade code, the client's own state, and the client-facing RFC 9207 iss.
func (config normalizedConfig) callbackClientRedirect(
	ctx *apptheory.Context,
	transaction *oauthstore.TransactionRecord,
	facadeCode string,
) (*apptheory.Response, error) {
	issuer, failure, err := config.frontChannelRouteIssuer(ctx, endpointPathFromRecord(transaction))
	if err != nil || failure != nil {
		return failure, err
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
	if config.frontChannel == nil {
		return nil, errFrontChannelMissing
	}
	body := ctx.Request.Body
	if len(body) > frontChannelMaxRequestBodyBytes {
		return facadeErrorPage(400, facadeErrorInvalidRequest), nil
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		return facadeErrorPage(400, facadeErrorInvalidRequest), nil
	}
	switch form.Get("grant_type") {
	case "":
		return facadeErrorPage(400, facadeErrorInvalidRequest), nil
	case "authorization_code":
		return config.handleAuthorizationCodeGrant(ctx, kind, form)
	case "refresh_token":
		// Ruled: the token response issues the refresh handle, but the
		// refresh_token grant is M3c and is refused until then.
		return facadeErrorPage(400, facadeErrorUnsupportedGrantType), nil
	default:
		return facadeErrorPage(400, facadeErrorUnsupportedGrantType), nil
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
		return facadeErrorPage(400, facadeErrorInvalidRequest), nil
	}
	clientID, failure, err := config.tokenClient(ctx, form)
	if err != nil || failure != nil {
		return failure, err
	}
	record, failure, err := front.consumeFacadeCode(ctx, code)
	if err != nil || failure != nil {
		return failure, err
	}
	if failure := verifyCodeBindings(kind, clientID, redirectURI, verifier, form.Get("resource"), record); failure != nil {
		return failure, nil
	}
	return tokenResponse(record)
}

// tokenClient authenticates the public client at the token endpoint: the client
// id must be registered and its record must claim the public auth method. A
// missing and an unknown client are the same invalid_client response.
func (config normalizedConfig) tokenClient(
	ctx *apptheory.Context,
	form url.Values,
) (string, *apptheory.Response, error) {
	clientID := strings.TrimSpace(form.Get("client_id"))
	if clientID == "" {
		return "", facadeErrorPage(400, facadeErrorInvalidClient), nil
	}
	client, err := config.frontChannel.stores.Client.Get(ctx.Context(), oauthstore.HashKey(clientID))
	if err != nil {
		if errors.Is(err, oauthstore.ErrClientNotFound) {
			return "", facadeErrorPage(400, facadeErrorInvalidClient), nil
		}
		return "", nil, err
	}
	if method := strings.TrimSpace(client.TokenEndpointAuthMethod); method != "" && method != "none" {
		return "", facadeErrorPage(400, facadeErrorInvalidClient), nil
	}
	return clientID, nil, nil
}

// consumeFacadeCode redeems the facade code exactly once. A replay returns
// invalid_grant AND revokes the broker record the code minted (T2); an expired
// first consume burns the code and returns invalid_grant.
func (front *frontChannelConfig) consumeFacadeCode(
	ctx *apptheory.Context,
	code string,
) (*oauthstore.AuthorizationCodeRecord, *apptheory.Response, error) {
	record, err := front.stores.AuthorizationCode.Consume(ctx.Context(), oauthstore.HashKey(code))
	switch {
	case errors.Is(err, oauthstore.ErrAuthorizationCodeReplayed):
		if revokeErr := front.revokeRecord(ctx, record); revokeErr != nil {
			return nil, nil, revokeErr
		}
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant), nil
	case errors.Is(err, oauthstore.ErrAuthorizationCodeNotFound), errors.Is(err, oauthstore.ErrAuthorizationCodeExpired):
		return nil, facadeErrorPage(400, facadeErrorInvalidGrant), nil
	case err != nil:
		return nil, nil, err
	}
	return record, nil, nil
}

// revokeRecord kills the broker record a replayed code minted. A handle that is
// already gone is not an error: revocation is idempotent.
func (front *frontChannelConfig) revokeRecord(
	ctx *apptheory.Context,
	record *oauthstore.AuthorizationCodeRecord,
) error {
	if record == nil || record.RouteRefreshHandleHash == "" {
		return nil
	}
	if _, err := front.stores.RouteRefreshBroker.Revoke(ctx.Context(), record.RouteRefreshHandleHash); err != nil &&
		!errors.Is(err, oauthstore.ErrBrokerNotFound) {
		return err
	}
	return nil
}

// verifyCodeBindings checks that the redeemed code belongs to this client, this
// redirect URI, this route kind, and this S256 verifier, and that any presented
// resource is the resource the code was minted for.
func verifyCodeBindings(
	kind mcproutes.EndpointKind,
	clientID, redirectURI, verifier, resource string,
	record *oauthstore.AuthorizationCodeRecord,
) *apptheory.Response {
	if record.ClientID != clientID ||
		record.RedirectURI != redirectURI ||
		record.EndpointKind != string(kind) ||
		record.CodeChallengeMethod != "S256" {
		return facadeErrorPage(400, facadeErrorInvalidGrant)
	}
	verified, err := oauth.PKCEVerifyS256(verifier, record.CodeChallenge)
	if err != nil || !verified {
		return facadeErrorPage(400, facadeErrorInvalidGrant)
	}
	if strings.TrimSpace(resource) != "" && oauth.CanonicalResourceURL(resource) != record.CanonicalResource {
		return facadeErrorPage(400, facadeErrorInvalidTarget)
	}
	return nil
}

// tokenResponse renders the token endpoint's success body: the upstream access
// token byte-for-byte unmodified, the upstream token type, expiry, and scope,
// and the framework-minted opaque refresh handle. It never carries an id_token
// or any upstream refresh material.
func tokenResponse(record *oauthstore.AuthorizationCodeRecord) (*apptheory.Response, error) {
	var tokenSet oauth.TokenSet
	if err := json.Unmarshal([]byte(record.EncryptedTokenResponse), &tokenSet); err != nil {
		return nil, fmt.Errorf("mcpfacade: facade code record does not carry a token response: %w", err)
	}
	body, err := json.Marshal(facadeTokenPayload{ // #nosec G117 -- the access token is deliberately returned to the client it was minted for, per DESIGN §8.4; only upstream refresh material and id_token are withheld.
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

// facadeTokenPayload is the token response the facade returns (DESIGN §8.4).
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
	body, err := json.Marshal(facadeErrorPayload{Error: code, ErrorDescription: facadeErrorDescriptions[code]})
	if err != nil {
		// Unreachable for this fixed-structure payload; fail closed with a
		// fixed body rather than an unencoded one.
		body = []byte(`{"error":facadeErrorInvalidRequest,"error_description":"the request is missing or has an invalid parameter"}`)
	}
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
	return facadeErrorPage(502, facadeErrorUpstream)
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
		if candidate == requested || loopbackRedirectMatch(candidate, requested) {
			return true
		}
	}
	return false
}

// loopbackRedirectMatch allows the ephemeral-port form of RFC 8252 §7.3: a
// loopback redirect URI matches on scheme, host, path, query, and fragment while
// the port alone is free to differ — or to be absent on either side — because a
// native client obtains its loopback port from the OS at request time. The port
// is therefore the only component excluded from the comparison, so the match
// never widens beyond the client's own registered loopback redirect: the host
// must be the same loopback host and the scheme/path/query/fragment must match
// exactly (DESIGN §8.1, "loopback port flexibility only").
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
	if !strings.EqualFold(registeredURL.Hostname(), requestedURL.Hostname()) {
		return false
	}
	if registeredURL.Scheme != requestedURL.Scheme || registeredURL.Path != requestedURL.Path {
		return false
	}
	if registeredURL.RawQuery != requestedURL.RawQuery || registeredURL.Fragment != requestedURL.Fragment {
		return false
	}
	return true
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
	return oauthstore.HashKey(strings.Join(sorted, " "))
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
	return config.handleCallback
}
