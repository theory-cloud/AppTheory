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

	allowed := allowedRedirectURIs(policy.AllowedRedirectURIs)
	if err := validateRedirectURIs(req.RedirectURIs, allowed); err != nil {
		return err
	}
	if err := validateTokenEndpointAuthMethod(req.TokenEndpointAuthMethod, policy.RequirePublicClient); err != nil {
		return err
	}
	if err := validateGrantTypes(req.GrantTypes, policy.RequireRefreshToken); err != nil {
		return err
	}
	return validateResponseTypes(req.ResponseTypes)
}

func allowedRedirectURIs(in []string) map[string]bool {
	if len(in) == 0 {
		return nil
	}
	allowed := make(map[string]bool, len(in))
	for _, u := range in {
		u = strings.TrimSpace(u)
		if u == "" {
			continue
		}
		allowed[u] = true
	}
	if len(allowed) == 0 {
		return nil
	}
	return allowed
}

func validateRedirectURIs(redirectURIs []string, allowed map[string]bool) error {
	if len(redirectURIs) == 0 {
		return fmt.Errorf("dcr: redirect_uris is required")
	}
	for _, uri := range redirectURIs {
		uri = strings.TrimSpace(uri)
		if uri == "" {
			return fmt.Errorf("dcr: redirect_uris contains an empty value")
		}
		if len(allowed) > 0 && !allowed[uri] {
			return fmt.Errorf("dcr: redirect_uri not allowed: %s", uri)
		}
	}
	return nil
}

func validateTokenEndpointAuthMethod(method string, requirePublicClient bool) error {
	if !requirePublicClient {
		return nil
	}
	method = strings.TrimSpace(method)
	if method == "" {
		method = "none"
	}
	if method != "none" {
		return fmt.Errorf("dcr: token_endpoint_auth_method must be none")
	}
	return nil
}

func validateGrantTypes(grantTypes []string, requireRefreshToken bool) error {
	normalized := normalizeStringList(grantTypes)
	if len(normalized) == 0 {
		return nil
	}
	if !contains(normalized, "authorization_code") {
		return fmt.Errorf("dcr: grant_types must include authorization_code")
	}
	if requireRefreshToken && !contains(normalized, "refresh_token") {
		return fmt.Errorf("dcr: grant_types must include refresh_token")
	}
	return nil
}

func validateResponseTypes(responseTypes []string) error {
	normalized := normalizeStringList(responseTypes)
	if len(normalized) == 0 {
		return nil
	}
	if !contains(normalized, "code") {
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
