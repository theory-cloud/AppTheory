package mcpfacade

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
)

const frontDoorTestSecret = "front-door-secret-0123456789-abcdefghi" // #nosec G101 -- a test fixture header value, not a credential.

func frontedConfig() FacadeConfig {
	config := validConfig(URLModePublicBaseURL)
	config.OriginReachability = OriginReachabilityFronted
	config.FrontDoorVerification = &FrontDoorVerification{
		HeaderName:  "x-front-door",
		SecretValue: frontDoorTestSecret,
	}
	// Runtime-bearer keeps the OAuth facade inventory attached and gives the
	// transport routes a deterministic admission for the positive case.
	config.TransportPosture = TransportPostureRuntimeBearer
	config.RequireBearerToken = &oauth.RequireBearerTokenOptions{
		ResourceMetadataURL: "https://front.example.com/.well-known/oauth-protected-resource/acme/mcp",
		Validator: func(*apptheory.Context, string) error {
			return nil
		},
	}
	return config
}

// TestFrontDoorVerificationRegistrationFailsClosed pins the startup contract: a
// declared FRONTED posture the runtime cannot enforce fails registration before
// any route is added, and a front-door declaration under any other posture is
// refused as contradictory.
func TestFrontDoorVerificationRegistrationFailsClosed(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*FacadeConfig)
		want   string
	}{
		{
			name: "fronted without verification",
			mutate: func(config *FacadeConfig) {
				config.OriginReachability = OriginReachabilityFronted
				config.FrontDoorVerification = nil
			},
			want: "OriginReachability fronted requires FrontDoorVerification",
		},
		{
			name: "verification without fronted",
			mutate: func(config *FacadeConfig) {
				config.OriginReachability = ""
				config.FrontDoorVerification = &FrontDoorVerification{
					HeaderName:  "x-front-door",
					SecretValue: frontDoorTestSecret,
				}
			},
			want: "FrontDoorVerification is only valid with OriginReachability fronted",
		},
		{
			name: "verification with disabled",
			mutate: func(config *FacadeConfig) {
				config.OriginReachability = OriginReachabilityDisabled
				config.FrontDoorVerification = &FrontDoorVerification{
					HeaderName:  "x-front-door",
					SecretValue: frontDoorTestSecret,
				}
			},
			want: "FrontDoorVerification is only valid with OriginReachability fronted",
		},
		{
			name: "unknown posture",
			mutate: func(config *FacadeConfig) {
				config.OriginReachability = "asserted"
			},
			want: "OriginReachability must be disabled, locked, or fronted",
		},
		{
			name: "header name alphabet",
			mutate: func(config *FacadeConfig) {
				config.OriginReachability = OriginReachabilityFronted
				config.FrontDoorVerification = &FrontDoorVerification{
					HeaderName:  "x front door",
					SecretValue: frontDoorTestSecret,
				}
			},
			want: "header name must be 1 to 64 characters of [A-Za-z0-9-]",
		},
		{
			name: "reserved header name",
			mutate: func(config *FacadeConfig) {
				config.OriginReachability = OriginReachabilityFronted
				config.FrontDoorVerification = &FrontDoorVerification{
					HeaderName:  "Authorization",
					SecretValue: frontDoorTestSecret,
				}
			},
			want: "header name must be a request header the front door can set",
		},
		{
			name: "platform header name",
			mutate: func(config *FacadeConfig) {
				config.OriginReachability = OriginReachabilityFronted
				config.FrontDoorVerification = &FrontDoorVerification{
					HeaderName:  "x-amzn-trace-id",
					SecretValue: frontDoorTestSecret,
				}
			},
			want: "header name must be a request header the front door can set",
		},
		{
			name: "secret alphabet",
			mutate: func(config *FacadeConfig) {
				config.OriginReachability = OriginReachabilityFronted
				config.FrontDoorVerification = &FrontDoorVerification{
					HeaderName:  "x-front-door",
					SecretValue: "short",
				}
			},
			want: "secret value must be 32 to 128 characters of [A-Za-z0-9._~-]",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			config := validConfig(URLModePublicBaseURL)
			testCase.mutate(&config)
			app := apptheory.New()
			inventory, err := RegisterMCPFacade(app, config)
			require.ErrorContains(t, err, testCase.want)
			require.Nil(t, inventory)
		})
	}
}

// TestFrontDoorVerificationAcceptsEdgeEnforcedPostures pins that disabled and
// locked remain registration-valid without a front-door declaration: they are
// edge-enforced and carry no runtime check.
func TestFrontDoorVerificationAcceptsEdgeEnforcedPostures(t *testing.T) {
	for _, posture := range []OriginReachability{"", OriginReachabilityDisabled, OriginReachabilityLocked} {
		t.Run(string(posture), func(t *testing.T) {
			config := validConfig(URLModePublicBaseURL)
			config.OriginReachability = posture
			_, err := RegisterMCPFacade(apptheory.New(), config)
			require.NoError(t, err)
		})
	}
}

func requireForbidden(t *testing.T, response apptheory.Response) {
	t.Helper()
	require.Equal(t, 403, response.Status)
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(response.Body, &body))
	require.Equal(t, "app.forbidden", body.Error.Code)
}

// TestFrontDoorVerificationRefusesDirectOriginRequests pins the fail-closed
// request behavior across the derived inventory: transport and OAuth facade
// routes both refuse a request whose declared header is absent or wrong, and
// admit the one that presents it.
func TestFrontDoorVerificationRefusesDirectOriginRequests(t *testing.T) {
	app := apptheory.New()
	inventory, err := RegisterMCPFacade(app, frontedConfig())
	require.NoError(t, err)
	require.NotEmpty(t, inventory.Routes)

	namespaceRoute := inventory.Routes[0]
	frontDoorHeaders := map[string][]string{
		"x-front-door":  {frontDoorTestSecret},
		"authorization": {"Bearer admitted-token"},
	}

	response := serve(app, "POST", namespaceRoute.MCPPattern, frontDoorHeaders)
	require.Equal(t, 204, response.Status, "a front-door request reaches the MCP handler")

	requireForbidden(t, serve(app, "POST", namespaceRoute.MCPPattern, nil))
	requireForbidden(t, serve(app, "GET", namespaceRoute.MCPPattern, nil))
	requireForbidden(t, serve(app, "DELETE", namespaceRoute.MCPPattern, nil))
	requireForbidden(t, serve(app, "POST", namespaceRoute.MCPPattern, map[string][]string{
		"x-front-door": {strings.Repeat("b", len(frontDoorTestSecret))},
	}))
	requireForbidden(t, serve(app, "POST", namespaceRoute.MCPPattern, map[string][]string{
		"x-front-door": {frontDoorTestSecret[:len(frontDoorTestSecret)-1]},
	}))

	// The OAuth facade documents are part of the same derived inventory: a
	// direct-origin request gets the same refusal instead of a public document.
	requireForbidden(t, serve(app, "GET", namespaceRoute.ProtectedResourcePattern, nil))
	requireForbidden(t, serve(app, "GET", namespaceRoute.DiscoveryCanonicalPattern, nil))
	requireForbidden(t, serve(app, "GET", namespaceRoute.DiscoverySuffixPattern, nil))
	require.Equal(t, 200, serve(app, "GET", namespaceRoute.ProtectedResourcePattern, frontDoorHeaders).Status)
}

// TestFrontDoorVerificationRunsBeforeTheBearerGuard pins the guard order: a
// direct-origin request is refused 403 before any credential work, while a
// front-door request still faces the runtime-bearer 401.
func TestFrontDoorVerificationRunsBeforeTheBearerGuard(t *testing.T) {
	config := frontedConfig()
	config.RequireBearerToken = &oauth.RequireBearerTokenOptions{
		ResourceMetadataURL: "https://front.example.com/.well-known/oauth-protected-resource/acme/mcp",
	}
	app := apptheory.New()
	inventory, err := RegisterMCPFacade(app, config)
	require.NoError(t, err)
	pattern := inventory.Routes[0].MCPPattern

	requireForbidden(t, serve(app, "POST", pattern, nil))
	require.Equal(t, 401, serve(app, "POST", pattern, map[string][]string{
		"x-front-door": {frontDoorTestSecret},
	}).Status)
}
