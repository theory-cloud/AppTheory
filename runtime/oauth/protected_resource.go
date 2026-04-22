package oauth

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

const protectedResourceMetadataPath = "/.well-known/oauth-protected-resource"

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
