package oauth

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v3/runtime"
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

func TestMCPServerPathConstants(t *testing.T) {
	require.Equal(t, "/mcp", MCPPath)
	require.Equal(t, "/.well-known/oauth-protected-resource", OAuthProtectedResourcePath)
	require.Equal(t, "/.well-known/oauth-protected-resource/mcp", OAuthProtectedResourceMCPPath)
	require.Equal(t, "/.well-known/oauth-authorization-server/mcp", OAuthAuthorizationServerMCPPath)
}

func TestMCPProtectedResourceDiscoveryHandlerDerivesRequestResource(t *testing.T) {
	handler, err := NewMCPProtectedResourceDiscoveryHandler(MCPServerConfig{
		AuthorizationServerIssuer: "https://auth.example.com/",
		JWKSURI:                   "https://auth.example.com/.well-known/jwks.json?set=active",
	})
	require.NoError(t, err)

	tests := []struct {
		name     string
		headers  map[string][]string
		resource string
	}{
		{
			name:     "request host defaults to https",
			headers:  map[string][]string{"host": {"family-heart.theorycloud.app"}},
			resource: "https://family-heart.theorycloud.app/mcp",
		},
		{
			name: "viewer host wins and comma suffix is removed",
			headers: map[string][]string{
				"x-apptheory-original-host": {"keeper.example.com, internal.example.com"},
				"x-forwarded-proto":         {"https"},
			},
			resource: "https://keeper.example.com/mcp",
		},
		{
			name: "loopback http with port",
			headers: map[string][]string{
				"host":              {"127.0.0.1:8080"},
				"x-forwarded-proto": {"http"},
			},
			resource: "http://127.0.0.1:8080/mcp",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, handlerErr := handler(&apptheory.Context{Request: apptheory.Request{Headers: tt.headers}})
			require.NoError(t, handlerErr)
			require.Equal(t, http.StatusOK, resp.Status)
			require.Equal(t, []string{"application/json"}, resp.Headers["content-type"])

			var got ProtectedResourceMetadata
			require.NoError(t, json.Unmarshal(resp.Body, &got))
			require.Equal(t, tt.resource, got.Resource)
			require.Equal(t, []string{"https://auth.example.com"}, got.AuthorizationServers)

			var document map[string]any
			require.NoError(t, json.Unmarshal(resp.Body, &document))
			require.Len(t, document, 2)
			require.NotContains(t, document, "jwks_uri")
		})
	}
}

func TestMCPProtectedResourceDiscoveryHandlerRejectsUnsafeRequestOrigins(t *testing.T) {
	handler, err := NewMCPProtectedResourceDiscoveryHandler(MCPServerConfig{
		AuthorizationServerIssuer: "https://auth.example.com",
		JWKSURI:                   "https://auth.example.com/.well-known/jwks.json",
	})
	require.NoError(t, err)

	tests := []map[string][]string{
		{},
		{"host": {"public.example.com"}, "x-forwarded-proto": {"http"}},
		{"host": {"user:password@public.example.com"}},
		{"host": {"public.example.com/path"}},
	}
	for _, headers := range tests {
		resp, handlerErr := handler(&apptheory.Context{Request: apptheory.Request{Headers: headers}})
		require.NoError(t, handlerErr)
		require.Equal(t, http.StatusBadRequest, resp.Status)
		require.Equal(t, []string{"application/json"}, resp.Headers["content-type"])
	}
}

func TestRegisterMCPServerUsesSecurePostures(t *testing.T) {
	app := apptheory.NewSecure(apptheory.SecureOptions{})
	err := RegisterMCPServer(app, func(*apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(http.StatusOK, map[string]string{"ok": "true"})
	}, MCPServerConfig{
		AuthorizationServerIssuer: "https://auth.example.com",
		JWKSURI:                   "https://auth.example.com/.well-known/jwks.json",
	})
	require.NoError(t, err)

	routes := app.Routes()
	require.Len(t, routes, 3)
	require.Equal(t, apptheory.AuthPostureAuthenticated, routes[0].Posture)
	require.Equal(t, "POST", routes[0].Method)
	require.Equal(t, MCPPath, routes[0].Path)
	for _, route := range routes[1:] {
		require.Equal(t, apptheory.AuthPosturePublic, route.Posture)
		require.Equal(t, "GET", route.Method)
	}
	require.Equal(t, OAuthProtectedResourcePath, routes[1].Path)
	require.Equal(t, OAuthProtectedResourceMCPPath, routes[2].Path)

	discovery := app.Serve(context.Background(), apptheory.Request{
		Method: "GET",
		Path:   OAuthProtectedResourceMCPPath,
		Headers: map[string][]string{
			"host": {"keeper.example.com"},
		},
	})
	require.Equal(t, http.StatusOK, discovery.Status)

	mcp := app.Serve(context.Background(), apptheory.Request{Method: "POST", Path: MCPPath})
	require.Equal(t, http.StatusUnauthorized, mcp.Status)
}

func TestRegisterMCPServerHonorsMCPPathOverride(t *testing.T) {
	app := apptheory.NewSecure(apptheory.SecureOptions{})
	err := RegisterMCPServer(app, func(*apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(http.StatusOK, nil)
	}, MCPServerConfig{
		MCPPath:                   "/services/tools",
		AuthorizationServerIssuer: "https://auth.example.com",
		JWKSURI:                   "https://auth.example.com/jwks.json",
	})
	require.NoError(t, err)

	routes := app.Routes()
	require.Equal(t, "/services/tools", routes[0].Path)
	require.Equal(t, OAuthProtectedResourcePath+"/services/tools", routes[2].Path)
}

func TestMCPServerConfigFailsClosed(t *testing.T) {
	handler := func(*apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(http.StatusOK, nil)
	}

	tests := []MCPServerConfig{
		{JWKSURI: "https://auth.example.com/jwks.json"},
		{AuthorizationServerIssuer: "https://auth.example.com"},
		{AuthorizationServerIssuer: "not-absolute", JWKSURI: "https://auth.example.com/jwks.json"},
		{AuthorizationServerIssuer: "http://evil.example.com", JWKSURI: "https://auth.example.com/jwks.json"},
		{AuthorizationServerIssuer: "http://localhost", JWKSURI: "https://auth.example.com/jwks.json"},
		{AuthorizationServerIssuer: "https://auth.example.com?x=1", JWKSURI: "https://auth.example.com/jwks.json"},
		{AuthorizationServerIssuer: "https://auth.example.com#fragment", JWKSURI: "https://auth.example.com/jwks.json"},
		{AuthorizationServerIssuer: "https://auth.example.com", JWKSURI: "/jwks.json"},
		{MCPPath: "https://resource.example.com/mcp", AuthorizationServerIssuer: "https://auth.example.com", JWKSURI: "https://auth.example.com/jwks.json"},
		{MCPPath: "/mcp/../admin", AuthorizationServerIssuer: "https://auth.example.com", JWKSURI: "https://auth.example.com/jwks.json"},
		{MCPPath: "/.", AuthorizationServerIssuer: "https://auth.example.com", JWKSURI: "https://auth.example.com/jwks.json"},
		{MCPPath: "/..", AuthorizationServerIssuer: "https://auth.example.com", JWKSURI: "https://auth.example.com/jwks.json"},
		{MCPPath: "/mcp/./x", AuthorizationServerIssuer: "https://auth.example.com", JWKSURI: "https://auth.example.com/jwks.json"},
		{MCPPath: "/my mcp", AuthorizationServerIssuer: "https://auth.example.com", JWKSURI: "https://auth.example.com/jwks.json"},
	}
	for _, cfg := range tests {
		require.Error(t, RegisterMCPServer(apptheory.NewSecure(apptheory.SecureOptions{}), handler, cfg))
	}
}
