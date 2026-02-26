package oauth

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestProtectedResourceMetadata_EdgeCases(t *testing.T) {
	_, err := NewProtectedResourceMetadata("not-a-url", []string{"https://auth.example.com"})
	require.Error(t, err)

	_, err = NewProtectedResourceMetadata("https://mcp.example.com/mcp", []string{"not-a-url"})
	require.Error(t, err)

	_, err = NewProtectedResourceMetadata("https://mcp.example.com/mcp", []string{"  "})
	require.Error(t, err)

	md, err := NewProtectedResourceMetadata(" https://mcp.example.com/mcp ", []string{" https://auth.example.com "})
	require.NoError(t, err)
	require.Equal(t, "https://mcp.example.com/mcp", md.Resource)
	require.Equal(t, []string{"https://auth.example.com"}, md.AuthorizationServers)

	// Nil receiver marshals to JSON null.
	var nilMD *ProtectedResourceMetadata
	b, err := nilMD.MarshalJSONBytes()
	require.NoError(t, err)
	require.Equal(t, "null", string(b))

	// Escaping behavior for RFC9728 challenge.
	header := ProtectedResourceWWWAuthenticate(`https://mcp.example.com/\path\"quote`)
	require.Contains(t, header, `Bearer resource_metadata="`)
	require.Contains(t, header, `\\`)
	require.Contains(t, header, `\\\"`)

	got, ok := ResourceMetadataURLFromMcpEndpoint("https://api.example.com/mcp")
	require.True(t, ok)
	require.Equal(t, "https://api.example.com/.well-known/oauth-protected-resource", got)

	require.Equal(t, "https://x.example.com/mcp", CanonicalResourceURL(" https://x.example.com/mcp/ "))

	issuer, ok := CanonicalizeIssuerURL("https://issuer.example.com/a/b///")
	require.True(t, ok)
	require.Equal(t, "https://issuer.example.com/a/b", issuer)

	_, ok = CanonicalizeIssuerURL("not-a-url")
	require.False(t, ok)

	url1, ok := ProtectedResourceMetadataURLForRequest(map[string][]string{
		"host":              {"api.example.com"},
		"x-forwarded-proto": {"http"},
	})
	require.True(t, ok)
	require.Equal(t, "http://api.example.com/.well-known/oauth-protected-resource", url1)

	url2, ok := ProtectedResourceMetadataURLForRequest(map[string][]string{
		"host": {"api.example.com"},
	})
	require.True(t, ok)
	require.Equal(t, "https://api.example.com/.well-known/oauth-protected-resource", url2)

	_, ok = ProtectedResourceMetadataURLForRequest(map[string][]string{})
	require.False(t, ok)
}

func TestDCRValidation_EdgeCases(t *testing.T) {
	require.Error(t, ValidateDynamicClientRegistrationRequest(nil, ClaudeDynamicClientRegistrationPolicy()))

	// redirect_uris required
	require.Error(t, ValidateDynamicClientRegistrationRequest(&DynamicClientRegistrationRequest{}, ClaudeDynamicClientRegistrationPolicy()))

	// empty redirect_uris entry rejected
	require.Error(t, ValidateDynamicClientRegistrationRequest(&DynamicClientRegistrationRequest{
		RedirectURIs:            []string{" "},
		TokenEndpointAuthMethod: "none",
	}, ClaudeDynamicClientRegistrationPolicy()))

	// requirePublicClient=false should allow any method.
	require.NoError(t, ValidateDynamicClientRegistrationRequest(&DynamicClientRegistrationRequest{
		RedirectURIs:            []string{"https://claude.ai/api/mcp/auth_callback"},
		TokenEndpointAuthMethod: "client_secret_basic",
	}, DynamicClientRegistrationPolicy{AllowedRedirectURIs: ClaudeDynamicClientRegistrationPolicy().AllowedRedirectURIs}))

	// grant_types can be omitted; when provided must include authorization_code.
	require.Error(t, ValidateDynamicClientRegistrationRequest(&DynamicClientRegistrationRequest{
		RedirectURIs:            []string{"https://claude.ai/api/mcp/auth_callback"},
		TokenEndpointAuthMethod: "none",
		GrantTypes:              []string{"refresh_token"},
	}, ClaudeDynamicClientRegistrationPolicy()))

	// response_types, when provided, must include code.
	require.Error(t, ValidateDynamicClientRegistrationRequest(&DynamicClientRegistrationRequest{
		RedirectURIs:            []string{"https://claude.ai/api/mcp/auth_callback"},
		TokenEndpointAuthMethod: "none",
		ResponseTypes:           []string{"token"},
	}, ClaudeDynamicClientRegistrationPolicy()))
}

func TestTokenStores_EdgeCases(t *testing.T) {
	codeStore := NewMemoryAuthorizationCodeStore()
	require.Error(t, codeStore.Put(context.Background(), nil))
	require.Error(t, codeStore.Put(context.Background(), &AuthorizationCodeRecord{}))

	_, err := codeStore.Consume(context.Background(), " ")
	require.ErrorIs(t, err, ErrAuthorizationCodeNotFound)

	require.NoError(t, codeStore.Put(context.Background(), &AuthorizationCodeRecord{
		Code:      "expired-code",
		ClientID:  "client",
		ExpiresAt: time.Now().Add(-time.Minute).UTC(),
	}))
	_, err = codeStore.Consume(context.Background(), "expired-code")
	require.ErrorIs(t, err, ErrAuthorizationCodeExpired)

	refreshStore := NewMemoryRefreshTokenStore()
	require.Error(t, refreshStore.Put(context.Background(), nil))
	require.Error(t, refreshStore.Put(context.Background(), &RefreshTokenRecord{}))

	_, err = refreshStore.Get(context.Background(), " ")
	require.ErrorIs(t, err, ErrRefreshTokenNotFound)

	require.NoError(t, refreshStore.Put(context.Background(), &RefreshTokenRecord{
		Token:     "expired-rt",
		ClientID:  "client",
		ExpiresAt: time.Now().Add(-time.Minute).UTC(),
	}))
	_, err = refreshStore.Get(context.Background(), "expired-rt")
	require.ErrorIs(t, err, ErrRefreshTokenExpired)

	_, err = refreshStore.Consume(context.Background(), " ")
	require.ErrorIs(t, err, ErrRefreshTokenNotFound)

	_, err = refreshStore.Consume(context.Background(), "expired-rt")
	require.ErrorIs(t, err, ErrRefreshTokenExpired)

	// Delete should be a no-op on empty tokens.
	require.NoError(t, refreshStore.Delete(context.Background(), " "))

	// Delete should remove existing tokens.
	require.NoError(t, refreshStore.Put(context.Background(), &RefreshTokenRecord{
		Token:     "rt1",
		ClientID:  "client",
		ExpiresAt: time.Now().Add(time.Minute).UTC(),
	}))
	require.NoError(t, refreshStore.Delete(context.Background(), "rt1"))
	_, err = refreshStore.Get(context.Background(), "rt1")
	require.ErrorIs(t, err, ErrRefreshTokenNotFound)
}
