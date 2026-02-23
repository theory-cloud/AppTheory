package oauth

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

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

// ResourceMetadataURLFromMcpEndpoint derives the protected resource metadata URL
// from an MCP endpoint URL (which must end with `/mcp`).
//
// For example:
//
//	https://api.example.com/prod/mcp -> https://api.example.com/prod/.well-known/oauth-protected-resource
func ResourceMetadataURLFromMcpEndpoint(mcpEndpoint string) (string, bool) {
	u, ok := parseAbsoluteURL(mcpEndpoint)
	if !ok {
		return "", false
	}

	trimmedPath := strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(trimmedPath, "/mcp") {
		return "", false
	}

	base := strings.TrimSuffix(trimmedPath, "/mcp")
	if base == "" {
		base = "/"
	}

	out := *u
	out.Path = strings.TrimSuffix(base, "/") + "/.well-known/oauth-protected-resource"
	out.RawQuery = ""
	out.Fragment = ""
	return out.String(), true
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

// ProtectedResourceMetadataURLForRequest attempts to derive an absolute
// `/.well-known/oauth-protected-resource` URL from common proxy headers.
//
// Prefer using ResourceMetadataURLFromMcpEndpoint with MCP_ENDPOINT for AWS
// deployments; this helper is primarily for local/test environments.
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
		Path:   "/.well-known/oauth-protected-resource",
	}
	return u.String(), true
}

func firstHeader(headers map[string][]string, key string) string {
	values := headers[strings.ToLower(strings.TrimSpace(key))]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
