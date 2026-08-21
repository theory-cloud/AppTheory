package mcpfacade

import (
	"fmt"
	"net"
	"net/url"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/v3/runtime"
	"github.com/theory-cloud/apptheory/v3/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v3/runtime/oauth"
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
	// both metadata document families.
	IssuerURL string
	// JWKSURI is the absolute HTTPS key-set URL advertised by both metadata
	// document families.
	JWKSURI string
	// RegistrationEndpointURL optionally overrides the RFC 8414 registration
	// endpoint. When empty, issuer + /register is advertised.
	RegistrationEndpointURL string

	URLMode       URLMode
	PublicBaseURL string
	// AllowedHostnames is required in request-host mode. The request-derived
	// authority must exact-match one entry after case and default-port
	// normalization or metadata fails with HTTP 400.
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

	// RootAuthorizationServer optionally installs one static GET at the
	// algebra-derived root authorization-server discovery path.
	RootAuthorizationServer *RootDiscoveryConfig
}

// Route describes one endpoint-kind route family installed by the helper.
type Route struct {
	Kind                        mcproutes.EndpointKind
	MCPPattern                  string
	MCPMethods                  []string
	ProtectedResourcePattern    string
	DiscoveryCanonicalPattern   string
	DiscoverySuffixPattern      string
	AuthorizePattern            string
	TokenPattern                string
	AuthorizationRoutesAttached bool
}

// RouteInventory is a defensive snapshot of the installed facade surface.
type RouteInventory struct {
	ContractVersion                 string
	Routes                          []Route
	RootAuthorizationServerPattern  string
	RootAuthorizationServerAttached bool
}

type normalizedConfig struct {
	issuerURL               string
	jwksURI                 string
	registrationEndpointURL string
	urlMode                 URLMode
	publicBaseURL           string
	allowedHostnames        map[string]struct{}
	scopes                  map[mcproutes.EndpointKind][]string
	capabilities            Capabilities
	mcpHandler              apptheory.Handler
	authorizeHandlers       map[mcproutes.EndpointKind]apptheory.Handler
	tokenHandlers           map[mcproutes.EndpointKind]apptheory.Handler
	rootAuthorizationServer *oauth.AuthorizationServerMetadata
	rootDiscoveryPath       string
}

type routeRegistration struct {
	method  string
	pattern string
	handler apptheory.Handler
}

// RegisterMCPFacade installs the complete MCP OAuth facade described by
// mcproutes.ContractVersion and returns its route inventory. The helper owns
// composition only: authorize and token routes are absent unless the
// application supplies both handler factories.
func RegisterMCPFacade(app *apptheory.App, config FacadeConfig) (*RouteInventory, error) {
	if app == nil {
		return nil, fmt.Errorf("mcpfacade: app is required")
	}
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	inventory, err := buildInventory(normalized.authorizeHandlers != nil, normalized.rootAuthorizationServer != nil)
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

func normalizeConfig(config FacadeConfig) (normalizedConfig, error) {
	if config.MCPHandler == nil {
		return normalizedConfig{}, fmt.Errorf("mcpfacade: MCP handler is required")
	}

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

	rootAuthorizationServer, rootDiscoveryPath, err := normalizeRootDiscoveryConfig(config.RootAuthorizationServer)
	if err != nil {
		return normalizedConfig{}, err
	}

	return normalizedConfig{
		issuerURL:               issuerURL,
		jwksURI:                 jwksURI,
		registrationEndpointURL: registrationEndpointURL,
		urlMode:                 config.URLMode,
		publicBaseURL:           publicBaseURL,
		allowedHostnames:        allowedHostnames,
		scopes:                  scopes,
		capabilities:            capabilities,
		mcpHandler:              config.MCPHandler,
		authorizeHandlers:       authorizeHandlers,
		tokenHandlers:           tokenHandlers,
		rootAuthorizationServer: rootAuthorizationServer,
		rootDiscoveryPath:       rootDiscoveryPath,
	}, nil
}

func buildInventory(attachAuthorization, attachRootDiscovery bool) (*RouteInventory, error) {
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
		RootAuthorizationServerAttached: attachRootDiscovery,
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
			AuthorizationRoutesAttached: attachAuthorization,
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
	registrations := make([]routeRegistration, 0, len(inventory.Routes)*8+1)
	for _, route := range inventory.Routes {
		mcpHandler := checkedMCPHandler(route.Kind, config.mcpHandler)
		registrations = append(registrations,
			routeRegistration{method: "POST", pattern: route.MCPPattern, handler: mcpHandler},
			routeRegistration{method: "GET", pattern: route.MCPPattern, handler: mcpHandler},
			routeRegistration{method: "DELETE", pattern: route.MCPPattern, handler: mcpHandler},
			routeRegistration{method: "GET", pattern: route.ProtectedResourcePattern, handler: protectedResourceHandler(config, route.Kind)},
		)

		discoveryHandler := authorizationServerHandler(config, route.Kind)
		registrations = append(registrations,
			routeRegistration{method: "GET", pattern: route.DiscoveryCanonicalPattern, handler: discoveryHandler},
			routeRegistration{method: "GET", pattern: route.DiscoverySuffixPattern, handler: discoveryHandler},
		)

		if route.AuthorizationRoutesAttached {
			registrations = append(registrations,
				routeRegistration{method: "GET", pattern: route.AuthorizePattern, handler: checkedOAuthFacadeHandler(route.Kind, true, config.authorizeHandlers[route.Kind])},
				routeRegistration{method: "POST", pattern: route.TokenPattern, handler: checkedOAuthFacadeHandler(route.Kind, false, config.tokenHandlers[route.Kind])},
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
		})
	}
	if err := validateRouteRegistrations(registrations); err != nil {
		return nil, err
	}
	return registrations, nil
}

func validateRouteRegistrations(registrations []routeRegistration) error {
	seen := make(map[string]struct{}, len(registrations))
	probe := apptheory.New(apptheory.WithTier(apptheory.TierP0))
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
		if err := handleRoute(probe, method, registration.pattern, registration.handler); err != nil {
			return fmt.Errorf("mcpfacade: invalid or duplicate route inventory entry %s: %w", key, err)
		}
	}
	return nil
}

func registerRoutes(app *apptheory.App, registrations []routeRegistration) error {
	for _, registration := range registrations {
		if err := handleRoute(app, registration.method, registration.pattern, registration.handler); err != nil {
			return fmt.Errorf("mcpfacade: register %s %s: %w", registration.method, registration.pattern, err)
		}
	}
	return nil
}

func handleRoute(app *apptheory.App, method, pattern string, handler apptheory.Handler) (err error) {
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
	app.Handle(method, pattern, handler)
	return nil
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
		metadata := &oauth.ProtectedResourceMetadata{
			Resource:             resourceURL,
			AuthorizationServers: []string{config.issuerURL},
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
		authorizePath, err := endpoint.OAuthAuthorizePath()
		if err != nil {
			return nil, err
		}
		tokenPath, err := endpoint.OAuthTokenPath()
		if err != nil {
			return nil, err
		}
		authorizeURL, err := config.absoluteURL(ctx, authorizePath)
		if err != nil {
			if response, ok := metadataRequestFailure(err); ok {
				return response, nil
			}
			return nil, err
		}
		tokenURL, err := config.absoluteURL(ctx, tokenPath)
		if err != nil {
			if response, ok := metadataRequestFailure(err); ok {
				return response, nil
			}
			return nil, err
		}
		metadata := &oauth.AuthorizationServerMetadata{
			Issuer:                            config.issuerURL,
			AuthorizationEndpoint:             authorizeURL,
			TokenEndpoint:                     tokenURL,
			RegistrationEndpoint:              config.registrationEndpointURL,
			JWKSURI:                           config.jwksURI,
			ResponseTypesSupported:            append([]string(nil), config.capabilities.ResponseTypes...),
			GrantTypesSupported:               append([]string(nil), config.capabilities.GrantTypes...),
			TokenEndpointAuthMethodsSupported: append([]string(nil), config.capabilities.TokenEndpointAuthMethods...),
			CodeChallengeMethodsSupported:     append([]string(nil), config.capabilities.CodeChallengeMethods...),
			ScopesSupported:                   append([]string(nil), config.scopes[kind]...),
		}
		return withMetadataHeaders(oauth.AuthorizationServerMetadataHandler(metadata))(ctx)
	}
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
	}
	copy(clone.Routes, inventory.Routes)
	for index := range clone.Routes {
		clone.Routes[index].MCPMethods = append([]string(nil), inventory.Routes[index].MCPMethods...)
	}
	return clone
}
