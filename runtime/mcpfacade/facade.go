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
	httpsScheme = "https"
	httpScheme  = "http"
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
	ContractVersion string
	Routes          []Route
}

type normalizedConfig struct {
	issuerURL               string
	jwksURI                 string
	registrationEndpointURL string
	urlMode                 URLMode
	publicBaseURL           string
	scopes                  map[mcproutes.EndpointKind][]string
	capabilities            Capabilities
	mcpHandler              apptheory.Handler
	authorizeHandlers       map[mcproutes.EndpointKind]apptheory.Handler
	tokenHandlers           map[mcproutes.EndpointKind]apptheory.Handler
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
	inventory, err := buildInventory(normalized.authorizeHandlers != nil)
	if err != nil {
		return nil, err
	}

	for _, route := range inventory.Routes {
		mcpHandler := checkedMCPHandler(route.Kind, normalized.mcpHandler)
		app.Post(route.MCPPattern, mcpHandler)
		app.Get(route.MCPPattern, mcpHandler)
		app.Delete(route.MCPPattern, mcpHandler)
		app.Get(route.ProtectedResourcePattern, protectedResourceHandler(normalized, route.Kind))

		discoveryHandler := authorizationServerHandler(normalized, route.Kind)
		app.Get(route.DiscoveryCanonicalPattern, discoveryHandler)
		app.Get(route.DiscoverySuffixPattern, discoveryHandler)

		if route.AuthorizationRoutesAttached {
			app.Get(route.AuthorizePattern, checkedOAuthFacadeHandler(route.Kind, true, normalized.authorizeHandlers[route.Kind]))
			app.Post(route.TokenPattern, checkedOAuthFacadeHandler(route.Kind, false, normalized.tokenHandlers[route.Kind]))
		}
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

	var publicBaseURL string
	switch config.URLMode {
	case URLModePublicBaseURL:
		publicBaseURL, ok = normalizePublicBaseURL(config.PublicBaseURL)
		if !ok {
			return normalizedConfig{}, fmt.Errorf("mcpfacade: public base URL mode requires an absolute HTTPS URL or loopback HTTP URL without query or fragment")
		}
	case URLModeRequestHost:
		if strings.TrimSpace(config.PublicBaseURL) != "" {
			return normalizedConfig{}, fmt.Errorf("mcpfacade: request-host mode cannot also configure a public base URL")
		}
	default:
		return normalizedConfig{}, fmt.Errorf("mcpfacade: URL mode must be public_base_url or request_host")
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

	return normalizedConfig{
		issuerURL:               issuerURL,
		jwksURI:                 jwksURI,
		registrationEndpointURL: registrationEndpointURL,
		urlMode:                 config.URLMode,
		publicBaseURL:           publicBaseURL,
		scopes:                  scopes,
		capabilities:            capabilities,
		mcpHandler:              config.MCPHandler,
		authorizeHandlers:       authorizeHandlers,
		tokenHandlers:           tokenHandlers,
	}, nil
}

func buildInventory(attachAuthorization bool) (*RouteInventory, error) {
	endpoints := mcproutes.SupportedEndpointTemplates()
	facades := indexFacadeTemplates(mcproutes.SupportedOAuthFacadeTemplates())
	discovery := indexDiscoveryTemplates(mcproutes.SupportedOAuthDiscoveryTemplates())
	if len(endpoints) != len(facades) || len(endpoints) != len(discovery) {
		return nil, fmt.Errorf("mcpfacade: incomplete %s route template inventory", mcproutes.ContractVersion)
	}

	inventory := &RouteInventory{ContractVersion: mcproutes.ContractVersion, Routes: make([]Route, 0, len(endpoints))}
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
			return nil, err
		}
		metadata := &oauth.ProtectedResourceMetadata{
			Resource:             resourceURL,
			AuthorizationServers: []string{config.issuerURL},
			JWKSURI:              config.jwksURI,
			ScopesSupported:      append([]string(nil), config.scopes[kind]...),
		}
		return oauth.ProtectedResourceMetadataHandler(metadata)(ctx)
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
			return nil, err
		}
		tokenURL, err := config.absoluteURL(ctx, tokenPath)
		if err != nil {
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
		return oauth.AuthorizationServerMetadataHandler(metadata)(ctx)
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
		ClientNamespace: ctx.Param("client_namespace"),
		PartnerID:       ctx.Param("partner_id"),
		AgentID:         ctx.Param("agent_id"),
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
			return "", fmt.Errorf("mcpfacade: request context is required for request-host URL mode")
		}
		var ok bool
		baseURL, ok = normalizeRequestOrigin(apptheory.OriginURL(ctx.Request.Headers))
		if !ok {
			return "", fmt.Errorf("mcpfacade: request host is required for request-host URL mode")
		}
	}
	absolute, ok := absoluteURLForPath(baseURL, routePath)
	if !ok {
		return "", fmt.Errorf("mcpfacade: cannot build absolute URL for route path %q", routePath)
	}
	return absolute, nil
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
	u, ok := parseAbsoluteURL(raw)
	if !ok || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" {
		return "", false
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if !isAllowedPublicScheme(u.Scheme, u.Hostname()) {
		return "", false
	}
	u.Host = canonicalAuthority(u)
	if u.Host == "" {
		return "", false
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath = ""
	return u.String(), true
}

func normalizeRequestOrigin(raw string) (string, bool) {
	u, ok := parseAbsoluteURL(raw)
	if !ok || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", false
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if !isAllowedPublicScheme(u.Scheme, u.Hostname()) {
		return "", false
	}
	u.Host = canonicalAuthority(u)
	if u.Host == "" {
		return "", false
	}
	u.Path = ""
	u.RawPath = ""
	return u.String(), true
}

func parseAbsoluteURL(raw string) (*url.URL, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.Hostname() == "" {
		return nil, false
	}
	return u, true
}

func canonicalAuthority(u *url.URL) string {
	hostname := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if hostname == "" {
		return ""
	}
	port := u.Port()
	if (u.Scheme == httpsScheme && port == "443") || (u.Scheme == httpScheme && port == "80") {
		port = ""
	}
	if port != "" {
		return net.JoinHostPort(hostname, port)
	}
	if strings.Contains(hostname, ":") {
		return "[" + hostname + "]"
	}
	return hostname
}

func isLoopbackHostname(hostname string) bool {
	hostname = strings.ToLower(strings.TrimSpace(hostname))
	if hostname == "localhost" {
		return true
	}
	ip := net.ParseIP(hostname)
	return ip != nil && ip.IsLoopback()
}

func isAllowedPublicScheme(scheme, hostname string) bool {
	return scheme == httpsScheme || scheme == httpScheme && isLoopbackHostname(hostname)
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
	clone := &RouteInventory{ContractVersion: inventory.ContractVersion, Routes: make([]Route, len(inventory.Routes))}
	copy(clone.Routes, inventory.Routes)
	for index := range clone.Routes {
		clone.Routes[index].MCPMethods = append([]string(nil), inventory.Routes[index].MCPMethods...)
	}
	return clone
}
