package oauth

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"path"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/v3/runtime"
)

const (
	httpsScheme = "https"
	httpScheme  = "http"

	// MCPPath is the conventional AppTheory MCP endpoint path.
	MCPPath = "/mcp"

	// OAuthProtectedResourcePath is the generic RFC 9728 protected-resource
	// metadata path.
	OAuthProtectedResourcePath = "/.well-known/oauth-protected-resource"

	// OAuthProtectedResourceMCPPath is the RFC 9728 path-scoped metadata path
	// for the conventional MCP endpoint.
	OAuthProtectedResourceMCPPath = "/.well-known/oauth-protected-resource/mcp"

	// OAuthAuthorizationServerMCPPath is the RFC 8414 path-scoped metadata path
	// for an MCP authorization server.
	OAuthAuthorizationServerMCPPath = "/.well-known/oauth-authorization-server/mcp"
)

const protectedResourceMetadataPath = OAuthProtectedResourcePath

// MCPServerConfig configures AppTheory's secure MCP route bundle. The
// protected resource origin is deliberately absent: discovery derives it from
// each request while the authorization server and JWKS remain install config.
type MCPServerConfig struct {
	// MCPPath overrides the conventional /mcp endpoint path.
	MCPPath string

	// AuthorizationServerIssuer is the configured OAuth authorization server
	// issuer advertised by RFC 9728 discovery.
	AuthorizationServerIssuer string

	// JWKSURI is the configured JSON Web Key Set URL advertised by discovery.
	JWKSURI string
}

// ProtectedResourceMetadata is the RFC9728 discovery document hosted by a
// protected resource server.
type ProtectedResourceMetadata struct {
	Resource               string   `json:"resource"`
	AuthorizationServers   []string `json:"authorization_servers"`
	JWKSURI                string   `json:"jwks_uri,omitempty"`
	ScopesSupported        []string `json:"scopes_supported,omitempty"`
	BearerMethodsSupported []string `json:"bearer_methods_supported,omitempty"`
}

// NewProtectedResourceMetadata creates a minimal metadata document. It requires:
// - resource: an absolute URL that identifies the protected resource (for MCP this is typically the `/mcp` endpoint)
// - authorizationServers: one or more OAuth AS issuer/base URLs
func NewProtectedResourceMetadata(resource string, authorizationServers []string) (*ProtectedResourceMetadata, error) {
	resource = strings.TrimSpace(resource)
	if _, ok := parseAbsoluteURL(resource); !ok {
		return nil, fmt.Errorf("%w: resource must be an absolute URL", ErrInvalidURL)
	}

	servers := make([]string, 0, len(authorizationServers))
	for _, raw := range authorizationServers {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if _, ok := parseAbsoluteURL(raw); !ok {
			return nil, fmt.Errorf("%w: authorization server must be an absolute URL", ErrInvalidURL)
		}
		servers = append(servers, raw)
	}
	if len(servers) == 0 {
		return nil, fmt.Errorf("%w: at least one authorization server is required", ErrInvalidURL)
	}

	return &ProtectedResourceMetadata{
		Resource:             resource,
		AuthorizationServers: servers,
	}, nil
}

// MarshalJSONBytes marshals the metadata document to JSON bytes.
func (m *ProtectedResourceMetadata) MarshalJSONBytes() ([]byte, error) {
	if m == nil {
		return []byte("null"), nil
	}
	return json.Marshal(m)
}

// ProtectedResourceMetadataHandler returns an AppTheory handler that serves the
// RFC9728 protected resource metadata document.
func ProtectedResourceMetadataHandler(md *ProtectedResourceMetadata) apptheory.Handler {
	return jsonBytesHandler(md.MarshalJSONBytes)
}

// NewMCPProtectedResourceDiscoveryHandler creates the request-time RFC 9728
// discovery handler used by namespace MCP applications. The protected
// resource URL is reconstructed from AppTheory's canonical request headers;
// no resource origin is accepted in config.
func NewMCPProtectedResourceDiscoveryHandler(config MCPServerConfig) (apptheory.Handler, error) {
	normalized, err := normalizeMCPServerConfig(config)
	if err != nil {
		return nil, err
	}
	return mcpProtectedResourceDiscoveryHandler(normalized), nil
}

// RegisterMCPServer registers the conventional authenticated MCP POST route
// and both public RFC 9728 discovery routes on a SecureApp. The fixed posture
// split is deliberate: clients must fetch discovery before they have a token,
// while the MCP endpoint uses SecureApp's authenticated posture.
func RegisterMCPServer(app *apptheory.SecureApp, handler apptheory.Handler, config MCPServerConfig) error {
	if app == nil {
		return fmt.Errorf("oauth: secure app is required")
	}
	if handler == nil {
		return fmt.Errorf("oauth: MCP handler is required")
	}
	normalized, err := normalizeMCPServerConfig(config)
	if err != nil {
		return err
	}

	discovery := mcpProtectedResourceDiscoveryHandler(normalized)
	app.Post(normalized.MCPPath, handler, apptheory.Authenticated())
	app.Get(OAuthProtectedResourcePath, discovery, apptheory.Public())
	app.Get(protectedResourcePathForMCPPath(normalized.MCPPath), discovery, apptheory.Public())
	return nil
}

func mcpProtectedResourceDiscoveryHandler(config MCPServerConfig) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		var headers map[string][]string
		if ctx != nil {
			headers = ctx.Request.Headers
		}
		requestOrigin, ok := normalizeRequestOrigin(apptheory.OriginURL(headers))
		if !ok {
			return jsonResponse(400, map[string]string{
				"error": "request host is required for OAuth protected-resource discovery",
			})
		}

		metadata := &ProtectedResourceMetadata{
			Resource:             requestOrigin + config.MCPPath,
			AuthorizationServers: []string{config.AuthorizationServerIssuer},
			JWKSURI:              config.JWKSURI,
		}
		return jsonResponse(200, metadata)
	}
}

func jsonResponse(status int, value any) (*apptheory.Response, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return &apptheory.Response{
		Status:  status,
		Headers: map[string][]string{"content-type": {"application/json"}},
		Body:    body,
	}, nil
}

func normalizeMCPServerConfig(config MCPServerConfig) (MCPServerConfig, error) {
	mcpPath, ok := normalizeMCPRoutePath(config.MCPPath)
	if !ok {
		return MCPServerConfig{}, fmt.Errorf("oauth: MCP path must be a literal absolute route path")
	}
	issuer, ok := normalizeConfiguredURL(config.AuthorizationServerIssuer, true)
	if !ok {
		return MCPServerConfig{}, fmt.Errorf("oauth: authorization server issuer must be an absolute HTTPS URL")
	}
	jwksURI, ok := normalizeConfiguredURL(config.JWKSURI, false)
	if !ok {
		return MCPServerConfig{}, fmt.Errorf("oauth: JWKS URI must be an absolute HTTPS URL")
	}
	return MCPServerConfig{
		MCPPath:                   mcpPath,
		AuthorizationServerIssuer: issuer,
		JWKSURI:                   jwksURI,
	}, nil
}

func normalizeMCPRoutePath(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = MCPPath
	}
	if !strings.HasPrefix(raw, "/") || raw == "/" || strings.ContainsAny(raw, "?#{}") {
		return "", false
	}
	if strings.Contains(raw, "//") || strings.HasSuffix(raw, "/") || path.Clean(raw) != raw {
		return "", false
	}
	u, err := url.ParseRequestURI(raw)
	if err != nil || u.IsAbs() || u.Host != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	return raw, true
}

func protectedResourcePathForMCPPath(mcpPath string) string {
	return OAuthProtectedResourcePath + mcpPath
}

func normalizeConfiguredURL(raw string, trimTrailingSlash bool) (string, bool) {
	u, ok := parseAbsoluteURL(raw)
	if !ok || u.User != nil || u.Fragment != "" || u.Hostname() == "" {
		return "", false
	}
	if !isAllowedDiscoveryScheme(u.Scheme, u.Hostname()) {
		return "", false
	}
	if trimTrailingSlash {
		u.Path = strings.TrimRight(u.Path, "/")
	}
	u.RawPath = ""
	return u.String(), true
}

func normalizeRequestOrigin(raw string) (string, bool) {
	u, ok := parseAbsoluteURL(raw)
	if !ok || u.User != nil || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	if u.Path != "" && u.Path != "/" {
		return "", false
	}
	if !isAllowedDiscoveryScheme(u.Scheme, u.Hostname()) {
		return "", false
	}
	u.Path = ""
	u.RawPath = ""
	return strings.TrimRight(u.String(), "/"), true
}

func isLoopbackHostname(host string) bool {
	host = strings.TrimSpace(strings.ToLower(host))
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isAllowedDiscoveryScheme(scheme, hostname string) bool {
	return scheme == httpsScheme || (scheme == httpScheme && isLoopbackHostname(hostname))
}

// ProtectedResourceWWWAuthenticate builds the RFC9728 MCP-style discovery challenge.
//
// Example:
//
//	Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"
func ProtectedResourceWWWAuthenticate(resourceMetadataURL string) string {
	resourceMetadataURL = strings.TrimSpace(resourceMetadataURL)
	if resourceMetadataURL == "" {
		return "Bearer"
	}
	escaped := strings.ReplaceAll(resourceMetadataURL, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "\"", "\\\"")
	return fmt.Sprintf("Bearer resource_metadata=\"%s\"", escaped)
}

// RFC9728ResourceMetadataURL derives the protected resource metadata URL
// from any absolute protected resource identifier URL per RFC 9728 section 3.
//
// For example:
//
//	https://api.example.com/mcp      -> https://api.example.com/.well-known/oauth-protected-resource/mcp
//	https://api.example.com/mcp/Arch -> https://api.example.com/.well-known/oauth-protected-resource/mcp/Arch
func RFC9728ResourceMetadataURL(resourceURL string) (string, bool) {
	u, ok := parseAbsoluteURL(resourceURL)
	if !ok {
		return "", false
	}

	out := *u
	out.Path = protectedResourceMetadataPath + u.Path
	if out.Path == protectedResourceMetadataPath {
		out.Path = protectedResourceMetadataPath
	}
	out.RawPath = ""
	out.Fragment = ""
	return out.String(), true
}

// ResourceMetadataURLFromMcpEndpoint derives the protected resource metadata URL
// from an MCP endpoint URL.
//
// This compatibility alias intentionally performs no `/mcp` suffix validation;
// any absolute protected resource URL is accepted and transformed per RFC 9728.
func ResourceMetadataURLFromMcpEndpoint(mcpEndpoint string) (string, bool) {
	return RFC9728ResourceMetadataURL(mcpEndpoint)
}

// CanonicalResourceURL trims whitespace and a trailing slash.
func CanonicalResourceURL(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimRight(raw, "/")
	return raw
}

// CanonicalizeIssuerURL trims trailing slashes from an issuer/base URL.
func CanonicalizeIssuerURL(raw string) (string, bool) {
	u, ok := parseAbsoluteURL(raw)
	if !ok {
		return "", false
	}
	out := *u
	out.Path = strings.TrimRight(out.Path, "/")
	return out.String(), true
}

// ProtectedResourceMetadataURLForRequest derives an absolute root
// `/.well-known/oauth-protected-resource` URL from common proxy headers.
//
// Prefer using ResourceMetadataURLFromMcpEndpoint with an explicit MCP endpoint
// URL for AWS Remote MCP deployments. This helper is intentionally root-only
// and does not attempt to infer path-scoped protected resources from request
// paths.
func ProtectedResourceMetadataURLForRequest(headers map[string][]string) (string, bool) {
	host := firstHeader(headers, "host")
	if host == "" {
		return "", false
	}
	proto := firstHeader(headers, "x-forwarded-proto")
	if proto == "" {
		proto = "https"
	}
	u := &url.URL{
		Scheme: proto,
		Host:   host,
		Path:   protectedResourceMetadataPath,
	}
	return u.String(), true
}

func resolveAbsoluteURLPathTemplate(resourceURL, requestPath string, params map[string]string) (string, bool) {
	u, ok := parseAbsoluteURL(resourceURL)
	if !ok {
		return "", false
	}

	templateSegments := splitURLPath(u.Path)
	if len(templateSegments) == 0 {
		return u.String(), true
	}

	requestSegments := splitURLPath(requestPath)
	resolved := make([]string, 0, len(templateSegments))
	changed := false
	for i, segment := range templateSegments {
		name, isParam := routeTemplateParam(segment)
		if !isParam {
			resolved = append(resolved, segment)
			continue
		}

		value := strings.TrimSpace(params[name])
		if value == "" && len(requestSegments) == len(templateSegments) {
			value = strings.TrimSpace(requestSegments[i])
		}
		if value == "" {
			return "", false
		}

		resolved = append(resolved, value)
		changed = true
	}

	if !changed {
		return u.String(), true
	}

	out := *u
	out.Path = "/" + strings.Join(resolved, "/")
	out.RawPath = ""
	return out.String(), true
}

func routeTemplateParam(segment string) (string, bool) {
	segment = strings.TrimSpace(segment)
	if !strings.HasPrefix(segment, "{") || !strings.HasSuffix(segment, "}") || len(segment) < 3 {
		return "", false
	}
	name := strings.TrimSpace(segment[1 : len(segment)-1])
	if name == "" {
		return "", false
	}
	return name, true
}

func splitURLPath(path string) []string {
	path = strings.TrimSpace(path)
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
}

func firstHeader(headers map[string][]string, key string) string {
	values := headers[strings.ToLower(strings.TrimSpace(key))]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
