package mcpfacade

import (
	"testing"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
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

func TestInsufficientScopeRemediationCarriesTheRouteDerivedChallenge(t *testing.T) {
	t.Parallel()
	env := testkit.New()
	app := env.App()
	handler := NewHandler()
	const resourceMetadataURL = "https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp"

	// The required scope set is route-derived: it follows the endpoint kind the
	// request's path resolves to, not a process-global value.
	scopesByKind := map[mcproutes.EndpointKind][]string{
		mcproutes.EndpointKindNamespace:        {"namespace:use"},
		mcproutes.EndpointKindPartnerNamespace: {"partner_namespace:use"},
		mcproutes.EndpointKindAgent:            {"agent:use"},
		mcproutes.EndpointKindPartnerAgent:     {"partner_agent:use"},
	}
	routeScopes := func(c *apptheory.Context) ([]string, error) {
		endpoint, err := mcproutes.ParseMCPPath(c.Request.Path)
		if err != nil {
			return nil, err
		}
		return scopesByKind[endpoint.Kind], nil
	}

	_, err := runtimemcpfacade.RegisterMCPFacade(app, runtimemcpfacade.FacadeConfig{
		IssuerURL:        "https://issuer.example.com/",
		JWKSURI:          "https://issuer.example.com/jwks.json",
		URLMode:          runtimemcpfacade.URLModePublicBaseURL,
		PublicBaseURL:    "https://mcp.example.com/",
		Scopes:           scopesByKind,
		MCPHandler:       handler.Handle,
		TransportPosture: runtimemcpfacade.TransportPostureRuntimeBearer,
		RequireBearerToken: &oauth.RequireBearerTokenOptions{
			ResourceMetadataURL: resourceMetadataURL,
			RequiredScopesFunc:  routeScopes,
			ClaimsValidator: oauth.NewMemoryBearerTokenValidator(
				[]oauth.BearerTokenRecord{
					{Token: "scope-less-token", Subject: "acme", Scope: "agent:use"},
					{Token: "scoped-token", Subject: "acme", Scope: "namespace:use"},
				},
				oauth.BearerTokenValidationOptions{RequiredScopesFunc: routeScopes},
			),
		},
	})
	require.NoError(t, err)

	AssertInsufficientScopeRemediation(t, env, app, "POST", "/acme/mcp", "scope-less-token",
		`Bearer error="insufficient_scope", scope="namespace:use", resource_metadata="`+resourceMetadataURL+`"`,
		handler)
	require.Zero(t, handler.Invocations())

	// Positive control: a token carrying the route's scope reaches the handler,
	// so the 403 above is a scope decision rather than a blanket denial.
	AssertBearerTokenReachesHandler(t, env, app, "POST", "/acme/mcp", "scoped-token", handler)
	require.Equal(t, 1, handler.Invocations())
}
