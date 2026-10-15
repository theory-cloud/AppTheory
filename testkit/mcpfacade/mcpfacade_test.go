package mcpfacade

import (
	"context"
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

// TestSecureAppConformanceKitDeniesAndAdmitsOnEitherSurface pins the SecureApp
// variants of the conformance kit against the same three transport outcomes the
// plain-App test asserts, and additionally proves that mounting the facade on a
// SecureApp leaves the application's own principal gate in force for every route
// the facade does not own. Without that second half the helpers would only show
// that the facade's bearer validator works, not that the closed-by-default
// surface survived the mount.
func TestSecureAppConformanceKitDeniesAndAdmitsOnEitherSurface(t *testing.T) {
	t.Parallel()
	env := testkit.New()
	handler := NewHandler()
	const resourceMetadataURL = "https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp"

	var resolverCalls int
	secure := apptheory.NewSecure(apptheory.SecureOptions{
		Clock: env.Clock,
		PrincipalResolver: func(ctx *apptheory.Context) (*apptheory.SecurePrincipal, error) {
			resolverCalls++
			if session := ctx.Request.Headers["x-session"]; len(session) == 0 || session[0] != "valid" {
				return nil, nil
			}
			return &apptheory.SecurePrincipal{Identity: "acme-operator", Scopes: []string{"acme:read"}}, nil
		},
	})
	secure.Get("/internal/audit", func(*apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(200, map[string]string{"ok": "true"})
	}, apptheory.Authenticated())

	_, err := runtimemcpfacade.RegisterMCPFacadeSecure(secure, runtimemcpfacade.FacadeConfig{
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
			RequiredScopesFunc: func(*apptheory.Context) ([]string, error) {
				return []string{"namespace:use"}, nil
			},
			ClaimsValidator: oauth.NewMemoryBearerTokenValidator(
				[]oauth.BearerTokenRecord{
					{Token: "valid-token", Subject: "acme", Audience: "https://mcp.example.com", Scope: "namespace:use"},
					{Token: "scope-less-token", Subject: "acme", Audience: "https://mcp.example.com", Scope: "agent:use"},
				},
				oauth.BearerTokenValidationOptions{
					RequiredScopesFunc: func(*apptheory.Context) ([]string, error) {
						return []string{"namespace:use"}, nil
					},
				},
			),
		},
	})
	require.NoError(t, err)

	AssertCredentialFreeDeniedSecureApp(t, env, secure, "POST", "/acme/mcp", resourceMetadataURL, handler)
	require.Zero(t, handler.Invocations(), "a denied transport request must not reach the MCP handler")
	AssertBearerTokenReachesHandlerSecureApp(t, env, secure, "POST", "/acme/mcp", "valid-token", handler)
	require.Equal(t, 1, handler.Invocations())
	AssertInsufficientScopeRemediationSecureApp(t, env, secure, "POST", "/acme/mcp", "scope-less-token",
		`Bearer error="insufficient_scope", scope="namespace:use", resource_metadata="`+resourceMetadataURL+`"`,
		handler)
	require.Equal(t, 1, handler.Invocations(), "a scope denial must not reach the MCP handler")

	// The facade's own transport route never consults the app resolver: its
	// authority is the RFC 9728 bearer validator, so the three calls above add
	// no resolver traffic.
	require.Zero(t, resolverCalls, "the facade transport route must not consult the SecureApp resolver")

	// The application's non-facade route still demands its own principal, and the
	// denial is the app's, not the facade's: no RFC 9728 challenge is attached.
	response := secure.Serve(context.Background(), apptheory.Request{Method: "GET", Path: "/internal/audit"})
	require.Equal(t, 401, response.Status)
	require.Empty(t, response.Headers["www-authenticate"])
	require.Equal(t, 1, resolverCalls, "the non-facade route must consult the app resolver")

	response = secure.Serve(context.Background(), apptheory.Request{
		Method:  "GET",
		Path:    "/internal/audit",
		Headers: map[string][]string{"x-session": {"valid"}},
	})
	require.Equal(t, 200, response.Status)
	require.Equal(t, 2, resolverCalls)
}
