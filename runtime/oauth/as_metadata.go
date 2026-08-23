package oauth

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/v4/runtime"
)

// AuthorizationServerMetadata is the RFC8414 Authorization Server metadata document.
type AuthorizationServerMetadata struct {
	Issuer                            string   `json:"issuer"`
	AuthorizationEndpoint             string   `json:"authorization_endpoint,omitempty"`
	TokenEndpoint                     string   `json:"token_endpoint,omitempty"`
	RegistrationEndpoint              string   `json:"registration_endpoint,omitempty"`
	JWKSURI                           string   `json:"jwks_uri,omitempty"`
	RevocationEndpoint                string   `json:"revocation_endpoint,omitempty"`
	DeviceAuthorizationEndpoint       string   `json:"device_authorization_endpoint,omitempty"`
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
// the issuer/base URL. Additional RFC 8414 members such as revocation_endpoint
// and device_authorization_endpoint are opt-in via AuthorizationServerMetadataOption:
// the framework implements no revocation or device-flow endpoints, so the
// default document advertises only what it serves.
func NewAuthorizationServerMetadata(issuer string, opts ...AuthorizationServerMetadataOption) (*AuthorizationServerMetadata, error) {
	u, ok := parseAbsoluteURL(issuer)
	if !ok {
		return nil, fmt.Errorf("%w: issuer must be an absolute URL", ErrInvalidURL)
	}

	canon := *u
	canon.Path = strings.TrimRight(canon.Path, "/")
	issuer = canon.String()

	md := &AuthorizationServerMetadata{
		Issuer:                            issuer,
		AuthorizationEndpoint:             joinPath(&canon, "/authorize"),
		TokenEndpoint:                     joinPath(&canon, "/token"),
		RegistrationEndpoint:              joinPath(&canon, "/register"),
		JWKSURI:                           joinPath(&canon, "/.well-known/jwks.json"),
		ResponseTypesSupported:            []string{"code"},
		GrantTypesSupported:               []string{"authorization_code", "refresh_token"},
		TokenEndpointAuthMethodsSupported: []string{"none"},
		CodeChallengeMethodsSupported:     []string{"S256"},
	}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		if err := opt(md, &canon); err != nil {
			return nil, err
		}
	}
	return md, nil
}

// AuthorizationServerMetadataOption configures the RFC 8414 authorization
// server metadata document built by NewAuthorizationServerMetadata. Options run
// in order after the conventional fields are derived from the issuer base URL;
// base is the canonical issuer URL.
type AuthorizationServerMetadataOption func(*AuthorizationServerMetadata, *url.URL) error

// WithRevocationEndpoint adds the RFC 8414 revocation_endpoint to the metadata
// document. With no argument it derives the conventional /revoke path from the
// issuer base URL; pass exactly one explicit absolute URL to point at a
// non-conventional path. Passing more than one explicit URL is rejected with
// ErrInvalidURL. The framework implements no revocation endpoint, so this
// option is opt-in: the default document does not advertise one.
func WithRevocationEndpoint(explicit ...string) AuthorizationServerMetadataOption {
	return func(md *AuthorizationServerMetadata, base *url.URL) error {
		if len(explicit) > 1 {
			return fmt.Errorf("%w: revocation endpoint accepts at most one explicit URL", ErrInvalidURL)
		}
		if len(explicit) == 1 {
			u, ok := parseAbsoluteURL(explicit[0])
			if !ok {
				return fmt.Errorf("%w: revocation endpoint must be an absolute URL", ErrInvalidURL)
			}
			md.RevocationEndpoint = u.String()
			return nil
		}
		md.RevocationEndpoint = joinPath(base, "/revoke")
		return nil
	}
}

// WithDeviceAuthorizationEndpoint adds the RFC 8628 device_authorization_endpoint
// to the metadata document. With no argument it derives the conventional
// /device path from the issuer base URL; pass exactly one explicit absolute URL
// to point at a non-conventional path. Passing more than one explicit URL is
// rejected with ErrInvalidURL. The framework implements no device-flow endpoint,
// so this option is opt-in: the default document does not advertise one.
func WithDeviceAuthorizationEndpoint(explicit ...string) AuthorizationServerMetadataOption {
	return func(md *AuthorizationServerMetadata, base *url.URL) error {
		if len(explicit) > 1 {
			return fmt.Errorf("%w: device authorization endpoint accepts at most one explicit URL", ErrInvalidURL)
		}
		if len(explicit) == 1 {
			u, ok := parseAbsoluteURL(explicit[0])
			if !ok {
				return fmt.Errorf("%w: device authorization endpoint must be an absolute URL", ErrInvalidURL)
			}
			md.DeviceAuthorizationEndpoint = u.String()
			return nil
		}
		md.DeviceAuthorizationEndpoint = joinPath(base, "/device")
		return nil
	}
}

// joinPath joins p onto base's path, preserving scheme and host and dropping
// any query or fragment, producing the conventional endpoint URL for the
// authorization server.
func joinPath(base *url.URL, p string) string {
	out := *base
	out.Path = path.Join(strings.TrimSuffix(out.Path, "/"), strings.TrimPrefix(p, "/"))
	out.RawQuery = ""
	out.Fragment = ""
	return out.String()
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
