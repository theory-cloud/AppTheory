package oauth

import (
	"encoding/json"
	"fmt"
	"path"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

// AuthorizationServerMetadata is the RFC8414 Authorization Server metadata document.
type AuthorizationServerMetadata struct {
	Issuer                            string   `json:"issuer"`
	AuthorizationEndpoint             string   `json:"authorization_endpoint,omitempty"`
	TokenEndpoint                     string   `json:"token_endpoint,omitempty"`
	RegistrationEndpoint              string   `json:"registration_endpoint,omitempty"`
	JWKSURI                           string   `json:"jwks_uri,omitempty"`
	ResponseTypesSupported            []string `json:"response_types_supported,omitempty"`
	GrantTypesSupported               []string `json:"grant_types_supported,omitempty"`
	TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported,omitempty"`
	CodeChallengeMethodsSupported     []string `json:"code_challenge_methods_supported,omitempty"`
	ScopesSupported                   []string `json:"scopes_supported,omitempty"`
	SubjectTypesSupported             []string `json:"subject_types_supported,omitempty"`
	IDTokenSigningAlgValuesSupported  []string `json:"id_token_signing_alg_values_supported,omitempty"`
}

// NewAuthorizationServerMetadata builds a Claude-compatible RFC8414 document
// with conventional root endpoints (/authorize, /token, /register) derived from
// the issuer/base URL.
func NewAuthorizationServerMetadata(issuer string) (*AuthorizationServerMetadata, error) {
	u, ok := parseAbsoluteURL(issuer)
	if !ok {
		return nil, fmt.Errorf("%w: issuer must be an absolute URL", ErrInvalidURL)
	}

	canon := *u
	canon.Path = strings.TrimRight(canon.Path, "/")
	issuer = canon.String()

	join := func(p string) string {
		out := canon
		out.Path = path.Join(strings.TrimSuffix(out.Path, "/"), strings.TrimPrefix(p, "/"))
		out.RawQuery = ""
		out.Fragment = ""
		return out.String()
	}

	return &AuthorizationServerMetadata{
		Issuer:                            issuer,
		AuthorizationEndpoint:             join("/authorize"),
		TokenEndpoint:                     join("/token"),
		RegistrationEndpoint:              join("/register"),
		JWKSURI:                           join("/.well-known/jwks.json"),
		ResponseTypesSupported:            []string{"code"},
		GrantTypesSupported:               []string{"authorization_code", "refresh_token"},
		TokenEndpointAuthMethodsSupported: []string{"none"},
		CodeChallengeMethodsSupported:     []string{"S256"},
	}, nil
}

// MarshalJSONBytes marshals the metadata document to JSON bytes.
func (m *AuthorizationServerMetadata) MarshalJSONBytes() ([]byte, error) {
	if m == nil {
		return []byte("null"), nil
	}
	return json.Marshal(m)
}

// AuthorizationServerMetadataHandler returns an AppTheory handler that serves the
// RFC8414 authorization server metadata document.
func AuthorizationServerMetadataHandler(md *AuthorizationServerMetadata) apptheory.Handler {
	return jsonBytesHandler(md.MarshalJSONBytes)
}
