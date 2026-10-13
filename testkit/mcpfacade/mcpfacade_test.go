package mcpfacade

import (
	"testing"

	"github.com/stretchr/testify/require"

	runtimemcpfacade "github.com/theory-cloud/apptheory/v6/runtime/mcpfacade"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	"github.com/theory-cloud/apptheory/v6/testkit"
)

func TestCredentialFreeTransportRequestIsDeniedAndTokenReachesTheHandler(t *testing.T) {
	t.Parallel()
	env := testkit.New()
	app := env.App()
	handler := NewHandler()
	const resourceMetadataURL = "https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp"

	_, err := runtimemcpfacade.RegisterMCPFacade(app, runtimemcpfacade.FacadeConfig{
		IssuerURL:     "https://issuer.example.com/",
		JWKSURI:       "https://issuer.example.com/jwks.json",
		URLMode:       runtimemcpfacade.URLModePublicBaseURL,
		PublicBaseURL: "https://mcp.example.com/",
		Scopes: map[mcproutes.EndpointKind][]string{
			mcproutes.EndpointKindNamespace:        {"namespace:use"},
			mcproutes.EndpointKindPartnerNamespace: {"partner_namespace:use"},
			mcproutes.EndpointKindAgent:            {"agent:use"},
			mcproutes.EndpointKindPartnerAgent:     {"partner_agent:use"},
		},
		MCPHandler:       handler.Handle,
		TransportPosture: runtimemcpfacade.TransportPostureRuntimeBearer,
		RequireBearerToken: &oauth.RequireBearerTokenOptions{
			ResourceMetadataURL: resourceMetadataURL,
			ClaimsValidator: oauth.NewMemoryBearerTokenValidator(
				[]oauth.BearerTokenRecord{{Token: "valid-token", Subject: "acme", Audience: "https://mcp.example.com"}},
				oauth.BearerTokenValidationOptions{},
			),
		},
	})
	require.NoError(t, err)

	AssertCredentialFreeDenied(t, env, app, "POST", "/acme/mcp", resourceMetadataURL, handler)
	require.Zero(t, handler.Invocations())
	AssertBearerTokenReachesHandler(t, env, app, "POST", "/acme/mcp", "valid-token", handler)
	require.Equal(t, 1, handler.Invocations())
}
