package oauth

import (
	"fmt"
	"sort"
	"strings"
)

// DynamicClientRegistrationRequest is an RFC7591 client registration request.
type DynamicClientRegistrationRequest struct {
	ClientName              string   `json:"client_name,omitempty"`
	RedirectURIs            []string `json:"redirect_uris,omitempty"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method,omitempty"`
	GrantTypes              []string `json:"grant_types,omitempty"`
	ResponseTypes           []string `json:"response_types,omitempty"`
	Scope                   string   `json:"scope,omitempty"`
}

// DynamicClientRegistrationResponse is a minimal RFC7591 response.
type DynamicClientRegistrationResponse struct {
	ClientID string `json:"client_id"`
	// ClientSecret is omitted for public clients.
	ClientSecret          string `json:"client_secret,omitempty"`
	ClientIDIssuedAt      int64  `json:"client_id_issued_at,omitempty"`
	ClientSecretExpiresAt int64  `json:"client_secret_expires_at,omitempty"`
}

// DynamicClientRegistrationPolicy controls DCR validation.
type DynamicClientRegistrationPolicy struct {
	AllowedRedirectURIs []string
	RequirePublicClient bool // token_endpoint_auth_method must be "none"
	RequireRefreshToken bool // grant_types must include "refresh_token" (if grant_types provided)
}

// ClaudeDynamicClientRegistrationPolicy returns a day-1 policy compatible with
// Claude connectors.
func ClaudeDynamicClientRegistrationPolicy() DynamicClientRegistrationPolicy {
	return DynamicClientRegistrationPolicy{
		AllowedRedirectURIs: []string{
			"https://claude.ai/api/mcp/auth_callback",
			"https://claude.com/api/mcp/auth_callback",
		},
		RequirePublicClient: true,
		RequireRefreshToken: true,
	}
}

// ValidateDynamicClientRegistrationRequest validates an RFC7591 request against a policy.
func ValidateDynamicClientRegistrationRequest(req *DynamicClientRegistrationRequest, policy DynamicClientRegistrationPolicy) error {
	if req == nil {
		return fmt.Errorf("dcr: request is nil")
	}

	allowed := make(map[string]bool, len(policy.AllowedRedirectURIs))
	for _, u := range policy.AllowedRedirectURIs {
		u = strings.TrimSpace(u)
		if u == "" {
			continue
		}
		allowed[u] = true
	}

	if len(req.RedirectURIs) == 0 {
		return fmt.Errorf("dcr: redirect_uris is required")
	}
	for _, uri := range req.RedirectURIs {
		uri = strings.TrimSpace(uri)
		if uri == "" {
			return fmt.Errorf("dcr: redirect_uris contains an empty value")
		}
		if len(allowed) > 0 && !allowed[uri] {
			return fmt.Errorf("dcr: redirect_uri not allowed: %s", uri)
		}
	}

	if policy.RequirePublicClient {
		method := strings.TrimSpace(req.TokenEndpointAuthMethod)
		if method == "" {
			method = "none"
		}
		if method != "none" {
			return fmt.Errorf("dcr: token_endpoint_auth_method must be none")
		}
	}

	grantTypes := normalizeStringList(req.GrantTypes)
	if len(grantTypes) > 0 {
		if !contains(grantTypes, "authorization_code") {
			return fmt.Errorf("dcr: grant_types must include authorization_code")
		}
		if policy.RequireRefreshToken && !contains(grantTypes, "refresh_token") {
			return fmt.Errorf("dcr: grant_types must include refresh_token")
		}
	}

	responseTypes := normalizeStringList(req.ResponseTypes)
	if len(responseTypes) > 0 && !contains(responseTypes, "code") {
		return fmt.Errorf("dcr: response_types must include code")
	}

	return nil
}

func normalizeStringList(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

func contains(sorted []string, v string) bool {
	i := sort.SearchStrings(sorted, v)
	return i >= 0 && i < len(sorted) && sorted[i] == v
}
