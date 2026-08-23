package mcpfacade

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v4/runtime"
	"github.com/theory-cloud/apptheory/v4/runtime/mcproutes"
)

var testEndpoints = []mcproutes.EndpointPath{
	{Kind: mcproutes.EndpointKindNamespace, ClientNamespace: "acme"},
	{Kind: mcproutes.EndpointKindPartnerNamespace, ClientNamespace: "acme", PartnerID: "reseller"},
	{Kind: mcproutes.EndpointKindAgent, ClientNamespace: "acme", AgentID: "helper"},
	{Kind: mcproutes.EndpointKindPartnerAgent, ClientNamespace: "acme", PartnerID: "reseller", AgentID: "helper"},
}

const documentExpectationsPath = "../../contract-tests/fixtures/routing/mcp-route-algebra/expectations.json"
const routeInventoryExpectationsPath = "../../contract-tests/fixtures/routing/mcp-route-algebra/facade-route-inventory.json"

type routeInventoryFixture struct {
	ContractVersion                 string         `json:"contract_version"`
	Routes                          []routeFixture `json:"routes"`
	RootAuthorizationServerPattern  string         `json:"root_authorization_server_pattern"`
	RootAuthorizationServerAttached bool           `json:"root_authorization_server_attached"`
}

type routeFixture struct {
	Kind                        mcproutes.EndpointKind `json:"kind"`
	MCPPattern                  string                 `json:"mcp_pattern"`
	MCPMethods                  []string               `json:"mcp_methods"`
	ProtectedResourcePattern    string                 `json:"protected_resource_pattern"`
	DiscoveryCanonicalPattern   string                 `json:"discovery_canonical_pattern"`
	DiscoverySuffixPattern      string                 `json:"discovery_suffix_pattern"`
	AuthorizePattern            string                 `json:"authorize_pattern"`
	TokenPattern                string                 `json:"token_pattern"`
	AuthorizationRoutesAttached bool                   `json:"authorization_routes_attached"`
}

type documentFixture struct {
	Name                          string                 `json:"name"`
	Mode                          URLMode                `json:"mode"`
	Kind                          mcproutes.EndpointKind `json:"kind"`
	ProtectedResourcePath         string                 `json:"protected_resource_path"`
	AuthorizationServerPath       string                 `json:"authorization_server_path"`
	AuthorizationServerSuffixPath string                 `json:"authorization_server_suffix_path"`
	ProtectedResourceDocument     string                 `json:"protected_resource_document"`
	AuthorizationServerDocument   string                 `json:"authorization_server_document"`
}

type documentFixtureFile struct {
	Documents []documentFixture `json:"documents"`
}

func TestRegisterMCPFacadeRegistersCompleteContractSurface(t *testing.T) {
	t.Parallel()
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	config := validConfig(URLModePublicBaseURL)
	config.AuthorizeHandler = kindHandlerFactory("authorize")
	config.TokenHandler = kindHandlerFactory("token")

	inventory, err := RegisterMCPFacade(app, config)
	require.NoError(t, err)
	require.Equal(t, mcproutes.ContractVersion, inventory.ContractVersion)
	require.Len(t, inventory.Routes, 4)

	endpoints := mcproutes.SupportedEndpointTemplates()
	facades := mcproutes.SupportedOAuthFacadeTemplates()
	discovery := mcproutes.SupportedOAuthDiscoveryTemplates()
	for index, route := range inventory.Routes {
		require.Equal(t, endpoints[index].Kind, route.Kind)
		require.Equal(t, endpoints[index].MCPPattern, route.MCPPattern)
		require.Equal(t, []string{"POST", "GET", "DELETE"}, route.MCPMethods)
		require.Equal(t, endpoints[index].ProtectedResourcePath, route.ProtectedResourcePattern)
		require.Equal(t, discovery[index].CanonicalPattern, route.DiscoveryCanonicalPattern)
		require.Equal(t, discovery[index].SuffixPattern, route.DiscoverySuffixPattern)
		require.Equal(t, facades[index].AuthorizePattern, route.AuthorizePattern)
		require.Equal(t, facades[index].TokenPattern, route.TokenPattern)
		require.True(t, route.AuthorizationRoutesAttached)
	}

	// Literal spots keep this test independent of an accidentally reduced algebra enumeration.
	require.Equal(t, "/{client_namespace}/mcp", inventory.Routes[0].MCPPattern)
	require.Equal(t, "/.well-known/oauth-protected-resource/{client_namespace}/partners/{partner_id}/mcp", inventory.Routes[1].ProtectedResourcePattern)
	require.Equal(t, "/{client_namespace}/agents/{agent_id}/mcp/.well-known/oauth-authorization-server", inventory.Routes[2].DiscoverySuffixPattern)
	require.Equal(t, "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp/token", inventory.Routes[3].TokenPattern)

	for _, endpoint := range testEndpoints {
		mcpPath := mustPath(t, endpoint.MCPPath)
		for _, method := range []string{"POST", "GET", "DELETE"} {
			response := serve(app, method, mcpPath, nil)
			require.Equalf(t, 204, response.Status, "%s %s: %s", method, mcpPath, response.Body)
		}

		protectedPath := mustPath(t, endpoint.ProtectedResourcePath)
		require.Equal(t, 200, serve(app, "GET", protectedPath, nil).Status)
		canonicalPath := mustPath(t, endpoint.OAuthAuthorizationServerPath)
		require.Equal(t, 200, serve(app, "GET", canonicalPath, nil).Status)
		suffixPath := mustPath(t, endpoint.OAuthAuthorizationServerSuffixPath)
		require.Equal(t, 200, serve(app, "GET", suffixPath, nil).Status)

		authorizePath := mustPath(t, endpoint.OAuthAuthorizePath)
		authorizeResponse := serve(app, "GET", authorizePath, nil)
		require.Equal(t, 200, authorizeResponse.Status)
		require.Equal(t, "authorize:"+string(endpoint.Kind), string(authorizeResponse.Body))
		tokenPath := mustPath(t, endpoint.OAuthTokenPath)
		tokenResponse := serve(app, "POST", tokenPath, nil)
		require.Equal(t, 200, tokenResponse.Status)
		require.Equal(t, "token:"+string(endpoint.Kind), string(tokenResponse.Body))
	}
}

func TestRegisterMCPFacadeInventoryMatchesSharedConstructFixture(t *testing.T) {
	t.Parallel()
	contents, err := os.ReadFile(routeInventoryExpectationsPath)
	require.NoError(t, err)
	var fixture routeInventoryFixture
	require.NoError(t, json.Unmarshal(contents, &fixture))

	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	config := validConfig(URLModePublicBaseURL)
	config.AuthorizeHandler = kindHandlerFactory("authorize")
	config.TokenHandler = kindHandlerFactory("token")
	inventory, err := RegisterMCPFacade(app, config)
	require.NoError(t, err)

	require.Equal(t, fixture.ContractVersion, inventory.ContractVersion)
	require.Equal(t, fixture.RootAuthorizationServerPattern, inventory.RootAuthorizationServerPattern)
	require.Equal(t, fixture.RootAuthorizationServerAttached, inventory.RootAuthorizationServerAttached)
	require.Len(t, inventory.Routes, len(fixture.Routes))
	for index, expected := range fixture.Routes {
		require.Equal(t, expected, routeFixture{
			Kind:                        inventory.Routes[index].Kind,
			MCPPattern:                  inventory.Routes[index].MCPPattern,
			MCPMethods:                  inventory.Routes[index].MCPMethods,
			ProtectedResourcePattern:    inventory.Routes[index].ProtectedResourcePattern,
			DiscoveryCanonicalPattern:   inventory.Routes[index].DiscoveryCanonicalPattern,
			DiscoverySuffixPattern:      inventory.Routes[index].DiscoverySuffixPattern,
			AuthorizePattern:            inventory.Routes[index].AuthorizePattern,
			TokenPattern:                inventory.Routes[index].TokenPattern,
			AuthorizationRoutesAttached: inventory.Routes[index].AuthorizationRoutesAttached,
		})
	}
}

func TestMetadataDocumentsAreByteExactForEveryKindAndURLMode(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		mode       URLMode
		headers    map[string][]string
		publicBase string
	}{
		{name: "install time public base URL", mode: URLModePublicBaseURL, publicBase: "https://front.example.com/"},
		{name: "request host", mode: URLModeRequestHost, headers: map[string][]string{"host": {"Direct.Example.com.:443"}, "x-forwarded-proto": {"https"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
			config := validConfig(test.mode)
			config.PublicBaseURL = test.publicBase
			_, err := RegisterMCPFacade(app, config)
			require.NoError(t, err)

			base := "https://direct.example.com"
			if test.mode == URLModePublicBaseURL {
				base = "https://front.example.com"
			}
			for _, endpoint := range testEndpoints {
				mcpPath := mustPath(t, endpoint.MCPPath)
				protectedPath := mustPath(t, endpoint.ProtectedResourcePath)
				protected := serve(app, "GET", protectedPath, test.headers)
				require.Equal(t, 200, protected.Status)
				require.Equal(t, expectedProtectedResourceJSON(base+mcpPath, endpoint.Kind), string(protected.Body))

				authorizePath := mustPath(t, endpoint.OAuthAuthorizePath)
				tokenPath := mustPath(t, endpoint.OAuthTokenPath)
				expectedDiscovery := expectedAuthorizationServerJSON(base+authorizePath, base+tokenPath, endpoint.Kind)
				canonicalPath := mustPath(t, endpoint.OAuthAuthorizationServerPath)
				canonical := serve(app, "GET", canonicalPath, test.headers)
				require.Equal(t, 200, canonical.Status)
				require.Equal(t, expectedDiscovery, string(canonical.Body))
				suffixPath := mustPath(t, endpoint.OAuthAuthorizationServerSuffixPath)
				suffix := serve(app, "GET", suffixPath, test.headers)
				require.Equal(t, 200, suffix.Status)
				require.Equal(t, expectedDiscovery, string(suffix.Body))
			}
		})
	}
}

func TestSharedFixturePinsRoutedDocumentBytesPerKindAndMode(t *testing.T) {
	t.Parallel()
	contents, err := os.ReadFile(documentExpectationsPath)
	require.NoError(t, err)
	var fixtures documentFixtureFile
	require.NoError(t, json.Unmarshal(contents, &fixtures))
	require.Len(t, fixtures.Documents, 8)

	for _, fixture := range fixtures.Documents {
		t.Run(fixture.Name, func(t *testing.T) {
			t.Parallel()
			app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
			_, registerErr := RegisterMCPFacade(app, validConfig(fixture.Mode))
			require.NoError(t, registerErr)
			headers := map[string][]string(nil)
			if fixture.Mode == URLModeRequestHost {
				headers = map[string][]string{"host": {"direct.example.com"}, "x-forwarded-proto": {"https"}}
			}

			protected := serve(app, "GET", fixture.ProtectedResourcePath, headers)
			require.Equal(t, 200, protected.Status)
			require.Equal(t, fixture.ProtectedResourceDocument, string(protected.Body))
			canonical := serve(app, "GET", fixture.AuthorizationServerPath, headers)
			require.Equal(t, 200, canonical.Status)
			require.Equal(t, fixture.AuthorizationServerDocument, string(canonical.Body))
			suffix := serve(app, "GET", fixture.AuthorizationServerSuffixPath, headers)
			require.Equal(t, 200, suffix.Status)
			require.Equal(t, fixture.AuthorizationServerDocument, string(suffix.Body))
		})
	}
}

func TestDiscoveryRebuildsPathParameterIdentityForEveryKind(t *testing.T) {
	t.Parallel()
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	_, err := RegisterMCPFacade(app, validConfig(URLModePublicBaseURL))
	require.NoError(t, err)

	for _, endpoint := range testEndpoints {
		for _, pathBuilder := range []func() (string, error){
			endpoint.OAuthAuthorizationServerPath,
			endpoint.OAuthAuthorizationServerSuffixPath,
		} {
			requestPath, pathErr := pathBuilder()
			require.NoError(t, pathErr)
			response := serve(app, "GET", requestPath, nil)
			require.Equal(t, 200, response.Status)
			var body struct {
				AuthorizationEndpoint string `json:"authorization_endpoint"`
				TokenEndpoint         string `json:"token_endpoint"`
			}
			require.NoError(t, json.Unmarshal(response.Body, &body))
			authorizePath := mustPath(t, endpoint.OAuthAuthorizePath)
			tokenPath := mustPath(t, endpoint.OAuthTokenPath)
			require.Equal(t, "https://front.example.com"+authorizePath, body.AuthorizationEndpoint)
			require.Equal(t, "https://front.example.com"+tokenPath, body.TokenEndpoint)
		}
	}
}

func TestRequestHostModeUsesNormalizedAPIGatewayEventHeaders(t *testing.T) {
	t.Parallel()
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	_, err := RegisterMCPFacade(app, validConfig(URLModeRequestHost))
	require.NoError(t, err)

	response := app.ServeAPIGatewayV2(context.Background(), events.APIGatewayV2HTTPRequest{
		RawPath: "/.well-known/oauth-protected-resource/acme/mcp",
		Headers: map[string]string{
			"host":              "api.example.com",
			"x-forwarded-proto": "https",
		},
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			Stage: "$default",
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method: "GET",
				Path:   "/.well-known/oauth-protected-resource/acme/mcp",
			},
		},
	})
	require.Equal(t, 200, response.StatusCode)
	require.Equal(t, expectedProtectedResourceJSON("https://api.example.com/acme/mcp", mcproutes.EndpointKindNamespace), response.Body)
}

func TestRequestHostModeFailsClosedForSpoofedHigherPrecedenceHosts(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		headers map[string][]string
	}{
		{
			name: "x forwarded host",
			headers: map[string][]string{
				"host": {"direct.example.com"}, "x-forwarded-host": {"evil.example"}, "x-forwarded-proto": {"https"},
			},
		},
		{
			name: "x apptheory original host",
			headers: map[string][]string{
				"host": {"direct.example.com"}, "x-apptheory-original-host": {"evil.example"}, "x-forwarded-proto": {"https"},
			},
		},
		{
			name: "x facetheory original host",
			headers: map[string][]string{
				"host": {"direct.example.com"}, "x-facetheory-original-host": {"evil.example"}, "x-forwarded-proto": {"https"},
			},
		},
		{
			name: "forwarded host",
			headers: map[string][]string{
				"host": {"direct.example.com"}, "forwarded": {"for=192.0.2.1;host=evil.example;proto=https"},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
			_, err := RegisterMCPFacade(app, validConfig(URLModeRequestHost))
			require.NoError(t, err)
			response := serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp", test.headers)
			require.Equal(t, 400, response.Status)
			require.Equal(t, `{"error":"invalid_request_host"}`, string(response.Body))
			assertMetadataHeaders(t, response)
		})
	}
}

func TestRequestHostModeAllowsOnlyNormalizedAllowlistMatches(t *testing.T) {
	t.Parallel()
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	config := validConfig(URLModeRequestHost)
	config.AllowedHostnames = []string{"DIRECT.EXAMPLE.COM.:443", "edge.example.com"}
	_, err := RegisterMCPFacade(app, config)
	require.NoError(t, err)

	legit := serve(app, "GET", "/.well-known/oauth-protected-resource/acme/mcp", map[string][]string{
		"host": {"direct.example.com:443"}, "x-forwarded-proto": {"https"},
	})
	require.Equal(t, 200, legit.Status)
	require.Equal(t, expectedProtectedResourceJSON("https://direct.example.com/acme/mcp", mcproutes.EndpointKindNamespace), string(legit.Body))

	forwarded := serve(app, "GET", "/.well-known/oauth-protected-resource/acme/mcp", map[string][]string{
		"host": {"direct.example.com"}, "x-forwarded-host": {"EDGE.EXAMPLE.COM.:443"}, "x-forwarded-proto": {"https"},
	})
	require.Equal(t, 200, forwarded.Status)
	require.Equal(t, expectedProtectedResourceJSON("https://edge.example.com/acme/mcp", mcproutes.EndpointKindNamespace), string(forwarded.Body))

	wrongPort := serve(app, "GET", "/.well-known/oauth-protected-resource/acme/mcp", map[string][]string{
		"host": {"edge.example.com:8443"}, "x-forwarded-proto": {"https"},
	})
	require.Equal(t, 400, wrongPort.Status)
	require.Equal(t, `{"error":"invalid_request_host"}`, string(wrongPort.Body))
}

func TestAllowedHostnameDefaultPortNormalizationIsSchemeAgnostic(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"edge.example.com:80", "edge.example.com:443"} {
		normalized, ok := normalizeAllowedHostname(raw)
		require.True(t, ok)
		require.Equal(t, "edge.example.com", normalized)
	}
}

func TestWildcardStyleAllowlistEntriesRegisterAsLiteralKeys(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name        string
		allowedHost string
		requestHost string
	}{
		{name: "bare wildcard", allowedHost: "*", requestHost: "tenant.example.com"},
		{name: "wildcard prefix", allowedHost: "*.example.com", requestHost: "tenant.example.com"},
		{name: "comma list", allowedHost: "a.example,b.example", requestHost: "a.example"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
			config := validConfig(URLModeRequestHost)
			config.AllowedHostnames = []string{test.allowedHost}
			_, err := RegisterMCPFacade(app, config)
			require.NoError(t, err)

			response := serve(app, "GET", "/.well-known/oauth-protected-resource/acme/mcp", map[string][]string{
				"host": {test.requestHost}, "x-forwarded-proto": {"https"},
			})
			require.Equal(t, 400, response.Status)
			require.Equal(t, `{"error":"invalid_request_host"}`, string(response.Body))
		})
	}

	literalMatches := []struct {
		name    string
		headers map[string][]string
	}{
		{
			name: "host case variant",
			headers: map[string][]string{
				"host": {"*.EXAMPLE.COM"}, "x-forwarded-proto": {"https"},
			},
		},
		{
			name: "forwarded host trailing dot variant",
			headers: map[string][]string{
				"host": {"not-allowlisted.example.com"}, "x-forwarded-host": {"*.example.com."}, "x-forwarded-proto": {"https"},
			},
		},
		{
			name: "forwarded header default port variant",
			headers: map[string][]string{
				"host": {"not-allowlisted.example.com"}, "forwarded": {"for=192.0.2.1;host=*.EXAMPLE.COM.:443;proto=https"},
			},
		},
		{
			name: "apptheory original host trailing dot variant",
			headers: map[string][]string{
				"host": {"not-allowlisted.example.com"}, "x-apptheory-original-host": {"*.EXAMPLE.COM."}, "x-forwarded-proto": {"https"},
			},
		},
		{
			name: "facetheory original host default port variant",
			headers: map[string][]string{
				"host": {"not-allowlisted.example.com"}, "x-facetheory-original-host": {"*.EXAMPLE.COM.:443"}, "x-forwarded-proto": {"https"},
			},
		},
	}
	for _, test := range literalMatches {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
			config := validConfig(URLModeRequestHost)
			config.AllowedHostnames = []string{"*.example.com"}
			_, err := RegisterMCPFacade(app, config)
			require.NoError(t, err)

			response := serve(app, "GET", "/.well-known/oauth-protected-resource/acme/mcp", test.headers)
			require.Equal(t, 200, response.Status)
			require.Equal(t, expectedProtectedResourceJSON("https://*.example.com/acme/mcp", mcproutes.EndpointKindNamespace), string(response.Body))
		})
	}
}

func TestEveryFacadeMetadataResponseIsNoStoreAndVariesOnOriginHeaders(t *testing.T) {
	t.Parallel()
	for _, mode := range []URLMode{URLModePublicBaseURL, URLModeRequestHost} {
		t.Run(string(mode), func(t *testing.T) {
			t.Parallel()
			app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
			config := validConfig(mode)
			config.RootAuthorizationServer = validRootDiscoveryConfig()
			_, err := RegisterMCPFacade(app, config)
			require.NoError(t, err)
			headers := map[string][]string(nil)
			if mode == URLModeRequestHost {
				headers = map[string][]string{"host": {"direct.example.com"}, "x-forwarded-proto": {"https"}}
			}
			for _, endpoint := range testEndpoints {
				for _, pathBuilder := range []func() (string, error){
					endpoint.ProtectedResourcePath,
					endpoint.OAuthAuthorizationServerPath,
					endpoint.OAuthAuthorizationServerSuffixPath,
				} {
					response := serve(app, "GET", mustPath(t, pathBuilder), headers)
					require.Equal(t, 200, response.Status)
					assertMetadataHeaders(t, response)
				}
			}
			root := serve(app, "GET", mcproutes.AuthorizationServerPathForResourcePath("/"), headers)
			require.Equal(t, 200, root.Status)
			assertMetadataHeaders(t, root)
		})
	}
}

func TestRootAuthorizationServerDiscoveryIsOptInAndStatic(t *testing.T) {
	t.Parallel()
	withoutRoot := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	inventory, err := RegisterMCPFacade(withoutRoot, validConfig(URLModePublicBaseURL))
	require.NoError(t, err)
	require.False(t, inventory.RootAuthorizationServerAttached)
	require.Equal(t, mcproutes.AuthorizationServerPathForResourcePath("/"), inventory.RootAuthorizationServerPattern)
	require.Equal(t, 404, serve(withoutRoot, "GET", inventory.RootAuthorizationServerPattern, nil).Status)

	withRoot := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	config := validConfig(URLModePublicBaseURL)
	config.RootAuthorizationServer = validRootDiscoveryConfig()
	inventory, err = RegisterMCPFacade(withRoot, config)
	require.NoError(t, err)
	require.True(t, inventory.RootAuthorizationServerAttached)
	response := serve(withRoot, "GET", inventory.RootAuthorizationServerPattern, nil)
	require.Equal(t, 200, response.Status)
	require.Equal(t, `{"issuer":"https://accounts.example.com","authorization_endpoint":"https://accounts.example.com/authorize","token_endpoint":"https://accounts.example.com/token","registration_endpoint":"https://accounts.example.com/register","jwks_uri":"https://accounts.example.com/.well-known/jwks.json","response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["none"],"code_challenge_methods_supported":["S256"],"scopes_supported":["openid","offline_access","mcp:tools"]}`, string(response.Body))

	// Root is separate from the four-kind canonical/suffix loop.
	require.Len(t, inventory.Routes, 4)
	for _, route := range inventory.Routes {
		require.NotEqual(t, inventory.RootAuthorizationServerPattern, route.DiscoveryCanonicalPattern)
		require.NotEqual(t, inventory.RootAuthorizationServerPattern, route.DiscoverySuffixPattern)
	}
}

func TestRootAuthorizationServerRejectsEveryUnsafeURLField(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		mutate     func(*RootDiscoveryConfig)
		errorField string
	}{
		{
			name: "issuer query",
			mutate: func(config *RootDiscoveryConfig) {
				config.IssuerURL = "https://accounts.example.com?tenant=acme"
			},
			errorField: "issuer URL",
		},
		{
			name: "authorization endpoint scheme",
			mutate: func(config *RootDiscoveryConfig) {
				config.AuthorizationEndpointURL = "javascript:alert(1)"
			},
			errorField: "authorization endpoint URL",
		},
		{
			name: "token endpoint host",
			mutate: func(config *RootDiscoveryConfig) {
				config.TokenEndpointURL = "https:///token"
			},
			errorField: "token endpoint URL",
		},
		{
			name: "registration endpoint userinfo",
			mutate: func(config *RootDiscoveryConfig) {
				config.RegistrationEndpointURL = "https://operator@accounts.example.com/register"
			},
			errorField: "registration endpoint URL",
		},
		{
			name: "JWKS fragment",
			mutate: func(config *RootDiscoveryConfig) {
				config.JWKSURI = "https://accounts.example.com/.well-known/jwks.json#active"
			},
			errorField: "JWKS URI",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
			config := validConfig(URLModePublicBaseURL)
			config.RootAuthorizationServer = validRootDiscoveryConfig()
			test.mutate(config.RootAuthorizationServer)

			inventory, err := RegisterMCPFacade(app, config)
			require.Nil(t, inventory)
			require.ErrorContains(t, err, test.errorField)
			require.Equal(t, 404, serve(app, "POST", "/acme/mcp", nil).Status)
			require.Equal(t, 404, serve(app, "GET", mcproutes.AuthorizationServerPathForResourcePath("/"), nil).Status)
		})
	}
}

func TestInvalidDerivedInventoryFailsBeforeTargetRegistration(t *testing.T) {
	t.Parallel()
	normalized, err := normalizeConfig(validConfig(URLModePublicBaseURL))
	require.NoError(t, err)
	inventory, err := buildInventory(false, false)
	require.NoError(t, err)
	inventory.Routes[1].MCPPattern = inventory.Routes[0].MCPPattern

	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	registrations, err := buildRegistrations(normalized, inventory)
	if err == nil {
		err = registerRoutes(app, registrations)
	}
	require.Nil(t, registrations)
	require.ErrorContains(t, err, "duplicate route inventory entry POST /{client_namespace}/mcp")
	for _, method := range []string{"POST", "GET", "DELETE"} {
		require.Equal(t, 404, serve(app, method, "/acme/mcp", nil).Status)
	}
}

func TestRouteInventoryValidationUsesTheScratchRouter(t *testing.T) {
	t.Parallel()
	handler := func(*apptheory.Context) (*apptheory.Response, error) { return apptheory.NoContent(), nil }
	err := validateRouteRegistrations([]routeRegistration{{
		method:  "GET",
		pattern: "/{proxy+}/not-last",
		handler: handler,
	}})
	require.ErrorContains(t, err, "invalid or duplicate route inventory entry")
}

func TestRouteInventoryDuplicatesAndRegisteredCollisionsReturnErrors(t *testing.T) {
	t.Parallel()
	handler := func(*apptheory.Context) (*apptheory.Response, error) { return apptheory.NoContent(), nil }
	registrations := []routeRegistration{
		{method: "GET", pattern: "/duplicate", handler: handler},
		{method: "get", pattern: "/duplicate", handler: handler},
	}
	require.ErrorContains(t, validateRouteRegistrations(registrations), "duplicate route inventory entry")

	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	app.Post(mcproutes.NamespaceMCPPattern, handler)
	_, err := RegisterMCPFacade(app, validConfig(URLModePublicBaseURL))
	require.ErrorContains(t, err, "register POST "+mcproutes.NamespaceMCPPattern)
	require.Equal(t, 405, serve(app, "GET", "/acme/mcp", nil).Status)
}

func TestScopesCapabilitiesAndRegistrationEndpointAreApplicationOwned(t *testing.T) {
	t.Parallel()
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	config := validConfig(URLModePublicBaseURL)
	config.Scopes[mcproutes.EndpointKindAgent] = []string{" custom:read ", "custom:read", "custom:write"}
	config.Capabilities = Capabilities{
		ResponseTypes:            []string{" device_code ", "device_code"},
		GrantTypes:               []string{"urn:custom:grant"},
		TokenEndpointAuthMethods: []string{"client_secret_post"},
		CodeChallengeMethods:     []string{"plain"},
	}
	config.RegistrationEndpointURL = "https://accounts.example.com/custom-register"
	_, err := RegisterMCPFacade(app, config)
	require.NoError(t, err)

	protected := serve(app, "GET", "/.well-known/oauth-protected-resource/acme/agents/helper/mcp", nil)
	require.Contains(t, string(protected.Body), `"scopes_supported":["custom:read","custom:write"]`)
	discovery := serve(app, "GET", "/.well-known/oauth-authorization-server/acme/agents/helper/mcp", nil)
	require.Equal(t, `{"issuer":"https://issuer.example.com","authorization_endpoint":"https://front.example.com/.well-known/oauth-authorization-server/acme/agents/helper/mcp/authorize","token_endpoint":"https://front.example.com/.well-known/oauth-authorization-server/acme/agents/helper/mcp/token","registration_endpoint":"https://accounts.example.com/custom-register","jwks_uri":"https://issuer.example.com/jwks.json?set=active","response_types_supported":["device_code"],"grant_types_supported":["urn:custom:grant"],"token_endpoint_auth_methods_supported":["client_secret_post"],"code_challenge_methods_supported":["plain"],"scopes_supported":["custom:read","custom:write"]}`, string(discovery.Body))
}

func TestMissingPlugPointsLeaveAuthorizationRoutesUnregistered(t *testing.T) {
	t.Parallel()
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	inventory, err := RegisterMCPFacade(app, validConfig(URLModePublicBaseURL))
	require.NoError(t, err)
	for _, route := range inventory.Routes {
		require.False(t, route.AuthorizationRoutesAttached)
	}
	require.Equal(t, 404, serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp/authorize", nil).Status)
	require.Equal(t, 404, serve(app, "POST", "/.well-known/oauth-authorization-server/acme/mcp/token", nil).Status)
}

func TestMalformedAndUnknownPathsFailClosed(t *testing.T) {
	t.Parallel()
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	_, err := RegisterMCPFacade(app, validConfig(URLModePublicBaseURL))
	require.NoError(t, err)

	require.Equal(t, 500, serve(app, "POST", "/ /mcp", nil).Status)
	require.Equal(t, 500, serve(app, "GET", "/.well-known/oauth-protected-resource/ /mcp", nil).Status)
	require.Equal(t, 500, serve(app, "GET", "/.well-known/oauth-authorization-server/ /mcp", nil).Status)
	require.Equal(t, 404, serve(app, "GET", "/unknown/mcp/path", nil).Status)

	plugApp := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	plugConfig := validConfig(URLModePublicBaseURL)
	plugConfig.AuthorizeHandler = kindHandlerFactory("authorize")
	plugConfig.TokenHandler = kindHandlerFactory("token")
	_, err = RegisterMCPFacade(plugApp, plugConfig)
	require.NoError(t, err)
	require.Equal(t, 500, serve(plugApp, "GET", "/.well-known/oauth-authorization-server/ /mcp/authorize", nil).Status)
	require.Equal(t, 500, serve(plugApp, "POST", "/.well-known/oauth-authorization-server/ /mcp/token", nil).Status)

	hostApp := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	_, err = RegisterMCPFacade(hostApp, validConfig(URLModeRequestHost))
	require.NoError(t, err)
	require.Equal(t, 400, serve(hostApp, "GET", "/.well-known/oauth-protected-resource/acme/mcp", nil).Status)
	require.Equal(t, 400, serve(hostApp, "GET", "/.well-known/oauth-authorization-server/acme/mcp", map[string][]string{"host": {"evil.example"}, "x-forwarded-proto": {"http"}}).Status)

	_, err = endpointFromMCPRequest(nil)
	require.Error(t, err)
	_, err = endpointFromProtectedResourceRequest(nil)
	require.Error(t, err)
	_, err = endpointFromDiscoveryRequest(nil, mcproutes.EndpointKindNamespace)
	require.Error(t, err)
	_, err = endpointFromDiscoveryRequest(&apptheory.Context{Request: apptheory.Request{Path: "/wrong"}, Params: map[string]string{mcproutes.ParamClientNamespace: "acme"}}, mcproutes.EndpointKindNamespace)
	require.Error(t, err)
	_, err = endpointFromRouteParams(nil, mcproutes.EndpointKindNamespace)
	require.Error(t, err)
}

func TestRegisterMCPFacadeValidatesConfigurationBeforeRegistration(t *testing.T) {
	t.Parallel()
	valid := validConfig(URLModePublicBaseURL)
	tests := []struct {
		name   string
		mutate func(*FacadeConfig)
	}{
		{name: "nil app", mutate: func(*FacadeConfig) {}},
		{name: "nil MCP handler", mutate: func(config *FacadeConfig) { config.MCPHandler = nil }},
		{name: "invalid issuer", mutate: func(config *FacadeConfig) { config.IssuerURL = "http://issuer.example.com" }},
		{name: "issuer query", mutate: func(config *FacadeConfig) { config.IssuerURL += "?tenant=acme" }},
		{name: "invalid JWKS", mutate: func(config *FacadeConfig) { config.JWKSURI = "/jwks" }},
		{name: "invalid registration endpoint", mutate: func(config *FacadeConfig) { config.RegistrationEndpointURL = "http://accounts.example.com/register" }},
		{name: "missing URL mode", mutate: func(config *FacadeConfig) { config.URLMode = "" }},
		{name: "missing public base", mutate: func(config *FacadeConfig) { config.PublicBaseURL = "" }},
		{name: "public base query", mutate: func(config *FacadeConfig) { config.PublicBaseURL += "?bad=1" }},
		{name: "public base path", mutate: func(config *FacadeConfig) { config.PublicBaseURL = "https://front.example.com/base" }},
		{name: "public base with allowlist", mutate: func(config *FacadeConfig) { config.AllowedHostnames = []string{"front.example.com"} }},
		{name: "request host with public base", mutate: func(config *FacadeConfig) { config.URLMode = URLModeRequestHost }},
		{name: "request host without allowlist", mutate: func(config *FacadeConfig) {
			config.URLMode = URLModeRequestHost
			config.PublicBaseURL = ""
		}},
		{name: "request host invalid allowlist", mutate: func(config *FacadeConfig) {
			config.URLMode = URLModeRequestHost
			config.PublicBaseURL = ""
			config.AllowedHostnames = []string{"https://front.example.com"}
		}},
		{name: "missing scopes", mutate: func(config *FacadeConfig) { delete(config.Scopes, mcproutes.EndpointKindAgent) }},
		{name: "empty scope", mutate: func(config *FacadeConfig) { config.Scopes[mcproutes.EndpointKindAgent] = []string{" "} }},
		{name: "unknown scope kind", mutate: func(config *FacadeConfig) { config.Scopes["unknown"] = []string{"scope"} }},
		{name: "empty capability override", mutate: func(config *FacadeConfig) { config.Capabilities.GrantTypes = []string{} }},
		{name: "blank capability", mutate: func(config *FacadeConfig) { config.Capabilities.ResponseTypes = []string{" "} }},
		{name: "authorize only", mutate: func(config *FacadeConfig) { config.AuthorizeHandler = kindHandlerFactory("authorize") }},
		{name: "token only", mutate: func(config *FacadeConfig) { config.TokenHandler = kindHandlerFactory("token") }},
		{name: "nil authorize result", mutate: func(config *FacadeConfig) {
			config.AuthorizeHandler = func(mcproutes.EndpointKind) apptheory.Handler { return nil }
			config.TokenHandler = kindHandlerFactory("token")
		}},
		{name: "nil token result", mutate: func(config *FacadeConfig) {
			config.AuthorizeHandler = kindHandlerFactory("authorize")
			config.TokenHandler = func(mcproutes.EndpointKind) apptheory.Handler { return nil }
		}},
		{name: "incomplete root discovery", mutate: func(config *FacadeConfig) {
			config.RootAuthorizationServer = validRootDiscoveryConfig()
			config.RootAuthorizationServer.TokenEndpointURL = ""
		}},
		{name: "empty root scopes", mutate: func(config *FacadeConfig) {
			config.RootAuthorizationServer = validRootDiscoveryConfig()
			config.RootAuthorizationServer.Scopes = nil
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			config := cloneConfig(valid)
			test.mutate(&config)
			var app *apptheory.App
			if test.name != "nil app" {
				app = apptheory.New(apptheory.WithTier(apptheory.TierP0))
			}
			_, err := RegisterMCPFacade(app, config)
			require.Error(t, err)
			if app != nil {
				require.Equal(t, 404, serve(app, "POST", "/acme/mcp", nil).Status)
			}
		})
	}
}

func TestRequestHostAndPublicBaseMutualExclusionIsIndependentlyPinned(t *testing.T) {
	t.Parallel()
	config := validConfig(URLModeRequestHost)
	config.PublicBaseURL = "https://front.example.com"
	_, err := RegisterMCPFacade(apptheory.New(apptheory.WithTier(apptheory.TierP0)), config)
	require.ErrorContains(t, err, "request-host mode cannot also configure a public base URL")
}

func TestPublicBaseURLPathConstraintIsExplicit(t *testing.T) {
	t.Parallel()
	config := validConfig(URLModePublicBaseURL)
	config.PublicBaseURL = "https://front.example.com/base"
	_, err := RegisterMCPFacade(apptheory.New(apptheory.WithTier(apptheory.TierP0)), config)
	require.ErrorContains(t, err, "without a path")
}

func TestHelpersCanonicalizeURLsAndDefensivelyCloneInventory(t *testing.T) {
	t.Parallel()
	require.Equal(t, Capabilities{
		ResponseTypes:            []string{"code"},
		GrantTypes:               []string{"authorization_code", "refresh_token"},
		TokenEndpointAuthMethods: []string{"none"},
		CodeChallengeMethods:     []string{"S256"},
	}, DefaultCapabilities())

	base, ok := normalizePublicBaseURL("http://LOCALHOST:80/")
	require.True(t, ok)
	require.Equal(t, "http://localhost", base)
	base, ok = normalizePublicBaseURL("http://[::1]:8080/")
	require.True(t, ok)
	require.Equal(t, "http://[::1]:8080", base)
	_, ok = normalizePublicBaseURL("http://example.com")
	require.False(t, ok)
	_, ok = normalizePublicBaseURL("https://user@example.com")
	require.False(t, ok)
	_, ok = normalizePublicBaseURL("https://example.com/path")
	require.False(t, ok)

	absolute, ok := absoluteURLForPath("https://example.com/base?discard=yes", "/route")
	require.True(t, ok)
	require.Equal(t, "https://example.com/base/route", absolute)
	_, ok = absoluteURLForPath("not-a-url", "/route")
	require.False(t, ok)
	_, ok = absoluteURLForPath("https://example.com", "relative")
	require.False(t, ok)

	inventory, err := buildInventory(true, false)
	require.NoError(t, err)
	cloned := cloneInventory(inventory)
	cloned.Routes[0].MCPMethods[0] = "PATCH"
	require.Equal(t, "POST", inventory.Routes[0].MCPMethods[0])
	require.True(t, reflect.DeepEqual(indexFacadeTemplates(mcproutes.SupportedOAuthFacadeTemplates())[mcproutes.EndpointKindAgent].Kind, mcproutes.EndpointKindAgent))
	require.Equal(t, mcproutes.EndpointKindPartnerAgent, indexDiscoveryTemplates(mcproutes.SupportedOAuthDiscoveryTemplates())[mcproutes.EndpointKindPartnerAgent].Kind)
}

func TestIPv6AllowedHostnameCanonicalizationKeepsBrackets(t *testing.T) {
	t.Parallel()
	host, ok := normalizeAllowedHostname("[::1]")
	require.True(t, ok)
	require.Equal(t, "[::1]", host)

	host, ok = normalizeAllowedHostname("[::1]:8443")
	require.True(t, ok)
	require.Equal(t, "[::1]:8443", host)
}

func TestMetadataRequestFailuresPreserveTypeAndNilContextSemantics(t *testing.T) {
	t.Parallel()
	response, ok := metadataRequestFailure(fmt.Errorf("internal failure"))
	require.False(t, ok)
	require.Nil(t, response)

	requestErr := &metadataRequestError{message: "request host is not allowlisted"}
	require.Equal(t, "mcpfacade: request host is not allowlisted", requestErr.Error())
	response, ok = metadataRequestFailure(requestErr)
	require.True(t, ok)
	require.Equal(t, 400, response.Status)
	require.Equal(t, `{"error":"invalid_request_host"}`, string(response.Body))

	config := normalizedConfig{urlMode: URLModeRequestHost}
	_, err := config.absoluteURL(nil, "/acme/mcp")
	require.EqualError(t, err, "mcpfacade: request context is required for request-host URL mode")
	response, ok = metadataRequestFailure(err)
	require.True(t, ok)
	require.Equal(t, 400, response.Status)
}

func validConfig(mode URLMode) FacadeConfig {
	config := FacadeConfig{
		IssuerURL:     "https://issuer.example.com/",
		JWKSURI:       "https://issuer.example.com/jwks.json?set=active",
		URLMode:       mode,
		PublicBaseURL: "https://front.example.com/",
		Scopes: map[mcproutes.EndpointKind][]string{
			mcproutes.EndpointKindNamespace:        {"namespace:use"},
			mcproutes.EndpointKindPartnerNamespace: {"partner_namespace:use"},
			mcproutes.EndpointKindAgent:            {"agent:use"},
			mcproutes.EndpointKindPartnerAgent:     {"partner_agent:use"},
		},
		MCPHandler: func(*apptheory.Context) (*apptheory.Response, error) {
			return apptheory.NoContent(), nil
		},
	}
	if mode == URLModeRequestHost {
		config.PublicBaseURL = ""
		config.AllowedHostnames = []string{"direct.example.com", "api.example.com"}
	}
	return config
}

func validRootDiscoveryConfig() *RootDiscoveryConfig {
	return &RootDiscoveryConfig{
		IssuerURL:                "https://accounts.example.com",
		AuthorizationEndpointURL: "https://accounts.example.com/authorize",
		TokenEndpointURL:         "https://accounts.example.com/token",
		RegistrationEndpointURL:  "https://accounts.example.com/register",
		JWKSURI:                  "https://accounts.example.com/.well-known/jwks.json",
		Scopes:                   []string{"openid", "offline_access", "mcp:tools"},
	}
}

func cloneConfig(config FacadeConfig) FacadeConfig {
	clone := config
	clone.AllowedHostnames = append([]string(nil), config.AllowedHostnames...)
	clone.Scopes = make(map[mcproutes.EndpointKind][]string, len(config.Scopes))
	for kind, scopes := range config.Scopes {
		clone.Scopes[kind] = append([]string(nil), scopes...)
	}
	if config.RootAuthorizationServer != nil {
		root := *config.RootAuthorizationServer
		root.Scopes = append([]string(nil), config.RootAuthorizationServer.Scopes...)
		clone.RootAuthorizationServer = &root
	}
	return clone
}

func kindHandlerFactory(prefix string) HandlerFactory {
	return func(kind mcproutes.EndpointKind) apptheory.Handler {
		return func(*apptheory.Context) (*apptheory.Response, error) {
			return apptheory.Text(200, prefix+":"+string(kind)), nil
		}
	}
}

func serve(app *apptheory.App, method, path string, headers map[string][]string) apptheory.Response {
	return app.Serve(context.Background(), apptheory.Request{Method: method, Path: path, Headers: headers})
}

func mustPath(t *testing.T, build func() (string, error)) string {
	t.Helper()
	path, err := build()
	require.NoError(t, err)
	return path
}

func expectedProtectedResourceJSON(resource string, kind mcproutes.EndpointKind) string {
	return fmt.Sprintf(`{"resource":%q,"authorization_servers":["https://issuer.example.com"],"jwks_uri":"https://issuer.example.com/jwks.json?set=active","scopes_supported":[%q]}`, resource, string(kind)+":use")
}

func expectedAuthorizationServerJSON(authorizeURL, tokenURL string, kind mcproutes.EndpointKind) string {
	return fmt.Sprintf(`{"issuer":"https://issuer.example.com","authorization_endpoint":%q,"token_endpoint":%q,"registration_endpoint":"https://issuer.example.com/register","jwks_uri":"https://issuer.example.com/jwks.json?set=active","response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["none"],"code_challenge_methods_supported":["S256"],"scopes_supported":[%q]}`, authorizeURL, tokenURL, string(kind)+":use")
}

func assertMetadataHeaders(t *testing.T, response apptheory.Response) {
	t.Helper()
	require.Equal(t, []string{"no-store"}, response.Headers["cache-control"])
	require.Equal(t, []string{"Host, X-Forwarded-Host, X-AppTheory-Original-Host, X-FaceTheory-Original-Host, Forwarded, CloudFront-Forwarded-Proto, X-Forwarded-Proto"}, response.Headers["vary"])
}
