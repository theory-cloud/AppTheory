// Package mcproutes defines AppTheory's versioned MCP route algebra.
package mcproutes

import (
	"fmt"
	"path"
	"strings"
)

const (
	mcpSegment                = "mcp"
	asciiWhitespaceTrimCutset = "\t\n\v\f\r "
)

const (
	// ContractVersion is the MCP route-algebra contract implemented by this package.
	//
	// v2 is a superset of v1: the four canonical MCP patterns and the v1
	// derivations (protected resource, canonical/suffix discovery, authorize,
	// token) are unchanged. v2 adds the derived register path per kind, one
	// stage-global callback path, and the IssuerMode vocabulary for per-route
	// issuer/resource derivation.
	ContractVersion = "m17.mcp-route-algebra/v2"
	// ContractVersionV1 is the superseded read contract retained for compatibility.
	ContractVersionV1 = "m17.mcp-route-algebra/v1"
	// ParamClientNamespace is the canonical client-namespace route parameter name.
	ParamClientNamespace = "client_namespace"
	// ParamPartnerID is the canonical partner route parameter name.
	ParamPartnerID = "partner_id"
	// ParamAgentID is the canonical agent route parameter name.
	ParamAgentID = "agent_id"

	// ProtectedResourcePrefix is the RFC 9728 protected-resource metadata prefix.
	ProtectedResourcePrefix = "/.well-known/oauth-protected-resource"
	// AuthorizationServerPrefix is the RFC 8414 authorization-server metadata prefix.
	AuthorizationServerPrefix = "/.well-known/oauth-authorization-server"

	// DefaultCallbackPath is the stage-global upstream OAuth callback path.
	//
	// The callback is correlated by the single-use upstream state the facade
	// minted, so one stage-global route is sufficient and no per-kind callback
	// multiplies.
	DefaultCallbackPath = "/_oauth/mcp/callback"
	// CallbackPatternKey names the stage-global callback route in the route model.
	CallbackPatternKey = "upstream_callback"
)

// IssuerMode selects how the facade derives each route's issuer and resource.
type IssuerMode string

const (
	// IssuerModeFamily advertises one family-wide issuer for the whole facade.
	// This is the current behavior and remains for single-tenant/root-only
	// deployments.
	IssuerModeFamily IssuerMode = "family"
	// IssuerModeRoute makes each route its own authorization-server issuer: the
	// route URL. Required for single-domain proxying of an upstream provider and
	// for RFC 9207 iss-aware clients.
	IssuerModeRoute IssuerMode = "route"
)

// SupportedIssuerModes returns the closed IssuerMode vocabulary in contract order.
func SupportedIssuerModes() []IssuerMode {
	return []IssuerMode{IssuerModeFamily, IssuerModeRoute}
}

// EndpointKind identifies a canonical MCP endpoint shape.
type EndpointKind string

const (
	// EndpointKindNamespace identifies a namespace MCP endpoint.
	EndpointKindNamespace EndpointKind = "namespace"
	// EndpointKindPartnerNamespace identifies a partner-scoped namespace MCP endpoint.
	EndpointKindPartnerNamespace EndpointKind = "partner_namespace"
	// EndpointKindAgent identifies an agent MCP endpoint.
	EndpointKindAgent EndpointKind = "agent"
	// EndpointKindPartnerAgent identifies a partner-scoped agent MCP endpoint.
	EndpointKindPartnerAgent EndpointKind = "partner_agent"
)

const (
	// NamespaceMCPPattern is the canonical namespace MCP route pattern.
	NamespaceMCPPattern = "/{client_namespace}/mcp"
	// PartnerNamespaceMCPPattern is the canonical partner-scoped namespace MCP route pattern.
	PartnerNamespaceMCPPattern = "/{client_namespace}/partners/{partner_id}/mcp"
	// AgentMCPPattern is the canonical agent MCP route pattern.
	AgentMCPPattern = "/{client_namespace}/agents/{agent_id}/mcp"
	// PartnerAgentMCPPattern is the canonical partner-scoped agent MCP route pattern.
	PartnerAgentMCPPattern = "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp"
)

var endpointTemplateSeeds = [...]struct {
	kind    EndpointKind
	pattern string
}{
	{kind: EndpointKindNamespace, pattern: NamespaceMCPPattern},
	{kind: EndpointKindPartnerNamespace, pattern: PartnerNamespaceMCPPattern},
	{kind: EndpointKindAgent, pattern: AgentMCPPattern},
	{kind: EndpointKindPartnerAgent, pattern: PartnerAgentMCPPattern},
}

// EndpointTemplate describes a canonical MCP route pattern and its protected-resource route.
type EndpointTemplate struct {
	Kind                  EndpointKind
	MCPPattern            string
	ProtectedResourcePath string
}

// OAuthFacadeTemplate describes the authorization facade routes for an MCP endpoint kind.
type OAuthFacadeTemplate struct {
	Kind             EndpointKind
	AuthorizePattern string
	TokenPattern     string
	RegisterPattern  string
}

// OAuthDiscoveryTemplate describes canonical and suffix-compatible discovery routes.
type OAuthDiscoveryTemplate struct {
	Kind             EndpointKind
	CanonicalPattern string
	SuffixPattern    string
}

// EndpointPath is a concrete canonical MCP endpoint.
type EndpointPath struct {
	Kind            EndpointKind
	ClientNamespace string
	PartnerID       string
	AgentID         string
}

// SupportedEndpointTemplates returns every canonical MCP endpoint template in contract order.
func SupportedEndpointTemplates() []EndpointTemplate {
	templates := make([]EndpointTemplate, 0, len(endpointTemplateSeeds))
	for _, seed := range endpointTemplateSeeds {
		templates = append(templates, EndpointTemplate{
			Kind:                  seed.kind,
			MCPPattern:            seed.pattern,
			ProtectedResourcePath: ProtectedResourcePathForResourcePath(seed.pattern),
		})
	}
	return templates
}

// SupportedOAuthFacadeTemplates returns every canonical OAuth facade template in contract order.
func SupportedOAuthFacadeTemplates() []OAuthFacadeTemplate {
	templates := make([]OAuthFacadeTemplate, 0, len(endpointTemplateSeeds))
	for _, seed := range endpointTemplateSeeds {
		templates = append(templates, OAuthFacadeTemplate{
			Kind:             seed.kind,
			AuthorizePattern: AuthorizationAuthorizePathForResourcePath(seed.pattern),
			TokenPattern:     AuthorizationTokenPathForResourcePath(seed.pattern),
			RegisterPattern:  AuthorizationRegisterPathForResourcePath(seed.pattern),
		})
	}
	return templates
}

// SupportedOAuthDiscoveryTemplates returns every canonical OAuth discovery template in contract order.
func SupportedOAuthDiscoveryTemplates() []OAuthDiscoveryTemplate {
	templates := make([]OAuthDiscoveryTemplate, 0, len(endpointTemplateSeeds))
	for _, seed := range endpointTemplateSeeds {
		templates = append(templates, OAuthDiscoveryTemplate{
			Kind:             seed.kind,
			CanonicalPattern: AuthorizationServerPathForResourcePath(seed.pattern),
			SuffixPattern:    AuthorizationServerSuffixPathForResourcePath(seed.pattern),
		})
	}
	return templates
}

// ProtectedResourcePathForResourcePath derives an RFC 9728 protected-resource path.
func ProtectedResourcePathForResourcePath(resourcePath string) string {
	resourcePath = normalizePath(resourcePath)
	if resourcePath == "/" {
		return ProtectedResourcePrefix
	}
	return ProtectedResourcePrefix + resourcePath
}

// AuthorizationServerPathForResourcePath derives the canonical RFC 8414 discovery path.
func AuthorizationServerPathForResourcePath(resourcePath string) string {
	resourcePath = normalizePath(resourcePath)
	if resourcePath == "/" {
		return AuthorizationServerPrefix
	}
	return AuthorizationServerPrefix + resourcePath
}

// AuthorizationAuthorizePathForResourcePath derives the authorization facade path.
func AuthorizationAuthorizePathForResourcePath(resourcePath string) string {
	return AuthorizationServerPathForResourcePath(resourcePath) + "/authorize"
}

// AuthorizationTokenPathForResourcePath derives the token facade path.
func AuthorizationTokenPathForResourcePath(resourcePath string) string {
	return AuthorizationServerPathForResourcePath(resourcePath) + "/token"
}

// AuthorizationRegisterPathForResourcePath derives the RFC 7591 dynamic-client
// registration facade path mounted beside the canonical RFC 8414 discovery path.
//
// The routed discovery document advertises exactly this path as
// registration_endpoint, so the advertised URL and the mounted route cannot
// drift.
func AuthorizationRegisterPathForResourcePath(resourcePath string) string {
	return AuthorizationServerPathForResourcePath(resourcePath) + "/register"
}

// AuthorizationServerSuffixPathForResourcePath derives the suffix-compatible RFC 8414 discovery path.
func AuthorizationServerSuffixPathForResourcePath(resourcePath string) string {
	resourcePath = normalizePath(resourcePath)
	if resourcePath == "/" {
		return AuthorizationServerPrefix
	}
	return resourcePath + AuthorizationServerPrefix
}

// ResourcePathFromProtectedResourcePath recovers a resource path from its RFC 9728 metadata path.
func ResourcePathFromProtectedResourcePath(protectedResourcePath string) (string, error) {
	protectedResourcePath = normalizePath(protectedResourcePath)
	if protectedResourcePath == ProtectedResourcePrefix {
		return "/", nil
	}
	if !strings.HasPrefix(protectedResourcePath, ProtectedResourcePrefix+"/") {
		return "", fmt.Errorf("mcproutes: unsupported protected resource path %q", protectedResourcePath)
	}
	return normalizePath(strings.TrimPrefix(protectedResourcePath, ProtectedResourcePrefix)), nil
}

// ProtectedResourcePathFromMCPPath derives the protected-resource path for an MCP path.
func ProtectedResourcePathFromMCPPath(mcpPath string) string {
	return ProtectedResourcePathForResourcePath(mcpPath)
}

// ParseMCPPath parses a concrete MCP path after contract normalization.
func ParseMCPPath(rawPath string) (EndpointPath, error) {
	if endpoint, matched := endpointFromSegments(splitPathBeforeDotNormalization(rawPath)); matched {
		if err := endpoint.Validate(); err != nil {
			return EndpointPath{}, fmt.Errorf("mcproutes: invalid MCP path %q: %w", rawPath, err)
		}
		return endpoint, nil
	}

	endpoint, matched := endpointFromSegments(splitPath(normalizePath(rawPath)))
	if !matched {
		return EndpointPath{}, fmt.Errorf("mcproutes: unsupported MCP path %q", rawPath)
	}
	if err := endpoint.Validate(); err != nil {
		return EndpointPath{}, fmt.Errorf("mcproutes: invalid MCP path %q: %w", rawPath, err)
	}
	return endpoint, nil
}

func endpointFromSegments(segments []string) (EndpointPath, bool) {
	var endpoint EndpointPath

	switch len(segments) {
	case 2:
		if segments[1] == mcpSegment {
			endpoint = EndpointPath{Kind: EndpointKindNamespace, ClientNamespace: segments[0]}
		}
	case 4:
		switch {
		case segments[1] == "partners" && segments[3] == mcpSegment:
			endpoint = EndpointPath{
				Kind: EndpointKindPartnerNamespace, ClientNamespace: segments[0], PartnerID: segments[2],
			}
		case segments[1] == "agents" && segments[3] == mcpSegment:
			endpoint = EndpointPath{
				Kind: EndpointKindAgent, ClientNamespace: segments[0], AgentID: segments[2],
			}
		}
	case 6:
		if segments[1] == "partners" && segments[3] == "agents" && segments[5] == mcpSegment {
			endpoint = EndpointPath{
				Kind:            EndpointKindPartnerAgent,
				ClientNamespace: segments[0],
				PartnerID:       segments[2],
				AgentID:         segments[4],
			}
		}
	}

	return endpoint, endpoint.Kind != ""
}

// Validate verifies kind-to-identifier consistency and path-segment safety.
func (e EndpointPath) Validate() error {
	if !isPathSegment(e.ClientNamespace) {
		return fmt.Errorf("mcproutes: client_namespace must be a non-empty path segment")
	}

	switch e.Kind {
	case EndpointKindNamespace:
		if e.PartnerID != "" || e.AgentID != "" {
			return fmt.Errorf("mcproutes: namespace endpoint cannot include partner or agent identifiers")
		}
	case EndpointKindPartnerNamespace:
		if !isPathSegment(e.PartnerID) {
			return fmt.Errorf("mcproutes: partner_id must be a non-empty path segment")
		}
		if e.AgentID != "" {
			return fmt.Errorf("mcproutes: partner namespace endpoint cannot include agent_id")
		}
	case EndpointKindAgent:
		if !isPathSegment(e.AgentID) {
			return fmt.Errorf("mcproutes: agent_id must be a non-empty path segment")
		}
		if e.PartnerID != "" {
			return fmt.Errorf("mcproutes: agent endpoint cannot include partner_id")
		}
	case EndpointKindPartnerAgent:
		if !isPathSegment(e.PartnerID) {
			return fmt.Errorf("mcproutes: partner_id must be a non-empty path segment")
		}
		if !isPathSegment(e.AgentID) {
			return fmt.Errorf("mcproutes: agent_id must be a non-empty path segment")
		}
	default:
		return fmt.Errorf("mcproutes: unsupported endpoint kind %q", e.Kind)
	}

	return nil
}

// MCPPath builds the concrete MCP path for the endpoint.
func (e EndpointPath) MCPPath() (string, error) {
	if err := e.Validate(); err != nil {
		return "", err
	}

	switch e.Kind {
	case EndpointKindNamespace:
		return "/" + e.ClientNamespace + "/mcp", nil
	case EndpointKindPartnerNamespace:
		return "/" + e.ClientNamespace + "/partners/" + e.PartnerID + "/mcp", nil
	case EndpointKindAgent:
		return "/" + e.ClientNamespace + "/agents/" + e.AgentID + "/mcp", nil
	case EndpointKindPartnerAgent:
		return "/" + e.ClientNamespace + "/partners/" + e.PartnerID + "/agents/" + e.AgentID + "/mcp", nil
	default:
		return "", fmt.Errorf("mcproutes: unsupported endpoint kind %q", e.Kind)
	}
}

// ProtectedResourcePath builds the endpoint's RFC 9728 protected-resource path.
func (e EndpointPath) ProtectedResourcePath() (string, error) {
	return e.derive(ProtectedResourcePathForResourcePath)
}

// OAuthAuthorizationServerPath builds the endpoint's canonical RFC 8414 discovery path.
func (e EndpointPath) OAuthAuthorizationServerPath() (string, error) {
	return e.derive(AuthorizationServerPathForResourcePath)
}

// OAuthAuthorizePath builds the endpoint's authorization facade path.
func (e EndpointPath) OAuthAuthorizePath() (string, error) {
	return e.derive(AuthorizationAuthorizePathForResourcePath)
}

// OAuthTokenPath builds the endpoint's token facade path.
func (e EndpointPath) OAuthTokenPath() (string, error) {
	return e.derive(AuthorizationTokenPathForResourcePath)
}

// OAuthRegisterPath builds the endpoint's dynamic-client registration path.
func (e EndpointPath) OAuthRegisterPath() (string, error) {
	return e.derive(AuthorizationRegisterPathForResourcePath)
}

// OAuthAuthorizationServerSuffixPath builds the endpoint's suffix-compatible RFC 8414 discovery path.
func (e EndpointPath) OAuthAuthorizationServerSuffixPath() (string, error) {
	return e.derive(AuthorizationServerSuffixPathForResourcePath)
}

func (e EndpointPath) derive(derivation func(string) string) (string, error) {
	mcpPath, err := e.MCPPath()
	if err != nil {
		return "", err
	}
	return derivation(mcpPath), nil
}

// StageGlobalRoute describes one route that is not derived from an MCP endpoint
// kind but is installed once per deployment.
type StageGlobalRoute struct {
	Name    string
	Pattern string
	Methods []string
}

// SupportedStageGlobalRoutes returns the stage-global route inventory in contract order.
//
// v2 adds exactly one stage-global route: the upstream OAuth callback. The
// callback path is overridable (FacadeConfig.UpstreamCallbackPath); this returns
// the contract default.
func SupportedStageGlobalRoutes() []StageGlobalRoute {
	return []StageGlobalRoute{
		{
			Name:    CallbackPatternKey,
			Pattern: DefaultCallbackPath,
			Methods: []string{"GET"},
		},
	}
}

// CallbackPathForConfiguredPath resolves the effective callback path for a
// configuration value, falling back to the contract default when unset.
func CallbackPathForConfiguredPath(configured string) (string, bool) {
	configured = strings.Trim(configured, asciiWhitespaceTrimCutset)
	if configured == "" {
		return DefaultCallbackPath, true
	}
	return NormalizeCallbackPath(configured)
}

// NormalizeCallbackPath validates and normalizes an absolute callback path.
//
// The path must be absolute, contain no query or fragment, and must not use a
// dot segment. It is normalized with the same rules as every other route path.
func NormalizeCallbackPath(rawPath string) (string, bool) {
	rawPath = strings.Trim(rawPath, asciiWhitespaceTrimCutset)
	if rawPath == "" || !strings.HasPrefix(rawPath, "/") {
		return "", false
	}
	if containsRefusedRoutePathBytes(rawPath) {
		return "", false
	}
	if strings.ContainsAny(rawPath, "?#") {
		return "", false
	}
	for _, segment := range strings.Split(rawPath, "/") {
		if segment == "." || segment == ".." {
			return "", false
		}
	}
	return normalizePath(rawPath), true
}

func normalizePath(rawPath string) string {
	rawPath = strings.Trim(rawPath, asciiWhitespaceTrimCutset)
	if rawPath == "" {
		return "/"
	}
	if !strings.HasPrefix(rawPath, "/") {
		rawPath = "/" + rawPath
	}
	cleaned := path.Clean(rawPath)
	if cleaned == "." {
		return "/"
	}
	return cleaned
}

func splitPathBeforeDotNormalization(rawPath string) []string {
	rawPath = strings.Trim(rawPath, asciiWhitespaceTrimCutset)
	segments := make([]string, 0)
	for _, segment := range strings.Split(rawPath, "/") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	return segments
}

func splitPath(rawPath string) []string {
	rawPath = strings.TrimPrefix(rawPath, "/")
	if rawPath == "" {
		return nil
	}
	return strings.Split(rawPath, "/")
}

func isPathSegment(value string) bool {
	trimmed := strings.Trim(value, asciiWhitespaceTrimCutset)
	return trimmed != "" && trimmed != "." && trimmed != ".." &&
		!strings.Contains(value, "/") && !containsRefusedRoutePathBytes(trimmed)
}

// containsRefusedRoutePathBytes reports whether a route path, already trimmed at
// its edges, carries the bytes the route algebra refuses: a percent-encoded
// slash, an interior ASCII whitespace or control character, or a backslash.
func containsRefusedRoutePathBytes(value string) bool {
	if strings.Contains(value, "%2F") || strings.Contains(value, "%2f") {
		return true
	}
	for _, r := range value {
		if r == '\\' || r <= 0x1F || r == 0x20 || r == 0x7F {
			return true
		}
	}
	return false
}
