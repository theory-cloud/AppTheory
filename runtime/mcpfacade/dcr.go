package mcpfacade

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

// DCR framework defaults (DESIGN §8.3 / THREAT_MODEL T5). They are constants, so
// no adopter can widen the public registration door with a FacadeConfig field or
// an environment variable: every POST /register decision is bounded by these
// fixed values.
const (
	// frontChannelDCRRateLimit is the per-route registration budget of one rate
	// limit window. It is deliberately small: a legitimate client registers once,
	// so a caller that needs more is abusing the endpoint.
	frontChannelDCRRateLimit = 10
	// frontChannelDCRRateLimitWindow is the rate limit window. One minute matches
	// the reference store's own default window.
	frontChannelDCRRateLimitWindow = time.Minute
	// frontChannelDCRMaxRedirectURIs bounds the redirect URI list one client may
	// register. It is a metadata-list bound, not a redirect-URI policy: each entry
	// still has to pass the https-or-loopback rule below.
	frontChannelDCRMaxRedirectURIs = 10
	// frontChannelDCRMaxClientName bounds client_name in UTF-8 bytes. The value is
	// stored for display only and never parsed.
	frontChannelDCRMaxClientName = 256
	// frontChannelDCRMaxScope bounds the requested scope string in UTF-8 bytes.
	// The string is metadata: the facade never grants a scope from it, because
	// scope policy stays application-owned (FacadeConfig.Scopes).
	frontChannelDCRMaxScope = 1024
)

// Registration vocabulary. These are the only metadata values the framework
// accepts, so a port cannot widen them by accident.
const (
	dcrTokenEndpointAuthMethodNone = "none"
	dcrGrantTypeAuthorizationCode  = "authorization_code"
	dcrGrantTypeRefreshToken       = "refresh_token"
	dcrResponseTypeCode            = "code"
)

// frontChannelDCROperation names the rate-limit operation bucket of this
// endpoint in the (identifier, resource, operation) rate-limit key.
const frontChannelDCROperation = "dcr"

// frontChannelDCRAnonymousIdentifier is the shared rate-limit bucket identifier
// used when the runtime exposes no provider-derived source IP. An unidentifiable
// caller gets one shared per-route bucket rather than an unmetered one, which is
// the stricter fail-closed choice (THREAT_MODEL T5). It mirrors the transport
// middleware's anonymous identifier.
const frontChannelDCRAnonymousIdentifier = "anonymous"

// dcrError* are the closed client-facing error codes of the registration
// endpoint (RFC 7591 §3.2.2 plus the RFC 6749 temporary-failure class). Every
// rejection uses one of these and the fixed description dcrErrorDescriptions
// maps it to, and the registration endpoint never reuses the OAuth grant error
// vocabulary of facadeErrorDescriptions: a client that sees one of these codes
// knows the failure came from registration, not from a token request.
const (
	dcrErrorInvalidClientMetadata  = "invalid_client_metadata"
	dcrErrorInvalidRedirectURI     = "invalid_redirect_uri"
	dcrErrorTemporarilyUnavailable = "temporarily_unavailable"
)

// dcrErrorDescriptions is the closed, fixed client-facing error vocabulary of
// the registration endpoint. Every rejection of one error code carries the same
// description, so the response never distinguishes which metadata member failed
// and cannot be used as an oracle (THREAT_MODEL cross-cutting: no oracle).
var dcrErrorDescriptions = map[string]string{
	dcrErrorInvalidClientMetadata:  "the client metadata is missing or has an invalid value",
	dcrErrorInvalidRedirectURI:     "the redirect URI is not allowed for a public client",
	dcrErrorTemporarilyUnavailable: "the registration endpoint is temporarily unavailable",
}

// dcrClientRequest is the JSON registration request (RFC 7591 §2). Only these
// members are read, and every other JSON member of the body is ignored, exactly
// as RFC 7591 requires: a client that sends a member the facade does not
// understand still registers. redirect_uris, grant_types, and response_types are
// pointers so an absent member (a missing required list, or a list that defaults)
// is distinguishable from a present but empty one (an invalid list).
type dcrClientRequest struct {
	RedirectURIs            *[]string `json:"redirect_uris"`
	TokenEndpointAuthMethod string    `json:"token_endpoint_auth_method"`
	GrantTypes              *[]string `json:"grant_types"`
	ResponseTypes           *[]string `json:"response_types"`
	ClientName              string    `json:"client_name"`
	Scope                   string    `json:"scope"`
}

// dcrClientRegistration is the validated, normalized metadata the facade stores
// and echoes back. It carries no secret: these are public clients.
type dcrClientRegistration struct {
	RedirectURIs  []string
	GrantTypes    []string
	ResponseTypes []string
}

// facadeRegistrationPayload is the 201 response body (RFC 7591 §3.2.1). It
// deliberately carries no client_secret and no client_secret_expires_at: the
// facade registers public clients only, so there is no secret to hand out or to
// leak. It also never echoes the raw request body.
type facadeRegistrationPayload struct {
	ClientID                string   `json:"client_id"`
	ClientIDIssuedAt        int64    `json:"client_id_issued_at"`
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
}

// handleRegister serves the derived POST /register route (DESIGN §8.3): RFC 7591
// dynamic client registration of one public client, bound to the advertising
// route. It fails closed at every step, in this fixed order: the raw body bound,
// the per-route rate limit, the JSON parse, the metadata validation, and the
// store write. A request that is refused at any step gets one of the three fixed
// dcrError* codes and never a distinguishing detail.
func (config normalizedConfig) handleRegister(kind mcproutes.EndpointKind, ctx *apptheory.Context) (*apptheory.Response, error) {
	front := config.frontChannel
	if front == nil {
		return nil, errFrontChannelMissing
	}
	if len(ctx.Request.Body) > frontChannelMaxRequestBodyBytes {
		// Bound the raw body before it is parsed, so an oversized body costs the
		// facade nothing more than this comparison.
		return dcrInvalidClientMetadata(), nil
	}
	if failure := front.registerRateLimit(ctx, kind); failure != nil {
		return failure, nil
	}
	request, failure := parseDCRRequest(ctx.Request.Body)
	if failure != nil {
		return failure, nil
	}
	registration, failure := validateDCRRequest(request)
	if failure != nil {
		return failure, nil
	}
	endpoint, err := endpointFromRouteParams(ctx, kind)
	if err != nil {
		return nil, err
	}
	resource, failure, err := config.frontChannelRouteResource(ctx, endpoint)
	if err != nil || failure != nil {
		return failure, err
	}
	clientID, failure, err := config.persistRegisteredClient(ctx, registration, resource)
	if err != nil || failure != nil {
		return failure, err
	}
	return dcrClientResponse(ctx, clientID, registration)
}

// registerRateLimit spends one attempt in the per-route registration bucket
// before any other work (THREAT_MODEL T5). The store error and the over-budget
// outcome map to the same 429 response: a rate-limit store that cannot answer
// must not become an unlimited registration path, so an error fails closed
// rather than open. A nil result means the attempt is within budget.
func (front *frontChannelConfig) registerRateLimit(ctx *apptheory.Context, kind mcproutes.EndpointKind) *apptheory.Response {
	result, err := front.stores.RateLimit.CheckAndIncrement(ctx.Context(), oauthstore.RateLimitBucketKey{
		Identifier: dcrRateLimitIdentifier(ctx),
		Resource:   string(kind),
		Operation:  frontChannelDCROperation,
		Limit:      frontChannelDCRRateLimit,
		Window:     frontChannelDCRRateLimitWindow,
	})
	if err != nil || !result.Allowed {
		return dcrUnavailablePage(ctx, result.ResetAt)
	}
	return nil
}

// dcrRateLimitIdentifier keys the registration bucket by the provider-derived
// source IP when the runtime exposes one, and falls back to one shared
// per-route bucket otherwise. The source IP comes from trusted provider request
// context only (ctx.SourceIP), never from a client-controlled forwarding header.
func dcrRateLimitIdentifier(ctx *apptheory.Context) string {
	if ip := strings.TrimSpace(ctx.SourceIP()); ip != "" {
		return ip
	}
	return frontChannelDCRAnonymousIdentifier
}

// parseDCRRequest decodes the JSON body. Unknown members are ignored by
// json.Unmarshal, which is the RFC 7591 behavior the facade relies on: a member
// it does not understand must not fail the registration. Every malformed body —
// including an empty one — is one invalid_client_metadata response.
func parseDCRRequest(body []byte) (dcrClientRequest, *apptheory.Response) {
	var request dcrClientRequest
	if err := json.Unmarshal(body, &request); err != nil {
		return dcrClientRequest{}, dcrInvalidClientMetadata()
	}
	return request, nil
}

// validateDCRRequest applies the DESIGN §8.3 metadata rules to a parsed request
// and returns the normalized metadata the facade stores. Each rule reports the
// fixed code of its class, never which member failed.
func validateDCRRequest(request dcrClientRequest) (*dcrClientRegistration, *apptheory.Response) {
	redirects, failure := validatedDCRRedirectURIs(request.RedirectURIs)
	if failure != nil {
		return nil, failure
	}
	if !validDCRTokenEndpointAuthMethod(request.TokenEndpointAuthMethod) {
		return nil, dcrInvalidClientMetadata()
	}
	grants, failure := normalizedDCRGrantTypes(request.GrantTypes)
	if failure != nil {
		return nil, failure
	}
	responses, failure := normalizedDCRResponseTypes(request.ResponseTypes)
	if failure != nil {
		return nil, failure
	}
	if len(request.ClientName) > frontChannelDCRMaxClientName {
		return nil, dcrInvalidClientMetadata()
	}
	if len(request.Scope) > frontChannelDCRMaxScope {
		return nil, dcrInvalidClientMetadata()
	}
	return &dcrClientRegistration{
		RedirectURIs:  redirects,
		GrantTypes:    grants,
		ResponseTypes: responses,
	}, nil
}

// validatedDCRRedirectURIs enforces the redirect URI rule: the member is
// required, so an absent one is missing metadata (invalid_client_metadata); once
// present it must hold at least one and at most frontChannelDCRMaxRedirectURIs
// entries, and every entry must be an absolute URL with no fragment that is
// either https on any host or http on a loopback host (RFC 8252 §7.2/§7.3,
// THREAT_MODEL T5). Any violation of the list value itself is
// invalid_redirect_uri. Each accepted entry is returned trimmed and otherwise
// byte-identical, so the stored value is the one the client presented.
func validatedDCRRedirectURIs(raw *[]string) ([]string, *apptheory.Response) {
	if raw == nil {
		return nil, dcrInvalidClientMetadata()
	}
	if len(*raw) == 0 || len(*raw) > frontChannelDCRMaxRedirectURIs {
		return nil, dcrInvalidRedirectURI()
	}
	validated := make([]string, 0, len(*raw))
	for _, candidate := range *raw {
		redirectURI, ok := validDCRRedirectURI(candidate)
		if !ok {
			return nil, dcrInvalidRedirectURI()
		}
		validated = append(validated, redirectURI)
	}
	return validated, nil
}

// validDCRRedirectURI reports whether one redirect URI is an absolute https URL
// or an absolute http loopback URL, and returns its trimmed form. RFC 6749
// §3.1.2 forbids a fragment component on a redirection endpoint URI, and any "#"
// begins a fragment whether or not anything follows it, so the rule is applied
// to the raw string: net/url.Parse drops a bare trailing "#" (Fragment and
// RawFragment both stay empty for `https://host/cb#`). The parsed fragment
// checks below stay as defense in depth.
func validDCRRedirectURI(raw string) (string, bool) {
	candidate := strings.TrimSpace(raw)
	if candidate == "" {
		return "", false
	}
	if strings.Contains(candidate, "#") {
		return "", false
	}
	parsed, ok := parseAbsoluteURL(candidate)
	if !ok || parsed.Fragment != "" || parsed.RawFragment != "" {
		return "", false
	}
	switch {
	case strings.EqualFold(parsed.Scheme, httpsScheme):
		return candidate, true
	case strings.EqualFold(parsed.Scheme, httpScheme):
		return candidate, isLoopbackHost(parsed.Hostname())
	default:
		return "", false
	}
}

// validDCRTokenEndpointAuthMethod enforces the public-client-only rule: the
// member is absent, empty, or exactly "none". Any other method — a confidential
// one the facade cannot honor — is refused rather than silently downgraded.
func validDCRTokenEndpointAuthMethod(raw string) bool {
	method := strings.TrimSpace(raw)
	return method == "" || method == dcrTokenEndpointAuthMethodNone
}

// normalizedDCRGrantTypes enforces the grant type list: when the member is
// present, every value must be authorization_code or refresh_token and the list
// must include authorization_code, because the facade only serves the
// authorization_code grant today. The result is trimmed and deduplicated in
// request order. An absent member means the RFC 7591 default,
// ["authorization_code"].
func normalizedDCRGrantTypes(raw *[]string) ([]string, *apptheory.Response) {
	if raw == nil {
		return []string{dcrGrantTypeAuthorizationCode}, nil
	}
	normalized := make([]string, 0, len(*raw))
	seen := make(map[string]struct{}, len(*raw))
	includesAuthorizationCode := false
	for _, value := range *raw {
		value = strings.TrimSpace(value)
		switch value {
		case dcrGrantTypeAuthorizationCode:
			includesAuthorizationCode = true
		case dcrGrantTypeRefreshToken:
		default:
			return nil, dcrInvalidClientMetadata()
		}
		if _, duplicate := seen[value]; duplicate {
			continue
		}
		seen[value] = struct{}{}
		normalized = append(normalized, value)
	}
	if !includesAuthorizationCode {
		return nil, dcrInvalidClientMetadata()
	}
	return normalized, nil
}

// normalizedDCRResponseTypes enforces the response type list: when the member is
// present, it must be non-empty and every value must be code, so the normalized
// list is exactly ["code"]. An absent member means the same default.
func normalizedDCRResponseTypes(raw *[]string) ([]string, *apptheory.Response) {
	if raw == nil {
		return []string{dcrResponseTypeCode}, nil
	}
	if len(*raw) == 0 {
		return nil, dcrInvalidClientMetadata()
	}
	for _, value := range *raw {
		if strings.TrimSpace(value) != dcrResponseTypeCode {
			return nil, dcrInvalidClientMetadata()
		}
	}
	return []string{dcrResponseTypeCode}, nil
}

// persistRegisteredClient mints the server-assigned client id and stores the
// record, hash-keyed and bound to the advertising route, so a client registered
// at one route can never be redeemed at another. The id is 32 random bytes (256
// bits, well above the 128-bit floor of DESIGN §8.3). A store failure is the
// 429 class and never returns an id that was not persisted.
func (config normalizedConfig) persistRegisteredClient(
	ctx *apptheory.Context,
	registration *dcrClientRegistration,
	boundRoute string,
) (string, *apptheory.Response, error) {
	clientID, err := oauth.NewOpaqueToken()
	if err != nil {
		return "", nil, err
	}
	record := &oauthstore.ClientRecord{
		ClientIDHash:            oauthstore.HashKey(clientID),
		ClientID:                clientID,
		RedirectURIs:            append([]string(nil), registration.RedirectURIs...),
		TokenEndpointAuthMethod: dcrTokenEndpointAuthMethodNone,
		GrantTypes:              append([]string(nil), registration.GrantTypes...),
		ResponseTypes:           append([]string(nil), registration.ResponseTypes...),
		BoundRoute:              boundRoute,
	}
	if err = config.frontChannel.stores.Client.Put(ctx.Context(), record); err != nil {
		return "", dcrUnavailablePage(ctx, time.Time{}), nil
	}
	return clientID, nil, nil
}

// dcrClientResponse renders the 201 registration response: the server-assigned
// client id, its issue time, the validated metadata echoed back, and no secret
// of any kind. The body is bounded by the request bounds, so it cannot echo the
// request body or any error detail.
func dcrClientResponse(
	ctx *apptheory.Context,
	clientID string,
	registration *dcrClientRegistration,
) (*apptheory.Response, error) {
	body, err := json.Marshal(facadeRegistrationPayload{
		ClientID:                clientID,
		ClientIDIssuedAt:        ctx.Now().Unix(),
		RedirectURIs:            append([]string(nil), registration.RedirectURIs...),
		TokenEndpointAuthMethod: dcrTokenEndpointAuthMethodNone,
		GrantTypes:              append([]string(nil), registration.GrantTypes...),
		ResponseTypes:           append([]string(nil), registration.ResponseTypes...),
	})
	if err != nil {
		return nil, err
	}
	return dcrResponse(201, body), nil
}

// dcrInvalidClientMetadata and dcrInvalidRedirectURI name the two fixed 400
// classes of the registration endpoint.
func dcrInvalidClientMetadata() *apptheory.Response {
	return dcrErrorPage(400, dcrErrorInvalidClientMetadata)
}

func dcrInvalidRedirectURI() *apptheory.Response {
	return dcrErrorPage(400, dcrErrorInvalidRedirectURI)
}

// dcrUnavailablePage renders the registration 429 class:
// temporarily_unavailable with a Retry-After of at least one second. The delay
// is derived from resetAt when the rate-limit store reported one and from the
// framework window otherwise. A registration store failure takes this same page,
// so a caller that cannot be served is told to come back rather than being left
// to guess.
func dcrUnavailablePage(ctx *apptheory.Context, resetAt time.Time) *apptheory.Response {
	response := dcrErrorPage(429, dcrErrorTemporarilyUnavailable)
	response.Headers["retry-after"] = []string{strconv.Itoa(dcrRetryAfterSeconds(ctx, resetAt))}
	return response
}

// dcrRetryAfterSeconds converts a reset instant to the whole seconds a client
// should wait: at least one second, and the framework window when no reset
// instant is known.
func dcrRetryAfterSeconds(ctx *apptheory.Context, resetAt time.Time) int {
	delay := frontChannelDCRRateLimitWindow
	if !resetAt.IsZero() {
		delay = resetAt.Sub(ctx.Now())
	}
	seconds := int((delay + time.Second - 1) / time.Second)
	if seconds < 1 {
		return 1
	}
	return seconds
}

// dcrErrorPage renders a registration rejection: the closed registration error
// vocabulary, the fixed description of that code, and no cacheable
// representation.
func dcrErrorPage(status int, code string) *apptheory.Response {
	body, err := json.Marshal(facadeErrorPayload{Error: code, ErrorDescription: dcrErrorDescriptions[code]})
	if err != nil {
		// Unreachable for this fixed-structure payload; fail closed with a
		// fixed body rather than an unencoded one.
		body = []byte(`{"error":"invalid_client_metadata","error_description":"the client metadata is missing or has an invalid value"}`)
	}
	return dcrResponse(status, body)
}

// dcrResponse builds one registration response with the fixed non-cacheable
// header set (DESIGN §8.3): no client, proxy, or browser may retain a
// registration response body.
func dcrResponse(status int, body []byte) *apptheory.Response {
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
