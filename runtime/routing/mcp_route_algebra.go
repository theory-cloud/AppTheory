// Package routing defines AppTheory's versioned MCP route algebra.
package routing

import (
	"fmt"
	"path"
	"strings"
)

const (
	// ContractVersion is the MCP route-algebra contract implemented by this package.
	ContractVersion = "m17.mcp-route-algebra/v1"

	// ProtectedResourcePrefix is the RFC 9728 protected-resource metadata prefix.
	ProtectedResourcePrefix = "/.well-known/oauth-protected-resource"
	// AuthorizationServerPrefix is the RFC 8414 authorization-server metadata prefix.
	AuthorizationServerPrefix = "/.well-known/oauth-authorization-server"
)

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
		return "", fmt.Errorf("routing: unsupported protected resource path %q", protectedResourcePath)
	}
	return normalizePath(strings.TrimPrefix(protectedResourcePath, ProtectedResourcePrefix)), nil
}

// ProtectedResourcePathFromMCPPath derives the protected-resource path for an MCP path.
func ProtectedResourcePathFromMCPPath(mcpPath string) string {
	return ProtectedResourcePathForResourcePath(mcpPath)
}

// ParseMCPPath parses a concrete MCP path after contract normalization.
func ParseMCPPath(rawPath string) (EndpointPath, error) {
	segments := splitPath(normalizePath(rawPath))
	var endpoint EndpointPath

	switch len(segments) {
	case 2:
		if segments[1] == "mcp" {
			endpoint = EndpointPath{Kind: EndpointKindNamespace, ClientNamespace: segments[0]}
		}
	case 4:
		switch {
		case segments[1] == "partners" && segments[3] == "mcp":
			endpoint = EndpointPath{
				Kind: EndpointKindPartnerNamespace, ClientNamespace: segments[0], PartnerID: segments[2],
			}
		case segments[1] == "agents" && segments[3] == "mcp":
			endpoint = EndpointPath{
				Kind: EndpointKindAgent, ClientNamespace: segments[0], AgentID: segments[2],
			}
		}
	case 6:
		if segments[1] == "partners" && segments[3] == "agents" && segments[5] == "mcp" {
			endpoint = EndpointPath{
				Kind:            EndpointKindPartnerAgent,
				ClientNamespace: segments[0],
				PartnerID:       segments[2],
				AgentID:         segments[4],
			}
		}
	}

	if endpoint.Kind == "" {
		return EndpointPath{}, fmt.Errorf("routing: unsupported MCP path %q", rawPath)
	}
	if err := endpoint.Validate(); err != nil {
		return EndpointPath{}, fmt.Errorf("routing: invalid MCP path %q: %w", rawPath, err)
	}
	return endpoint, nil
}

// Validate verifies kind-to-identifier consistency and path-segment safety.
func (e EndpointPath) Validate() error {
	if !isPathSegment(e.ClientNamespace) {
		return fmt.Errorf("routing: client_namespace must be a non-empty path segment")
	}

	switch e.Kind {
	case EndpointKindNamespace:
		if e.PartnerID != "" || e.AgentID != "" {
			return fmt.Errorf("routing: namespace endpoint cannot include partner or agent identifiers")
		}
	case EndpointKindPartnerNamespace:
		if !isPathSegment(e.PartnerID) {
			return fmt.Errorf("routing: partner_id must be a non-empty path segment")
		}
		if e.AgentID != "" {
			return fmt.Errorf("routing: partner namespace endpoint cannot include agent_id")
		}
	case EndpointKindAgent:
		if !isPathSegment(e.AgentID) {
			return fmt.Errorf("routing: agent_id must be a non-empty path segment")
		}
		if e.PartnerID != "" {
			return fmt.Errorf("routing: agent endpoint cannot include partner_id")
		}
	case EndpointKindPartnerAgent:
		if !isPathSegment(e.PartnerID) {
			return fmt.Errorf("routing: partner_id must be a non-empty path segment")
		}
		if !isPathSegment(e.AgentID) {
			return fmt.Errorf("routing: agent_id must be a non-empty path segment")
		}
	default:
		return fmt.Errorf("routing: unsupported endpoint kind %q", e.Kind)
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
		return "", fmt.Errorf("routing: unsupported endpoint kind %q", e.Kind)
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

func normalizePath(rawPath string) string {
	rawPath = strings.TrimSpace(rawPath)
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

func splitPath(rawPath string) []string {
	rawPath = strings.TrimPrefix(rawPath, "/")
	if rawPath == "" {
		return nil
	}
	return strings.Split(rawPath, "/")
}

func isPathSegment(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && !strings.Contains(value, "/")
}
