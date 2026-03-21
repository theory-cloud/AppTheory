package oauth

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestProtectedResourceWWWAuthenticate(t *testing.T) {
	header := ProtectedResourceWWWAuthenticate("https://mcp.example.com/.well-known/oauth-protected-resource")
	require.Equal(t, `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"`, header)
}

func TestResourceMetadataURLFromMcpEndpoint(t *testing.T) {
	got, ok := ResourceMetadataURLFromMcpEndpoint("https://api.example.com/prod/mcp")
	require.True(t, ok)
	require.Equal(t, "https://api.example.com/.well-known/oauth-protected-resource/prod/mcp", got)
}

func TestResourceMetadataURLFromMcpEndpoint_AcceptsAnyAbsoluteURL(t *testing.T) {
	got, ok := ResourceMetadataURLFromMcpEndpoint("https://api.example.com/prod/not-mcp")
	require.True(t, ok)
	require.Equal(t, "https://api.example.com/.well-known/oauth-protected-resource/prod/not-mcp", got)
}

func TestRFC9728ResourceMetadataURL_PreservesQuery(t *testing.T) {
	got, ok := RFC9728ResourceMetadataURL("https://api.example.com/mcp/Arch?aud=claude")
	require.True(t, ok)
	require.Equal(t, "https://api.example.com/.well-known/oauth-protected-resource/mcp/Arch?aud=claude", got)
}

func TestRFC9728ResourceMetadataURL_Invalid(t *testing.T) {
	_, ok := RFC9728ResourceMetadataURL("/mcp")
	require.False(t, ok)
}

func TestNewProtectedResourceMetadata(t *testing.T) {
	md, err := NewProtectedResourceMetadata(
		"https://mcp.example.com/mcp",
		[]string{"https://auth.example.com"},
	)
	require.NoError(t, err)
	require.Equal(t, "https://mcp.example.com/mcp", md.Resource)
	require.Equal(t, []string{"https://auth.example.com"}, md.AuthorizationServers)
}
