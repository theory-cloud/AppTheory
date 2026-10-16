package mcpfacade

import (
	"fmt"
	"net"
	"net/url"
	"strings"
	"unicode/utf8"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

const (
	httpsScheme        = "https"
	httpScheme         = "http"
	metadataVaryHeader = "Host, X-Forwarded-Host, X-AppTheory-Original-Host, X-FaceTheory-Original-Host, Forwarded, CloudFront-Forwarded-Proto, X-Forwarded-Proto"
)

// URLMode selects the source of absolute URLs in facade metadata documents.
type URLMode string

const (
	// URLModePublicBaseURL uses FacadeConfig.PublicBaseURL fixed at registration
	// time. Use it when a front door or CDN owns the public origin.
	URLModePublicBaseURL URLMode = "public_base_url"
	// URLModeRequestHost derives the origin from each normalized request. Use it
	// for direct API Gateway custom-domain and test deployments.
	URLModeRequestHost URLMode = "request_host"
)

// TransportPosture selects how the MCP transport routes are authorized.
type TransportPosture string

const (
	// TransportPostureIAM keeps the authenticated transport posture (the default).
	TransportPostureIAM TransportPosture = "iam"
	// TransportPostureJWT assumes a gateway JWT authorizer already rejected the request.
	TransportPostureJWT TransportPosture = "jwt"
	// TransportPostureRuntimeBearer validates an RFC 9728 bearer token in the runtime.
	TransportPostureRuntimeBearer TransportPosture = "runtime-bearer"
	// TransportPostureNonePublic registers the transport routes without authentication.
	TransportPostureNonePublic TransportPosture = "none-public"
)

// HandlerFactory returns an application-owned handler for one endpoint kind.
// Factories run during facade registration, never during request handling.
type HandlerFactory func(mcproutes.EndpointKind) apptheory.Handler

// Capabilities controls the RFC 8414 capability lists advertised by the
// facade. Nil fields use DefaultCapabilities; non-nil fields replace a default.
type Capabilities struct {
	ResponseTypes            []string
	GrantTypes               []string
	TokenEndpointAuthMethods []string
	CodeChallengeMethods     []string
}

// RootDiscoveryConfig configures the optional, unscoped authorization-server
// discovery document. Unlike routed discovery, every endpoint is fixed at
// registration time and belongs to the upstream authorization server.
type RootDiscoveryConfig struct {
	IssuerURL                string
	AuthorizationEndpointURL string
	TokenEndpointURL         string
	RegistrationEndpointURL  string
	JWKSURI                  string
	Scopes                   []string
}

// DefaultCapabilities returns the golden-path OAuth capabilities: code
// responses, authorization-code and refresh-token grants, public clients, and
// S256 PKCE.
func DefaultCapabilities() Capabilities {
	return Capabilities{
		ResponseTypes:            []string{"code"},
		GrantTypes:               []string{"authorization_code", "refresh_token"},
		TokenEndpointAuthMethods: []string{"none"},
		CodeChallengeMethods:     []string{"S256"},
	}
}

// FacadeConfig configures the complete route-algebra MCP OAuth facade.
type FacadeConfig struct {
	// IssuerURL is the absolute HTTPS authorization-server issuer advertised by
	// both metadata document families when IssuerMode is family.
	IssuerURL string
	// JWKSURI is the absolute HTTPS key-set URL advertised by both metadata
	// document families. In route issuer mode it remains the upstream JWKS,
	// because the upstream signs the access tokens the route hands to clients.
	JWKSURI string
	// RegistrationEndpointURL optionally overrides the RFC 8414 registration
	// endpoint. When empty, issuer + /register is advertised (family mode).
	RegistrationEndpointURL string

	// IssuerMode selects per-route issuer/resource derivation. An empty value
	// means IssuerModeFamily: one FacadeConfig.IssuerURL for the whole facade.
	// IssuerModeRoute makes each route its own authorization server: the route
	// URL is the issuer, the resource, and the advertised authorization server.
	IssuerMode mcproutes.IssuerMode

	URLMode       URLMode
	PublicBaseURL string
	// UpstreamCallbackPath optionally overrides the stage-global upstream
	// callback path. When empty, mcproutes.DefaultCallbackPath is used.
	UpstreamCallbackPath string
	// AllowedHostnames is required in request-host mode. Configuration entries
	// normalize case, trailing dots, and default ports scheme-agnostically;
	// request authorities normalize case and trailing dots too, but strip only
	// the request scheme's own default port.
	// The normalized request authority must exact-match an entry or metadata
	// fails with HTTP 400.
	AllowedHostnames []string

	// Scopes must contain a non-empty scope set for every contract endpoint
	// kind. Scope policy remains application-owned.
	Scopes map[mcproutes.EndpointKind][]string
	// Capabilities selectively overrides DefaultCapabilities.
	Capabilities Capabilities

	// MCPHandler serves every POST, GET, and DELETE MCP endpoint pattern.
	MCPHandler apptheory.Handler
	// AuthorizeHandler and TokenHandler are an all-or-none pair. AppTheory only
	// mounts the derived paths; all authorization behavior remains app-owned.
	AuthorizeHandler HandlerFactory
	TokenHandler     HandlerFactory

	// RegisterHandler mounts the derived RFC 7591 dynamic-client registration
	// path per kind. AppTheory only mounts the derived path; registration
	// behavior remains app-owned. Absent mounts no register route.
	RegisterHandler HandlerFactory

	// CallbackHandler mounts the single stage-global upstream OAuth callback
	// path. AppTheory only mounts the route; the callback mechanics remain
	// app-owned. Absent mounts no callback route.
	CallbackHandler apptheory.Handler

	// RootAuthorizationServer optionally installs one static GET at the
	// algebra-derived root authorization-server discovery path.
	RootAuthorizationServer *RootDiscoveryConfig

	// TransportPosture selects how the MCP transport routes (POST, GET, and
	// DELETE on every MCP pattern) are authorized. An empty value means
	// TransportPostureIAM.
	//
	// TransportPostureRuntimeBearer validates an RFC 9728 bearer token in the
	// runtime and requires RequireBearerToken; registration fails closed without
	// it. TransportPostureNonePublic registers the transport routes without
	// authentication and is never a default. The posture must agree with the CDK
	// construct's synthesized posture marker.
	//
	// The posture is evaluated by the portable tier pipeline and by SecureApp.
	// TierP0 is the frozen legacy pipeline and does not evaluate route-level
	// postures, so an application that explicitly selects TierP0 must supply
	// RequireBearerToken or own transport authentication itself.
	TransportPosture TransportPosture

	// RequireBearerToken validates an RFC 9728 bearer token on every MCP
	// transport route. Credential-free or invalid requests are rejected with
	// HTTP 401 and the RFC 9728 WWW-Authenticate challenge that points at the
	// protected-resource metadata. This holds for every tier, including TierP0.
	// It is valid only with TransportPostureRuntimeBearer and is rejected under
	// every other posture.
	RequireBearerToken *oauth.RequireBearerTokenOptions

	// Provider anchors the framework-owned front channel (DESIGN §8). When it is
	// set, AppTheory owns /authorize, the stage-global upstream callback, and the
	// /token authorization_code grant, and the rest of the front-channel field
	// set below is required. A nil Provider leaves the front channel unowned: an
	// application either supplies its own AuthorizeHandler/TokenHandler pair and
	// CallbackHandler, or registers no OAuth surface at all. Setting any other
	// front-channel field without Provider is a registration error.
	Provider oauth.Provider

	// Stores supplies the five facade store SPIs the front channel persists
	// through (DESIGN §7): transaction, authorization code, client,
	// route-refresh broker, and rate limit. All five are required when Provider
	// is set. Each store owns its own TTL (DESIGN §7 TTL column), so no TTL is
	// configured here.
	//
	// The framework's in-memory reference stores are non-durable and do not
	// encrypt: they exist for deterministic tests and local development only. A
	// durable store implementation MUST encrypt the Encrypted* record fields at
	// rest (for example with persistence-layer encryption), because the facade
	// hands the store upstream material, including the upstream-minted access
	// token, exactly as the provider returned it and relies on the store to
	// protect it (DESIGN §7).
	Stores oauthstore.Stores

	// UpstreamClientID is the facade's own OAuth client registration at the
	// upstream provider (DESIGN §8.1): the upstream authorize request carries it
	// and the server-side upstream code exchange presents it. It is also the
	// expected azp/client_id of an upstream access token the facade validates
	// (DESIGN §5.2, §6), so a token minted for another client is refused.
	UpstreamClientID string

	// UpstreamIssuer is the expected upstream issuer: the RFC 9207 iss value the
	// upstream callback pins before consuming the transaction or exchanging the
	// code (DESIGN §8.2) and the issuer the provider's Discovery call must verify
	// before any published endpoint is trusted (DESIGN §5.2, §6). It must be an
	// absolute HTTPS URL with no query or fragment, normalized like IssuerURL,
	// and it is distinct from the client-facing issuer.
	UpstreamIssuer string

	// LifecycleScopes are scope values the facade adds to every upstream
	// authorize request but never requires from the MCP client, for example the
	// offline_access lifecycle scope that lets the upstream issue refresh
	// material (FRAMEWORK_VS_POLICY row 7). Nil adds none. Values are validated
	// like Scopes: trimmed, non-empty, and well-formed Unicode.
	LifecycleScopes []string

	// ProviderHints supplies the opaque provider hints for one authorize request
	// (DESIGN §6): it receives the request context and returns the hint map, for
	// example the account_id hint. A hint carries no authority — the provider
	// derives authentication account context from its own validated binding, not
	// from the hint (DESIGN §6). A nil function contributes no hints; an error is
	// a provider-call failure in the gateway class, so it maps to the 502
	// upstream_error error page and never redirects (DESIGN §8.2).
	ProviderHints func(ctx *apptheory.Context) (map[string]string, error)
}

// Route describes one endpoint-kind route family installed by the helper.
type Route struct {
	Kind                      mcproutes.EndpointKind
	MCPPattern                string
	MCPMethods                []string
	ProtectedResourcePattern  string
	DiscoveryCanonicalPattern string
	DiscoverySuffixPattern    string
	AuthorizePattern          string
	TokenPattern              string
	RegisterPattern           string
	// AuthorizationRoutesAttached reports whether transport authorization is
	// attached to this route family (false under the none-public posture). It
	// mirrors the CDK construct's authorizationRoutesAttached inventory field,
	// which is pinned by the shared facade-route-inventory fixture.
	AuthorizationRoutesAttached bool
}

// RouteInventory is a defensive snapshot of the installed facade surface.
type RouteInventory struct {
	ContractVersion                 string
	Routes                          []Route
	RootAuthorizationServerPattern  string
	RootAuthorizationServerAttached bool
	// CallbackPattern is the stage-global upstream callback path.
	CallbackPattern string
	// IssuerMode is the resolved per-route issuer derivation mode.
	IssuerMode mcproutes.IssuerMode
}

type normalizedConfig struct {
	issuerURL               string
	jwksURI                 string
	registrationEndpointURL string
	issuerMode              mcproutes.IssuerMode
	urlMode                 URLMode
	publicBaseURL           string
	upstreamCallbackPath    string
	allowedHostnames        map[string]struct{}
	scopes                  map[mcproutes.EndpointKind][]string
	capabilities            Capabilities
	mcpHandler              apptheory.Handler
	authorizeHandlers       map[mcproutes.EndpointKind]apptheory.Handler
	tokenHandlers           map[mcproutes.EndpointKind]apptheory.Handler
	registerHandlers        map[mcproutes.EndpointKind]apptheory.Handler
	callbackHandler         apptheory.Handler
	rootAuthorizationServer *oauth.AuthorizationServerMetadata
	rootDiscoveryPath       string
	transportPosture        TransportPosture
	requireBearerToken      *oauth.RequireBearerTokenOptions
	frontChannel            *frontChannelConfig
}

type routeRegistration struct {
	method  string
	pattern string
	handler apptheory.Handler
	options []apptheory.RouteOption
	// posture is the declared SecureApp authorization posture for this route,
	// used only by RegisterMCPFacadeSecure. The plain-App path ignores it and
	// keeps expressing its route security through options.
	posture apptheory.AuthPosture
}

// RegisterMCPFacade installs the complete MCP OAuth facade described by
// mcproutes.ContractVersion and returns its route inventory. The helper owns
// composition only: authorize and token routes are absent unless the
// application supplies both handler factories.
//
// The whole plan is proven installable before the app receives its first facade
// route, so a configuration the facade rejects, an invalid entry, or a
// duplicate inside the plan adds no route at all. A collision with a route the
// application already registered on this plain App is detected by the app's own
// duplicate check while the plan is mounted: the plain App surface publishes no
// route table, so the facade cannot pre-check that collision the way
// RegisterMCPFacadeSecure can on a SecureApp. See UPGRADING.md for the precise
// guarantee on each surface.
func RegisterMCPFacade(app *apptheory.App, config FacadeConfig) (*RouteInventory, error) {
	if app == nil {
		return nil, fmt.Errorf("mcpfacade: app is required")
	}
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	inventory, err := buildInventory(normalized)
	if err != nil {
		return nil, err
	}
	registrations, err := buildRegistrations(normalized, inventory)
	if err != nil {
		return nil, err
	}
	if err := registerRoutes(app, registrations); err != nil {
		return nil, err
	}

	return cloneInventory(inventory), nil
}

// RegisterMCPFacadeSecure installs the complete MCP OAuth facade on a
// closed-by-default SecureApp and returns its route inventory.
//
// It is the SecureApp counterpart to RegisterMCPFacade and produces the same
// route inventory and the same request-time behavior. The difference is how
// each route's authority is declared: on the plain App surface the facade
// expresses transport security with route options, while here every route must
// declare an explicit auth posture, so the facade declares the posture each of
// its routes has always had (see the authority table in the package docs and in
// docs/features/mcp-facade-helper.md).
//
// The SecureApp stays closed by default: this helper adds only the facade's own
// routes, each with a declared posture, and it adds none of them when the plan
// is rejected. The whole plan is proven installable before the app receives its
// first facade route — every entry, and every collision with a route the app
// already declares — so a returned error means zero facade routes were added. A
// route the application never declares remains undeliverable, and the
// application's own SecurePrincipalResolver, tier, and PolicyHook keep
// governing every non-facade route on the same app.
func RegisterMCPFacadeSecure(secure *apptheory.SecureApp, config FacadeConfig) (*RouteInventory, error) {
	if secure == nil {
		return nil, fmt.Errorf("mcpfacade: secure app is required")
	}
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	inventory, err := buildInventory(normalized)
	if err != nil {
		return nil, err
	}
	registrations, err := buildRegistrations(normalized, inventory)
	if err != nil {
		return nil, err
	}
	if err := preflightSecureRegistrations(secure, registrations); err != nil {
		return nil, err
	}
	if err := registerSecureRoutes(secure, registrations); err != nil {
		return nil, err
	}

	return cloneInventory(inventory), nil
}

func normalizeConfig(config FacadeConfig) (normalizedConfig, error) {
	if config.MCPHandler == nil {
		return normalizedConfig{}, fmt.Errorf("mcpfacade: MCP handler is required")
	}
	transportPosture, err := normalizeTransportPosture(config.TransportPosture, config.RequireBearerToken)
	if err != nil {
		return normalizedConfig{}, err
	}

	normalized, err := normalizeDerivedConfig(config)
	if err != nil {
		return normalizedConfig{}, err
	}
	normalized.transportPosture = transportPosture
	normalized.requireBearerToken = config.RequireBearerToken
	normalized.mcpHandler = config.MCPHandler
	normalized.callbackHandler = config.CallbackHandler

	frontChannel, err := normalizeFrontChannel(config)
	if err != nil {
		return normalizedConfig{}, err
	}
	normalized.frontChannel = frontChannel

	if err := validatePostureSurfaceConfig(transportPosture, normalized.authorizeHandlers, normalized.registerHandlers, config.CallbackHandler, normalized.rootAuthorizationServer, normalized.frontChannel != nil); err != nil {
		return normalizedConfig{}, err
	}
	return normalized, nil
}

// normalizeDerivedConfig resolves the URL, issuer, scope, capability, and
// handler-derived parts of a FacadeConfig.
func normalizeDerivedConfig(config FacadeConfig) (normalizedConfig, error) {
	issuerURL, ok := normalizeHTTPSURL(config.IssuerURL, true)
	if !ok {
		return normalizedConfig{}, fmt.Errorf("mcpfacade: issuer URL must be an absolute HTTPS URL without query or fragment")
	}
	jwksURI, ok := normalizeHTTPSURL(config.JWKSURI, false)
	if !ok {
		return normalizedConfig{}, fmt.Errorf("mcpfacade: JWKS URI must be an absolute HTTPS URL without fragment")
	}
	registrationEndpointURL := config.RegistrationEndpointURL
	if strings.TrimSpace(registrationEndpointURL) == "" {
		registrationEndpointURL, _ = absoluteURLForPath(issuerURL, "/register")
	} else if registrationEndpointURL, ok = normalizeHTTPSURL(registrationEndpointURL, false); !ok {
		return normalizedConfig{}, fmt.Errorf("mcpfacade: registration endpoint URL must be an absolute HTTPS URL without fragment")
	}

	publicBaseURL, allowedHostnames, err := normalizeURLMode(config)
	if err != nil {
		return normalizedConfig{}, err
	}

	issuerMode, err := normalizeIssuerMode(config.IssuerMode)
	if err != nil {
		return normalizedConfig{}, err
	}
	upstreamCallbackPath, ok := mcproutes.CallbackPathForConfiguredPath(config.UpstreamCallbackPath)
	if !ok {
		return normalizedConfig{}, fmt.Errorf("mcpfacade: upstream callback path must be an absolute path without query or fragment")
	}

	scopes, err := normalizeScopes(config.Scopes)
	if err != nil {
		return normalizedConfig{}, err
	}
	capabilities, err := normalizeCapabilities(config.Capabilities)
	if err != nil {
		return normalizedConfig{}, err
	}

	authorizeHandlers, tokenHandlers, err := buildApplicationHandlers(config.AuthorizeHandler, config.TokenHandler)
	if err != nil {
		return normalizedConfig{}, err
	}
	registerHandlers, err := buildRegisterHandlers(config.RegisterHandler)
	if err != nil {
		return normalizedConfig{}, err
	}

	rootAuthorizationServer, rootDiscoveryPath, err := normalizeRootDiscoveryConfig(config.RootAuthorizationServer)
	if err != nil {
		return normalizedConfig{}, err
	}

	return normalizedConfig{
		issuerURL:               issuerURL,
		jwksURI:                 jwksURI,
		registrationEndpointURL: registrationEndpointURL,
		issuerMode:              issuerMode,
		urlMode:                 config.URLMode,
		publicBaseURL:           publicBaseURL,
		upstreamCallbackPath:    upstreamCallbackPath,
		allowedHostnames:        allowedHostnames,
		scopes:                  scopes,
		capabilities:            capabilities,
		authorizeHandlers:       authorizeHandlers,
		tokenHandlers:           tokenHandlers,
		registerHandlers:        registerHandlers,
		rootAuthorizationServer: rootAuthorizationServer,
		rootDiscoveryPath:       rootDiscoveryPath,
	}, nil
}

func normalizeIssuerMode(mode mcproutes.IssuerMode) (mcproutes.IssuerMode, error) {
	if mode == "" {
		return mcproutes.IssuerModeFamily, nil
	}
	for _, supported := range mcproutes.SupportedIssuerModes() {
		if mode == supported {
			return mode, nil
		}
	}
	return "", fmt.Errorf("mcpfacade: IssuerMode %q must be one of family, route", mode)
}

// validatePostureSurfaceConfig makes the posture-derived inventory authoritative:
// the none-public posture attaches no OAuth surface, so configuring any of it is a
// registration error rather than a silently dropped route.
func validatePostureSurfaceConfig(
	posture TransportPosture,
	authorizeHandlers, registerHandlers map[mcproutes.EndpointKind]apptheory.Handler,
	callbackHandler apptheory.Handler,
	rootAuthorizationServer *oauth.AuthorizationServerMetadata,
	frontChannel bool,
) error {
	if posture != TransportPostureNonePublic {
		return nil
	}
	if authorizeHandlers != nil {
		return fmt.Errorf("mcpfacade: TransportPosture none-public registers no OAuth surface; authorize/token handlers must not be configured")
	}
	if registerHandlers != nil {
		return fmt.Errorf("mcpfacade: TransportPosture none-public registers no OAuth surface; RegisterHandler must not be configured")
	}
	if callbackHandler != nil {
		return fmt.Errorf("mcpfacade: TransportPosture none-public registers no OAuth surface; CallbackHandler must not be configured")
	}
	if frontChannel {
		return fmt.Errorf("mcpfacade: TransportPosture none-public registers no OAuth surface; the front-channel field set must not be configured")
	}
	if rootAuthorizationServer != nil {
		return fmt.Errorf("mcpfacade: TransportPosture none-public cannot enable RootAuthorizationServer")
	}
	return nil
}

func normalizeTransportPosture(posture TransportPosture, requireBearerToken *oauth.RequireBearerTokenOptions) (TransportPosture, error) {
	if posture == "" {
		posture = TransportPostureIAM
	}
	switch posture {
	case TransportPostureIAM, TransportPostureJWT, TransportPostureNonePublic:
		if requireBearerToken != nil {
			if posture == TransportPostureNonePublic {
				return "", fmt.Errorf("mcpfacade: TransportPosture none-public cannot be combined with RequireBearerToken")
			}
			return "", fmt.Errorf("mcpfacade: RequireBearerToken is only valid with TransportPosture runtime-bearer")
		}
	case TransportPostureRuntimeBearer:
		if requireBearerToken == nil {
			return "", fmt.Errorf("mcpfacade: TransportPosture runtime-bearer requires RequireBearerToken")
		}
	default:
		return "", fmt.Errorf("mcpfacade: TransportPosture %q must be one of iam, jwt, runtime-bearer, none-public", posture)
	}
	return posture, nil
}

func buildInventory(config normalizedConfig) (*RouteInventory, error) {
	authorizationRoutesAttached := config.transportPosture != TransportPostureNonePublic
	endpoints := mcproutes.SupportedEndpointTemplates()
	facades := indexFacadeTemplates(mcproutes.SupportedOAuthFacadeTemplates())
	discovery := indexDiscoveryTemplates(mcproutes.SupportedOAuthDiscoveryTemplates())
	if len(endpoints) != len(facades) || len(endpoints) != len(discovery) {
		return nil, fmt.Errorf("mcpfacade: incomplete %s route template inventory", mcproutes.ContractVersion)
	}

	rootPath := mcproutes.AuthorizationServerPathForResourcePath("/")
	inventory := &RouteInventory{
		ContractVersion:                 mcproutes.ContractVersion,
		Routes:                          make([]Route, 0, len(endpoints)),
		RootAuthorizationServerPattern:  rootPath,
		RootAuthorizationServerAttached: config.rootAuthorizationServer != nil && authorizationRoutesAttached,
		CallbackPattern:                 config.upstreamCallbackPath,
		IssuerMode:                      config.issuerMode,
	}
	for _, endpoint := range endpoints {
		facade, facadeOK := facades[endpoint.Kind]
		discoveryTemplate, discoveryOK := discovery[endpoint.Kind]
		if !facadeOK || !discoveryOK {
			return nil, fmt.Errorf("mcpfacade: incomplete %s routes for endpoint kind %q", mcproutes.ContractVersion, endpoint.Kind)
		}
		inventory.Routes = append(inventory.Routes, Route{
			Kind:                        endpoint.Kind,
			MCPPattern:                  endpoint.MCPPattern,
			MCPMethods:                  []string{"POST", "GET", "DELETE"},
			ProtectedResourcePattern:    endpoint.ProtectedResourcePath,
			DiscoveryCanonicalPattern:   discoveryTemplate.CanonicalPattern,
			DiscoverySuffixPattern:      discoveryTemplate.SuffixPattern,
			AuthorizePattern:            facade.AuthorizePattern,
			TokenPattern:                facade.TokenPattern,
			RegisterPattern:             facade.RegisterPattern,
			AuthorizationRoutesAttached: authorizationRoutesAttached,
		})
	}
	return inventory, nil
}

func normalizeURLMode(config FacadeConfig) (string, map[string]struct{}, error) {
	switch config.URLMode {
	case URLModePublicBaseURL:
		publicBaseURL, ok := normalizePublicBaseURL(config.PublicBaseURL)
		if !ok {
			return "", nil, fmt.Errorf("mcpfacade: public base URL mode requires an absolute HTTPS URL or loopback HTTP URL without a path, query, or fragment")
		}
		if len(config.AllowedHostnames) != 0 {
			return "", nil, fmt.Errorf("mcpfacade: public base URL mode cannot configure allowed hostnames")
		}
		return publicBaseURL, nil, nil
	case URLModeRequestHost:
		if strings.TrimSpace(config.PublicBaseURL) != "" {
			return "", nil, fmt.Errorf("mcpfacade: request-host mode cannot also configure a public base URL")
		}
		allowedHostnames, err := normalizeAllowedHostnames(config.AllowedHostnames)
		return "", allowedHostnames, err
	default:
		return "", nil, fmt.Errorf("mcpfacade: URL mode must be public_base_url or request_host")
	}
}

func buildRegistrations(config normalizedConfig, inventory *RouteInventory) ([]routeRegistration, error) {
	registrations := make([]routeRegistration, 0, len(inventory.Routes)*9+2)
	transportOptions := transportRouteOptions(config)
	transportPosture := transportPostureDeclaration(config)
	// Every other facade route is public by contract: clients must reach the
	// RFC 9728 metadata before they hold a token, /authorize and /token are the
	// unauthenticated client-facing protocol surface (PKCE and the single-use
	// code are the authority there), RFC 7591 registration admits public clients
	// only, and the upstream callback pins state and iss.
	surfacePosture := apptheory.Public()
	for _, route := range inventory.Routes {
		mcpHandler := checkedMCPHandler(route.Kind, config.mcpHandler)
		if config.requireBearerToken != nil {
			mcpHandler = oauth.RequireBearerTokenMiddleware(*config.requireBearerToken)(mcpHandler)
		}
		registrations = append(registrations,
			routeRegistration{method: "POST", pattern: route.MCPPattern, handler: mcpHandler, options: transportOptions, posture: transportPosture},
			routeRegistration{method: "GET", pattern: route.MCPPattern, handler: mcpHandler, options: transportOptions, posture: transportPosture},
			routeRegistration{method: "DELETE", pattern: route.MCPPattern, handler: mcpHandler, options: transportOptions, posture: transportPosture},
		)

		// The OAuth surface follows the posture-derived inventory, not mere
		// handler presence: under the none-public posture nothing OAuth-surface
		// registers, so the runtime surface cannot disagree with the CDK
		// construct's authorizationRoutesAttached inventory field.
		if !route.AuthorizationRoutesAttached {
			continue
		}
		registrations = append(registrations,
			routeRegistration{method: "GET", pattern: route.ProtectedResourcePattern, handler: protectedResourceHandler(config, route.Kind), posture: surfacePosture},
		)

		discoveryHandler := authorizationServerHandler(config, route.Kind)
		registrations = append(registrations,
			routeRegistration{method: "GET", pattern: route.DiscoveryCanonicalPattern, handler: discoveryHandler, posture: surfacePosture},
			routeRegistration{method: "GET", pattern: route.DiscoverySuffixPattern, handler: discoveryHandler, posture: surfacePosture},
		)

		if config.authorizeHandlers != nil {
			registrations = append(registrations,
				routeRegistration{method: "GET", pattern: route.AuthorizePattern, handler: checkedOAuthFacadeHandler(route.Kind, true, config.authorizeHandlers[route.Kind]), posture: surfacePosture},
				routeRegistration{method: "POST", pattern: route.TokenPattern, handler: checkedOAuthFacadeHandler(route.Kind, false, config.tokenHandlers[route.Kind]), posture: surfacePosture},
			)
		}
		if config.frontChannel != nil {
			registrations = append(registrations,
				routeRegistration{method: "GET", pattern: route.AuthorizePattern, handler: checkedOAuthFacadeHandler(route.Kind, true, config.authorizeHandlerFor(route.Kind)), posture: surfacePosture},
				routeRegistration{method: "POST", pattern: route.TokenPattern, handler: checkedOAuthFacadeHandler(route.Kind, false, config.tokenHandlerFor(route.Kind)), posture: surfacePosture},
				// The RFC 7591 registration route is part of the front channel,
				// so it follows the same posture-derived mount: it is never
				// reached under the none-public posture, where nothing of the
				// OAuth surface registers.
				routeRegistration{method: "POST", pattern: route.RegisterPattern, handler: checkedRegisterHandler(route.Kind, config.registerHandlerFor(route.Kind)), posture: surfacePosture},
			)
		}
		if config.registerHandlers != nil {
			registrations = append(registrations,
				routeRegistration{method: "POST", pattern: route.RegisterPattern, handler: checkedRegisterHandler(route.Kind, config.registerHandlers[route.Kind]), posture: surfacePosture},
			)
		}
	}
	if inventory.RootAuthorizationServerAttached {
		if config.rootAuthorizationServer == nil || config.rootDiscoveryPath != inventory.RootAuthorizationServerPattern {
			return nil, fmt.Errorf("mcpfacade: root authorization-server inventory is inconsistent")
		}
		registrations = append(registrations, routeRegistration{
			method:  "GET",
			pattern: inventory.RootAuthorizationServerPattern,
			handler: withMetadataHeaders(oauth.AuthorizationServerMetadataHandler(config.rootAuthorizationServer)),
			posture: surfacePosture,
		})
	}
	if inventory.CallbackPattern != "" && config.callbackHandler != nil {
		registrations = append(registrations, routeRegistration{
			method:  "GET",
			pattern: inventory.CallbackPattern,
			handler: config.callbackHandler,
			posture: surfacePosture,
		})
	}
	if inventory.CallbackPattern != "" && config.frontChannel != nil {
		registrations = append(registrations, routeRegistration{
			method:  "GET",
			pattern: inventory.CallbackPattern,
			handler: config.callbackHandlerFor(),
			posture: surfacePosture,
		})
	}
	if err := validateRouteRegistrations(registrations); err != nil {
		return nil, err
	}
	return registrations, nil
}

func validateRouteRegistrations(registrations []routeRegistration) error {
	probe := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	return validateRegistrationEntries(registrations, func(registration routeRegistration) error {
		return handleRoute(probe, registration.method, registration.pattern, registration.handler, registration.options...)
	})
}

// preflightSecureRegistrations proves the whole plan before the caller's
// SecureApp receives any route, so a plan the registrar rejects is
// all-or-nothing: a returned error means no facade route was added.
//
// It is the SecureApp counterpart to validateRouteRegistrations and runs the
// same two checks, both before the first mount:
//
//  1. the plan is installed on a throwaway tier-P0 SecureApp, so an invalid
//     entry, a duplicate inside the plan, or a pattern or posture the surface
//     refuses fails with the caller's app untouched; and
//  2. every planned route is compared with the routes the caller's SecureApp
//     already declares ON ANY SURFACE THAT SHARES THE ROUTER, so a collision
//     with an application route is reported before the first mount too.
//
// The SecureApp surface publishes its declared routes (Routes()), so both
// failure classes can be pre-checked. The plain App surface publishes no route
// table, so RegisterMCPFacade can pre-check the plan only; see the precise
// guarantee in UPGRADING.md and docs/features/mcp-facade-helper.md.
func preflightSecureRegistrations(secure *apptheory.SecureApp, registrations []routeRegistration) error {
	probe := apptheory.NewSecure(apptheory.SecureOptions{Tier: apptheory.TierP0})
	if err := validateRegistrationEntries(registrations, func(registration routeRegistration) error {
		return handleSecureRoute(probe, registration.method, registration.pattern, registration.handler, registration.posture)
	}); err != nil {
		return err
	}

	declared := make(map[string]struct{})
	for _, route := range secure.Routes() {
		if key, onSharedRouter := sharedRouterRouteKey(route); onSharedRouter {
			declared[key] = struct{}{}
		}
	}
	for _, planned := range probe.Routes() {
		key, onSharedRouter := sharedRouterRouteKey(planned)
		if !onSharedRouter {
			continue
		}
		if _, occupied := declared[key]; occupied {
			return fmt.Errorf("mcpfacade: route %s is already registered on the secure app", key)
		}
	}
	return nil
}

// sharedRouterRouteKey returns the exact key the shared router's duplicate check
// compares for one declared route, and whether that route is on the shared
// router at all.
//
// That check is surface-agnostic: it compares the canonical method and path of
// every route the router owns, whichever surface declared it, and
// SecureApp.AppSyncField mounts on that same router (GET /<field> for Query and
// Subscription, POST /<field> for Mutation). SecureApp.Routes() reports the same
// canonical method and path for both surfaces, so the HTTP and AppSync surfaces
// key identically here and an AppSync field that occupies a planned route's key
// is caught before the first mount.
//
// The WebSocket surface is the one exception. Its route keys live in their own
// table with their own duplicate check, keyed by route key; it declares neither
// a method nor a path, and it never reaches the router, so it cannot occupy a
// router key. Excluding it is what stops this comparison from inventing a
// collision out of that empty method and path.
func sharedRouterRouteKey(route apptheory.SecureRoute) (string, bool) {
	if route.Surface == apptheory.SecureRouteWebSocket {
		return "", false
	}
	return route.Method + " " + route.Path, true
}

// validateRegistrationEntries applies the surface-independent inventory checks:
// every entry must name a method, pattern, and handler, must not duplicate
// another entry, and must be acceptable to install.
func validateRegistrationEntries(registrations []routeRegistration, install func(routeRegistration) error) error {
	seen := make(map[string]struct{}, len(registrations))
	for _, registration := range registrations {
		method := strings.ToUpper(strings.TrimSpace(registration.method))
		key := method + " " + registration.pattern
		if method == "" || registration.pattern == "" || registration.handler == nil {
			return fmt.Errorf("mcpfacade: invalid route inventory entry %q", key)
		}
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("mcpfacade: duplicate route inventory entry %s", key)
		}
		seen[key] = struct{}{}
		if err := install(registration); err != nil {
			return fmt.Errorf("mcpfacade: invalid or duplicate route inventory entry %s: %w", key, err)
		}
	}
	return nil
}

func registerRoutes(app *apptheory.App, registrations []routeRegistration) error {
	for _, registration := range registrations {
		if err := handleRoute(app, registration.method, registration.pattern, registration.handler, registration.options...); err != nil {
			return fmt.Errorf("mcpfacade: register %s %s: %w", registration.method, registration.pattern, err)
		}
	}
	return nil
}

func registerSecureRoutes(secure *apptheory.SecureApp, registrations []routeRegistration) error {
	for _, registration := range registrations {
		if err := handleSecureRoute(secure, registration.method, registration.pattern, registration.handler, registration.posture); err != nil {
			return fmt.Errorf("mcpfacade: register %s %s: %w", registration.method, registration.pattern, err)
		}
	}
	return nil
}

func handleRoute(app *apptheory.App, method, pattern string, handler apptheory.Handler, options ...apptheory.RouteOption) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			switch value := recovered.(type) {
			case error:
				err = value
			default:
				err = fmt.Errorf("route registration panic: %v", value)
			}
		}
	}()
	app.Handle(method, pattern, handler, options...)
	return nil
}

// handleSecureRoute declares one posture-bearing route on a SecureApp and turns
// a registration panic into an error. SecureApp.Handle panics on a duplicate or
// invalid route exactly as App.Handle does, so the SecureApp registrar recovers
// the same way handleRoute does and preserves the (*RouteInventory, error)
// contract of the two Register* entry points.
func handleSecureRoute(secure *apptheory.SecureApp, method, pattern string, handler apptheory.Handler, posture apptheory.AuthPosture) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			switch value := recovered.(type) {
			case error:
				err = value
			default:
				err = fmt.Errorf("route registration panic: %v", value)
			}
		}
	}()
	secure.Handle(method, pattern, handler, posture)
	return nil
}

// transportRouteOptions returns the route-level posture for the three MCP
// transport routes (POST, GET, and DELETE on every MCP pattern).
//
// IAM and JWT carry the existing RequireAuth route option; the gateway rejects
// the request before the runtime under those postures. RuntimeBearer and
// NonePublic register no route option: RuntimeBearer enforces the RFC 9728
// bearer middleware (which fails closed), and NonePublic is deliberately public.
func transportRouteOptions(config normalizedConfig) []apptheory.RouteOption {
	if config.transportPosture == TransportPostureIAM || config.transportPosture == TransportPostureJWT {
		return []apptheory.RouteOption{apptheory.RequireAuth()}
	}
	return nil
}

// transportPostureDeclaration returns the SecureApp auth posture the facade
// declares for the three MCP transport routes. It is the SecureApp counterpart
// of transportRouteOptions: the same three postures, expressed in the
// closed-by-default vocabulary SecureApp requires at registration.
//
// IAM and JWT are gateway-fronted postures whose plain-App expression is the
// RequireAuth route option, which requires a resolved principal. The SecureApp
// counterpart of that requirement is Authenticated(), so the application's own
// SecurePrincipalResolver remains the authority for the transport route.
//
// RuntimeBearer registers no route option on the plain surface because the RFC
// 9728 bearer middleware enforces the request and fails closed, so the declared
// posture here is Public and the facade's bearer validator is the authority.
// NonePublic is deliberately public by contract.
func transportPostureDeclaration(config normalizedConfig) apptheory.AuthPosture {
	if config.transportPosture == TransportPostureIAM || config.transportPosture == TransportPostureJWT {
		return apptheory.Authenticated()
	}
	return apptheory.Public()
}

func indexFacadeTemplates(templates []mcproutes.OAuthFacadeTemplate) map[mcproutes.EndpointKind]mcproutes.OAuthFacadeTemplate {
	indexed := make(map[mcproutes.EndpointKind]mcproutes.OAuthFacadeTemplate, len(templates))
	for _, template := range templates {
		indexed[template.Kind] = template
	}
	return indexed
}

func indexDiscoveryTemplates(templates []mcproutes.OAuthDiscoveryTemplate) map[mcproutes.EndpointKind]mcproutes.OAuthDiscoveryTemplate {
	indexed := make(map[mcproutes.EndpointKind]mcproutes.OAuthDiscoveryTemplate, len(templates))
	for _, template := range templates {
		indexed[template.Kind] = template
	}
	return indexed
}

func buildApplicationHandlers(authorizeFactory, tokenFactory HandlerFactory) (map[mcproutes.EndpointKind]apptheory.Handler, map[mcproutes.EndpointKind]apptheory.Handler, error) {
	if (authorizeFactory == nil) != (tokenFactory == nil) {
		return nil, nil, fmt.Errorf("mcpfacade: authorize and token handler factories must be configured together")
	}
	if authorizeFactory == nil {
		return nil, nil, nil
	}

	authorizeHandlers := make(map[mcproutes.EndpointKind]apptheory.Handler)
	tokenHandlers := make(map[mcproutes.EndpointKind]apptheory.Handler)
	for _, template := range mcproutes.SupportedEndpointTemplates() {
		authorizeHandlers[template.Kind] = authorizeFactory(template.Kind)
		tokenHandlers[template.Kind] = tokenFactory(template.Kind)
		if authorizeHandlers[template.Kind] == nil || tokenHandlers[template.Kind] == nil {
			return nil, nil, fmt.Errorf("mcpfacade: application handler factory returned nil for endpoint kind %q", template.Kind)
		}
	}
	return authorizeHandlers, tokenHandlers, nil
}

func buildRegisterHandlers(factory HandlerFactory) (map[mcproutes.EndpointKind]apptheory.Handler, error) {
	if factory == nil {
		return nil, nil
	}
	handlers := make(map[mcproutes.EndpointKind]apptheory.Handler)
	for _, template := range mcproutes.SupportedEndpointTemplates() {
		handlers[template.Kind] = factory(template.Kind)
		if handlers[template.Kind] == nil {
			return nil, fmt.Errorf("mcpfacade: register handler factory returned nil for endpoint kind %q", template.Kind)
		}
	}
	return handlers, nil
}

func normalizeAllowedHostnames(configured []string) (map[string]struct{}, error) {
	if len(configured) == 0 {
		return nil, fmt.Errorf("mcpfacade: request-host mode requires at least one allowed hostname")
	}
	normalized := make(map[string]struct{}, len(configured))
	for _, raw := range configured {
		hostname, ok := normalizeAllowedHostname(raw)
		if !ok {
			return nil, fmt.Errorf("mcpfacade: allowed hostname %q must be a hostname or hostname:port", raw)
		}
		normalized[hostname] = struct{}{}
	}
	return normalized, nil
}

func normalizeRootDiscoveryConfig(config *RootDiscoveryConfig) (*oauth.AuthorizationServerMetadata, string, error) {
	if config == nil {
		return nil, "", nil
	}
	issuer, ok := normalizeHTTPSURL(config.IssuerURL, true)
	if !ok {
		return nil, "", fmt.Errorf("mcpfacade: root discovery issuer URL must be an absolute HTTPS URL without query or fragment")
	}
	authorize, ok := normalizeHTTPSURL(config.AuthorizationEndpointURL, false)
	if !ok {
		return nil, "", fmt.Errorf("mcpfacade: root discovery authorization endpoint URL must be an absolute HTTPS URL without fragment")
	}
	token, ok := normalizeHTTPSURL(config.TokenEndpointURL, false)
	if !ok {
		return nil, "", fmt.Errorf("mcpfacade: root discovery token endpoint URL must be an absolute HTTPS URL without fragment")
	}
	registration, ok := normalizeHTTPSURL(config.RegistrationEndpointURL, false)
	if !ok {
		return nil, "", fmt.Errorf("mcpfacade: root discovery registration endpoint URL must be an absolute HTTPS URL without fragment")
	}
	jwks, ok := normalizeHTTPSURL(config.JWKSURI, false)
	if !ok {
		return nil, "", fmt.Errorf("mcpfacade: root discovery JWKS URI must be an absolute HTTPS URL without fragment")
	}
	scopes, err := normalizeNonEmptyList("root discovery scope", config.Scopes)
	if err != nil {
		return nil, "", fmt.Errorf("mcpfacade: %w", err)
	}
	capabilities := DefaultCapabilities()
	return &oauth.AuthorizationServerMetadata{
		Issuer:                            issuer,
		AuthorizationEndpoint:             authorize,
		TokenEndpoint:                     token,
		RegistrationEndpoint:              registration,
		JWKSURI:                           jwks,
		ResponseTypesSupported:            capabilities.ResponseTypes,
		GrantTypesSupported:               capabilities.GrantTypes,
		TokenEndpointAuthMethodsSupported: capabilities.TokenEndpointAuthMethods,
		CodeChallengeMethodsSupported:     capabilities.CodeChallengeMethods,
		ScopesSupported:                   scopes,
	}, mcproutes.AuthorizationServerPathForResourcePath("/"), nil
}

func normalizeScopes(configured map[mcproutes.EndpointKind][]string) (map[mcproutes.EndpointKind][]string, error) {
	supported := make(map[mcproutes.EndpointKind]struct{})
	for _, template := range mcproutes.SupportedEndpointTemplates() {
		supported[template.Kind] = struct{}{}
	}
	for kind := range configured {
		if _, ok := supported[kind]; !ok {
			return nil, fmt.Errorf("mcpfacade: scopes configured for unsupported endpoint kind %q", kind)
		}
	}

	normalized := make(map[mcproutes.EndpointKind][]string, len(supported))
	for _, template := range mcproutes.SupportedEndpointTemplates() {
		scopes, present := configured[template.Kind]
		if !present {
			return nil, fmt.Errorf("mcpfacade: scopes are required for endpoint kind %q", template.Kind)
		}
		list, err := normalizeNonEmptyList("scope", scopes)
		if err != nil {
			return nil, fmt.Errorf("mcpfacade: endpoint kind %q: %w", template.Kind, err)
		}
		normalized[template.Kind] = list
	}
	return normalized, nil
}

func normalizeCapabilities(configured Capabilities) (Capabilities, error) {
	defaults := DefaultCapabilities()
	values := []struct {
		name       string
		configured []string
		fallback   []string
		target     *[]string
	}{
		{name: "response type", configured: configured.ResponseTypes, fallback: defaults.ResponseTypes, target: &defaults.ResponseTypes},
		{name: "grant type", configured: configured.GrantTypes, fallback: defaults.GrantTypes, target: &defaults.GrantTypes},
		{name: "token endpoint auth method", configured: configured.TokenEndpointAuthMethods, fallback: defaults.TokenEndpointAuthMethods, target: &defaults.TokenEndpointAuthMethods},
		{name: "code challenge method", configured: configured.CodeChallengeMethods, fallback: defaults.CodeChallengeMethods, target: &defaults.CodeChallengeMethods},
	}
	for _, value := range values {
		list := value.configured
		if list == nil {
			list = value.fallback
		}
		normalized, err := normalizeNonEmptyList(value.name, list)
		if err != nil {
			return Capabilities{}, fmt.Errorf("mcpfacade: %w", err)
		}
		*value.target = normalized
	}
	return defaults, nil
}

func normalizeNonEmptyList(label string, values []string) ([]string, error) {
	seen := make(map[string]struct{}, len(values))
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			return nil, fmt.Errorf("%s values cannot be empty", label)
		}
		if !utf8.ValidString(value) {
			return nil, fmt.Errorf("%s values must be well-formed Unicode", label)
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		normalized = append(normalized, value)
	}
	if len(normalized) == 0 {
		return nil, fmt.Errorf("at least one %s is required", label)
	}
	return normalized, nil
}

func checkedMCPHandler(kind mcproutes.EndpointKind, next apptheory.Handler) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		endpoint, err := endpointFromMCPRequest(ctx)
		if err != nil || endpoint.Kind != kind {
			return nil, fmt.Errorf("mcpfacade: request path does not identify endpoint kind %q", kind)
		}
		return next(ctx)
	}
}

func checkedOAuthFacadeHandler(kind mcproutes.EndpointKind, authorize bool, next apptheory.Handler) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		endpoint, err := endpointFromRouteParams(ctx, kind)
		if err != nil {
			return nil, fmt.Errorf("mcpfacade: facade path does not identify endpoint kind %q", kind)
		}
		expectedPath, err := endpoint.OAuthTokenPath()
		if authorize {
			expectedPath, err = endpoint.OAuthAuthorizePath()
		}
		if err != nil {
			return nil, err
		}
		if ctx.Request.Path != expectedPath {
			return nil, fmt.Errorf("mcpfacade: request path is not an OAuth facade path for endpoint kind %q", kind)
		}
		return next(ctx)
	}
}

func checkedRegisterHandler(kind mcproutes.EndpointKind, next apptheory.Handler) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		endpoint, err := endpointFromRouteParams(ctx, kind)
		if err != nil {
			return nil, fmt.Errorf("mcpfacade: registration path does not identify endpoint kind %q", kind)
		}
		expectedPath, err := endpoint.OAuthRegisterPath()
		if err != nil {
			return nil, err
		}
		if ctx.Request.Path != expectedPath {
			return nil, fmt.Errorf("mcpfacade: request path is not a registration path for endpoint kind %q", kind)
		}
		return next(ctx)
	}
}

func protectedResourceHandler(config normalizedConfig, kind mcproutes.EndpointKind) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		endpoint, err := endpointFromProtectedResourceRequest(ctx)
		if err != nil || endpoint.Kind != kind {
			return nil, fmt.Errorf("mcpfacade: protected-resource path does not identify endpoint kind %q", kind)
		}
		mcpPath, err := endpoint.MCPPath()
		if err != nil {
			return nil, err
		}
		resourceURL, err := config.absoluteURL(ctx, mcpPath)
		if err != nil {
			if response, ok := metadataRequestFailure(err); ok {
				return response, nil
			}
			return nil, err
		}
		authorizationServers := []string{config.issuerURL}
		if config.issuerMode == mcproutes.IssuerModeRoute {
			// Route issuer mode: the route is its own authorization server, so it
			// advertises exactly its own resource URL.
			authorizationServers = []string{resourceURL}
		}
		metadata := &oauth.ProtectedResourceMetadata{
			Resource:             resourceURL,
			AuthorizationServers: authorizationServers,
			JWKSURI:              config.jwksURI,
			ScopesSupported:      append([]string(nil), config.scopes[kind]...),
		}
		return withMetadataHeaders(oauth.ProtectedResourceMetadataHandler(metadata))(ctx)
	}
}

func authorizationServerHandler(config normalizedConfig, kind mcproutes.EndpointKind) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		endpoint, err := endpointFromDiscoveryRequest(ctx, kind)
		if err != nil {
			return nil, err
		}
		authorizeURL, response, err := config.derivedMetadataRouteURL(ctx, endpoint, mcproutes.EndpointPath.OAuthAuthorizePath)
		if response != nil || err != nil {
			return response, err
		}
		tokenURL, response, err := config.derivedMetadataRouteURL(ctx, endpoint, mcproutes.EndpointPath.OAuthTokenPath)
		if response != nil || err != nil {
			return response, err
		}
		issuer, registrationEndpoint, response, err := config.routedIssuerAndRegistration(ctx, endpoint)
		if response != nil || err != nil {
			return response, err
		}
		metadata := &oauth.AuthorizationServerMetadata{
			Issuer:                            issuer,
			AuthorizationEndpoint:             authorizeURL,
			TokenEndpoint:                     tokenURL,
			RegistrationEndpoint:              registrationEndpoint,
			JWKSURI:                           config.jwksURI,
			ResponseTypesSupported:            append([]string(nil), config.capabilities.ResponseTypes...),
			GrantTypesSupported:               append([]string(nil), config.capabilities.GrantTypes...),
			TokenEndpointAuthMethodsSupported: append([]string(nil), config.capabilities.TokenEndpointAuthMethods...),
			CodeChallengeMethodsSupported:     append([]string(nil), config.capabilities.CodeChallengeMethods...),
			ScopesSupported:                   append([]string(nil), config.scopes[kind]...),
			// The front channel always sends RFC 9207 `iss` on the client
			// callback, on success and on error redirects alike, so the routed
			// document advertises it. The root discovery document describes the
			// upstream authorization server, whose responses this facade does not
			// own, and the generic builder serves no front channel: neither sets
			// the member.
			AuthorizationResponseIssParameterSupported: true,
		}
		return withMetadataHeaders(oauth.AuthorizationServerMetadataHandler(metadata))(ctx)
	}
}

// derivedMetadataRouteURL builds the absolute URL for one derived route path. A
// metadata request-origin failure is rendered as its own response so callers can
// return it verbatim.
func (config normalizedConfig) derivedMetadataRouteURL(
	ctx *apptheory.Context,
	endpoint mcproutes.EndpointPath,
	build func(mcproutes.EndpointPath) (string, error),
) (string, *apptheory.Response, error) {
	routePath, err := build(endpoint)
	if err != nil {
		return "", nil, err
	}
	absolute, err := config.absoluteURL(ctx, routePath)
	if err != nil {
		if response, ok := metadataRequestFailure(err); ok {
			return "", response, nil
		}
		return "", nil, err
	}
	return absolute, nil, nil
}

// registrationRouteMounted reports whether buildRegistrations mounts the
// RFC 7591 /register route: the front channel owns it, and an explicit register
// handler mounts it on its own.
func (config normalizedConfig) registrationRouteMounted() bool {
	return config.frontChannel != nil || config.registerHandlers != nil
}

// routedIssuerAndRegistration returns the issuer and registration endpoint the
// routed RFC 8414 document advertises. In route issuer mode the route URL is the
// issuer and the registration endpoint is the route's own derived /register path,
// so the advertised URL and the mounted route cannot drift. The registration
// member is advertised exactly when the /register route is mounted, so a facade
// that mounts no register route omits it instead of advertising a URL that 404s;
// an empty return value is omitted from the document.
func (config normalizedConfig) routedIssuerAndRegistration(
	ctx *apptheory.Context,
	endpoint mcproutes.EndpointPath,
) (string, string, *apptheory.Response, error) {
	if config.issuerMode != mcproutes.IssuerModeRoute {
		registration := ""
		if config.registrationRouteMounted() {
			registration = config.registrationEndpointURL
		}
		return config.issuerURL, registration, nil, nil
	}
	issuer, response, err := config.derivedMetadataRouteURL(ctx, endpoint, mcproutes.EndpointPath.MCPPath)
	if response != nil || err != nil {
		return "", "", response, err
	}
	if !config.registrationRouteMounted() {
		return issuer, "", nil, nil
	}
	registration, response, err := config.derivedMetadataRouteURL(ctx, endpoint, mcproutes.EndpointPath.OAuthRegisterPath)
	if response != nil || err != nil {
		return "", "", response, err
	}
	return issuer, registration, nil, nil
}

func endpointFromMCPRequest(ctx *apptheory.Context) (mcproutes.EndpointPath, error) {
	if ctx == nil {
		return mcproutes.EndpointPath{}, fmt.Errorf("mcpfacade: request context is required")
	}
	return mcproutes.ParseMCPPath(ctx.Request.Path)
}

func endpointFromProtectedResourceRequest(ctx *apptheory.Context) (mcproutes.EndpointPath, error) {
	if ctx == nil {
		return mcproutes.EndpointPath{}, fmt.Errorf("mcpfacade: request context is required")
	}
	resourcePath, err := mcproutes.ResourcePathFromProtectedResourcePath(ctx.Request.Path)
	if err != nil {
		return mcproutes.EndpointPath{}, err
	}
	return mcproutes.ParseMCPPath(resourcePath)
}

func endpointFromDiscoveryRequest(ctx *apptheory.Context, kind mcproutes.EndpointKind) (mcproutes.EndpointPath, error) {
	endpoint, err := endpointFromRouteParams(ctx, kind)
	if err != nil {
		return mcproutes.EndpointPath{}, err
	}
	canonicalPath, err := endpoint.OAuthAuthorizationServerPath()
	if err != nil {
		return mcproutes.EndpointPath{}, err
	}
	suffixPath, err := endpoint.OAuthAuthorizationServerSuffixPath()
	if err != nil {
		return mcproutes.EndpointPath{}, err
	}
	if ctx.Request.Path != canonicalPath && ctx.Request.Path != suffixPath {
		return mcproutes.EndpointPath{}, fmt.Errorf("mcpfacade: request path is not a discovery path for endpoint kind %q", kind)
	}
	return endpoint, nil
}

func endpointFromRouteParams(ctx *apptheory.Context, kind mcproutes.EndpointKind) (mcproutes.EndpointPath, error) {
	if ctx == nil {
		return mcproutes.EndpointPath{}, fmt.Errorf("mcpfacade: request context is required")
	}
	candidate := mcproutes.EndpointPath{
		Kind:            kind,
		ClientNamespace: ctx.Param(mcproutes.ParamClientNamespace),
		PartnerID:       ctx.Param(mcproutes.ParamPartnerID),
		AgentID:         ctx.Param(mcproutes.ParamAgentID),
	}
	mcpPath, err := candidate.MCPPath()
	if err != nil {
		return mcproutes.EndpointPath{}, err
	}
	endpoint, err := mcproutes.ParseMCPPath(mcpPath)
	if err != nil {
		return mcproutes.EndpointPath{}, err
	}
	return endpoint, nil
}

func (config normalizedConfig) absoluteURL(ctx *apptheory.Context, routePath string) (string, error) {
	baseURL := config.publicBaseURL
	if config.urlMode == URLModeRequestHost {
		if ctx == nil {
			return "", &metadataRequestError{message: "request context is required for request-host URL mode"}
		}
		var ok bool
		baseURL, ok = oauth.NormalizeRequestOrigin(apptheory.OriginURL(ctx.Request.Headers))
		if !ok {
			return "", &metadataRequestError{message: "request host is missing or unsafe"}
		}
		origin, ok := parseAbsoluteURL(baseURL)
		if !ok {
			return "", fmt.Errorf("mcpfacade: normalized request origin is invalid")
		}
		if _, allowed := config.allowedHostnames[origin.Host]; !allowed {
			return "", &metadataRequestError{message: "request host is not allowlisted"}
		}
	}
	absolute, ok := absoluteURLForPath(baseURL, routePath)
	if !ok {
		return "", fmt.Errorf("mcpfacade: cannot build absolute URL for route path %q", routePath)
	}
	return absolute, nil
}

type metadataRequestError struct {
	message string
}

func (err *metadataRequestError) Error() string {
	return "mcpfacade: " + err.message
}

func metadataRequestFailure(err error) (*apptheory.Response, bool) {
	if _, ok := err.(*metadataRequestError); !ok {
		return nil, false
	}
	return &apptheory.Response{
		Status: 400,
		Headers: map[string][]string{
			"cache-control": {"no-store"},
			"content-type":  {"application/json; charset=utf-8"},
			"vary":          {metadataVaryHeader},
		},
		Body: []byte(`{"error":"invalid_request_host"}`),
	}, true
}

func withMetadataHeaders(next apptheory.Handler) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		response, err := next(ctx)
		if err != nil || response == nil {
			return response, err
		}
		if response.Headers == nil {
			response.Headers = make(map[string][]string)
		}
		response.Headers["cache-control"] = []string{"no-store"}
		response.Headers["vary"] = []string{metadataVaryHeader}
		return response, nil
	}
}

func normalizeHTTPSURL(raw string, issuer bool) (string, bool) {
	u, ok := parseAbsoluteURL(raw)
	if !ok || strings.ToLower(u.Scheme) != httpsScheme || u.RawFragment != "" || u.Fragment != "" {
		return "", false
	}
	if issuer && (u.RawQuery != "" || u.ForceQuery) {
		return "", false
	}
	u.Scheme = httpsScheme
	u.Host = canonicalAuthority(u)
	if u.Host == "" {
		return "", false
	}
	u.RawPath = ""
	if issuer {
		u.Path = strings.TrimRight(u.Path, "/")
	}
	return u.String(), true
}

func normalizePublicBaseURL(raw string) (string, bool) {
	return oauth.NormalizeRequestOrigin(raw)
}

func normalizeAllowedHostname(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.Contains(raw, "/") || strings.ContainsAny(raw, "?#@") {
		return "", false
	}
	u, err := url.Parse("//" + raw)
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	u.Scheme = httpsScheme
	port := u.Port()
	if port == "80" || port == "443" {
		u.Host = canonicalHostname(u.Hostname())
	} else {
		u.Host = canonicalAuthority(u)
	}
	return u.Host, u.Host != ""
}

func parseAbsoluteURL(raw string) (*url.URL, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.Hostname() == "" {
		return nil, false
	}
	return u, true
}

func canonicalAuthority(u *url.URL) string {
	if u == nil {
		return ""
	}
	hostname := canonicalHostname(u.Hostname())
	if hostname == "" {
		return ""
	}
	port := u.Port()
	if (strings.EqualFold(u.Scheme, httpsScheme) && port == "443") || (strings.EqualFold(u.Scheme, httpScheme) && port == "80") {
		port = ""
	}
	if port != "" {
		return net.JoinHostPort(strings.Trim(hostname, "[]"), port)
	}
	return hostname
}

func canonicalHostname(hostname string) string {
	hostname = strings.ToLower(strings.TrimSuffix(hostname, "."))
	if strings.Contains(hostname, ":") {
		return "[" + hostname + "]"
	}
	return hostname
}

func absoluteURLForPath(baseURL, routePath string) (string, bool) {
	u, ok := parseAbsoluteURL(baseURL)
	if !ok || !strings.HasPrefix(routePath, "/") {
		return "", false
	}
	u.Path = strings.TrimRight(u.Path, "/") + routePath
	u.RawPath = ""
	u.RawQuery = ""
	u.ForceQuery = false
	u.Fragment = ""
	u.RawFragment = ""
	return u.String(), true
}

func cloneInventory(inventory *RouteInventory) *RouteInventory {
	clone := &RouteInventory{
		ContractVersion:                 inventory.ContractVersion,
		Routes:                          make([]Route, len(inventory.Routes)),
		RootAuthorizationServerPattern:  inventory.RootAuthorizationServerPattern,
		RootAuthorizationServerAttached: inventory.RootAuthorizationServerAttached,
		CallbackPattern:                 inventory.CallbackPattern,
		IssuerMode:                      inventory.IssuerMode,
	}
	copy(clone.Routes, inventory.Routes)
	for index := range clone.Routes {
		clone.Routes[index].MCPMethods = append([]string(nil), inventory.Routes[index].MCPMethods...)
	}
	return clone
}
