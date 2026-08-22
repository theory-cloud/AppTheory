package oauth

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNewAuthorizationServerMetadata(t *testing.T) {
	md, err := NewAuthorizationServerMetadata("https://auth.example.com")
	require.NoError(t, err)
	require.Equal(t, "https://auth.example.com", md.Issuer)
	require.Equal(t, "https://auth.example.com/authorize", md.AuthorizationEndpoint)
	require.Equal(t, "https://auth.example.com/token", md.TokenEndpoint)
	require.Equal(t, "https://auth.example.com/register", md.RegistrationEndpoint)
	require.Equal(t, "https://auth.example.com/.well-known/jwks.json", md.JWKSURI)
	require.Equal(t, []string{"code"}, md.ResponseTypesSupported)
	require.Equal(t, []string{"authorization_code", "refresh_token"}, md.GrantTypesSupported)
	require.Equal(t, []string{"none"}, md.TokenEndpointAuthMethodsSupported)
}

func TestAuthorizationServerMetadataJSONEndpointFields(t *testing.T) {
	md, err := NewAuthorizationServerMetadata("https://auth.example.com")
	require.NoError(t, err)

	// The default document must stay byte-identical to the pre-948 wire shape:
	// revocation_endpoint and device_authorization_endpoint are unset and
	// omitted by omitempty.
	b, err := json.Marshal(md)
	require.NoError(t, err)
	require.JSONEq(t, `{
		"issuer": "https://auth.example.com",
		"authorization_endpoint": "https://auth.example.com/authorize",
		"token_endpoint": "https://auth.example.com/token",
		"registration_endpoint": "https://auth.example.com/register",
		"jwks_uri": "https://auth.example.com/.well-known/jwks.json",
		"response_types_supported": ["code"],
		"grant_types_supported": ["authorization_code", "refresh_token"],
		"token_endpoint_auth_methods_supported": ["none"],
		"code_challenge_methods_supported": ["S256"]
	}`, string(b))

	// Set fields appear in the JSON document.
	md.RevocationEndpoint = "https://auth.example.com/revoke"
	md.DeviceAuthorizationEndpoint = "https://auth.example.com/device"
	b, err = json.Marshal(md)
	require.NoError(t, err)
	require.JSONEq(t, `{
		"issuer": "https://auth.example.com",
		"authorization_endpoint": "https://auth.example.com/authorize",
		"token_endpoint": "https://auth.example.com/token",
		"registration_endpoint": "https://auth.example.com/register",
		"jwks_uri": "https://auth.example.com/.well-known/jwks.json",
		"revocation_endpoint": "https://auth.example.com/revoke",
		"device_authorization_endpoint": "https://auth.example.com/device",
		"response_types_supported": ["code"],
		"grant_types_supported": ["authorization_code", "refresh_token"],
		"token_endpoint_auth_methods_supported": ["none"],
		"code_challenge_methods_supported": ["S256"]
	}`, string(b))
}

func TestAuthorizationServerMetadataEndpointOptions(t *testing.T) {
	// Opt-in derivation joins the conventional /revoke and /device paths onto
	// the issuer base URL, including base-path handling.
	md, err := NewAuthorizationServerMetadata(
		"https://auth.example.com/base/path",
		WithRevocationEndpoint(),
		WithDeviceAuthorizationEndpoint(),
	)
	require.NoError(t, err)
	require.Equal(t, "https://auth.example.com/base/path/revoke", md.RevocationEndpoint)
	require.Equal(t, "https://auth.example.com/base/path/device", md.DeviceAuthorizationEndpoint)

	// Explicit absolute URLs are honored verbatim.
	md, err = NewAuthorizationServerMetadata(
		"https://auth.example.com",
		WithRevocationEndpoint("https://auth.example.com/oauth/revoke"),
		WithDeviceAuthorizationEndpoint("https://device.example.com/device_authorization"),
	)
	require.NoError(t, err)
	require.Equal(t, "https://auth.example.com/oauth/revoke", md.RevocationEndpoint)
	require.Equal(t, "https://device.example.com/device_authorization", md.DeviceAuthorizationEndpoint)

	// Non-absolute explicit URLs are rejected.
	_, err = NewAuthorizationServerMetadata("https://auth.example.com", WithRevocationEndpoint("not a url"))
	require.ErrorIs(t, err, ErrInvalidURL)
	_, err = NewAuthorizationServerMetadata("https://auth.example.com", WithDeviceAuthorizationEndpoint("/device"))
	require.ErrorIs(t, err, ErrInvalidURL)
}

func TestAuthorizationServerMetadataHandlerRoundTrip(t *testing.T) {
	md, err := NewAuthorizationServerMetadata(
		"https://auth.example.com/base",
		WithRevocationEndpoint(),
		WithDeviceAuthorizationEndpoint("https://auth.example.com/oauth/device_authorization"),
	)
	require.NoError(t, err)

	resp, err := AuthorizationServerMetadataHandler(md)(nil)
	require.NoError(t, err)
	require.Equal(t, 200, resp.Status)

	var decoded AuthorizationServerMetadata
	require.NoError(t, json.Unmarshal(resp.Body, &decoded))
	require.Equal(t, *md, decoded)
}
