package oauth

import (
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
