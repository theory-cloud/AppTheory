package mcpfacade

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

// stubProvider is a no-op oauth.Provider used to declare a front channel in
// tests that exercise configuration validation. The executed front-channel
// tests use the loopback testkit provider instead.
type stubProvider struct{}

func (stubProvider) Discovery(context.Context) (*oauth.ProviderMetadata, error) {
	return &oauth.ProviderMetadata{Issuer: "https://id.example.com"}, nil
}

func (stubProvider) AuthorizationURL(oauth.AuthorizationRequest) (string, error) {
	return "https://id.example.com/authorize", nil
}

func (stubProvider) ExchangeCode(context.Context, oauth.CodeExchangeRequest) (*oauth.TokenSet, error) {
	return &oauth.TokenSet{AccessToken: "upstream", TokenType: "Bearer"}, nil
}

func (stubProvider) Refresh(context.Context, oauth.RefreshRequest) (*oauth.TokenSet, error) {
	return &oauth.TokenSet{AccessToken: "upstream", TokenType: "Bearer"}, nil
}

func (stubProvider) ValidateAccessToken(context.Context, string, oauth.TokenExpectations) (*oauth.TokenClaims, error) {
	return &oauth.TokenClaims{Subject: "subject"}, nil
}

// completeFrontChannelConfig returns a complete, valid front-channel field set built on
// the in-memory reference stores.
func completeFrontChannelConfig() FacadeConfig {
	config := validConfig(URLModePublicBaseURL)
	config.Provider = stubProvider{}
	config.Stores = referenceStores()
	config.UpstreamClientID = "mcp_facade_client"
	config.UpstreamIssuer = "https://id.example.com"
	return config
}

func referenceStores() oauthstore.Stores {
	return oauthstore.Stores{
		Transaction:        oauthstore.NewMemoryTransactionStore(oauthstore.TransactionStoreOptions{}),
		AuthorizationCode:  oauthstore.NewMemoryAuthorizationCodeStore(oauthstore.AuthorizationCodeStoreOptions{}),
		Client:             oauthstore.NewMemoryClientStore(oauthstore.ClientStoreOptions{}),
		RouteRefreshBroker: oauthstore.NewMemoryRouteRefreshBrokerStore(oauthstore.RouteRefreshBrokerStoreOptions{}),
		RateLimit:          oauthstore.NewMemoryRateLimitStore(oauthstore.RateLimitStoreOptions{}),
	}
}

func TestFrontChannelConfigAcceptsACompleteSet(t *testing.T) {
	app := apptheory.New()
	_, err := RegisterMCPFacade(app, completeFrontChannelConfig())
	require.NoError(t, err)
}

func TestFrontChannelConfigRequiresEveryField(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*FacadeConfig)
		want   string
	}{
		{name: "upstream client id", mutate: func(c *FacadeConfig) { c.UpstreamClientID = "" }, want: "upstream client id"},
		{name: "upstream client id whitespace", mutate: func(c *FacadeConfig) { c.UpstreamClientID = "   " }, want: "upstream client id"},
		{name: "upstream issuer empty", mutate: func(c *FacadeConfig) { c.UpstreamIssuer = "" }, want: "upstream issuer"},
		{name: "upstream issuer not https", mutate: func(c *FacadeConfig) { c.UpstreamIssuer = "http://id.example.com" }, want: "upstream issuer"},
		{name: "upstream issuer with query", mutate: func(c *FacadeConfig) { c.UpstreamIssuer = "https://id.example.com?a=1" }, want: "upstream issuer"},
		{name: "empty lifecycle scope", mutate: func(c *FacadeConfig) { c.LifecycleScopes = []string{"offline_access", "  "} }, want: "lifecycle scope"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			config := completeFrontChannelConfig()
			testCase.mutate(&config)
			_, err := RegisterMCPFacade(apptheory.New(), config)
			require.Error(t, err)
			require.Contains(t, err.Error(), testCase.want)
		})
	}
}

func TestFrontChannelConfigRequiresEveryStore(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*oauthstore.Stores)
		want   string
	}{
		{name: "transaction", mutate: func(s *oauthstore.Stores) { s.Transaction = nil }, want: "Transaction"},
		{name: "authorization code", mutate: func(s *oauthstore.Stores) { s.AuthorizationCode = nil }, want: "AuthorizationCode"},
		{name: "client", mutate: func(s *oauthstore.Stores) { s.Client = nil }, want: "Client"},
		{name: "route refresh broker", mutate: func(s *oauthstore.Stores) { s.RouteRefreshBroker = nil }, want: "RouteRefreshBroker"},
		{name: "rate limit", mutate: func(s *oauthstore.Stores) { s.RateLimit = nil }, want: "RateLimit"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			config := completeFrontChannelConfig()
			testCase.mutate(&config.Stores)
			_, err := RegisterMCPFacade(apptheory.New(), config)
			require.Error(t, err)
			require.Contains(t, err.Error(), testCase.want)
			require.Contains(t, err.Error(), "all five stores")
		})
	}
}

func TestFrontChannelFieldSetFailsClosedWithoutProvider(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*FacadeConfig)
		want   string
	}{
		{name: "stores", mutate: func(c *FacadeConfig) { c.Stores = referenceStores() }, want: "Stores"},
		{name: "upstream client id", mutate: func(c *FacadeConfig) { c.UpstreamClientID = "mcp_x" }, want: "UpstreamClientID"},
		{name: "upstream issuer", mutate: func(c *FacadeConfig) { c.UpstreamIssuer = "https://id.example.com" }, want: "UpstreamIssuer"},
		{name: "lifecycle scopes", mutate: func(c *FacadeConfig) { c.LifecycleScopes = []string{"offline_access"} }, want: "LifecycleScopes"},
		{name: "provider hints", mutate: func(c *FacadeConfig) {
			c.ProviderHints = func(*apptheory.Context) (map[string]string, error) { return nil, nil }
		}, want: "ProviderHints"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			config := validConfig(URLModePublicBaseURL)
			testCase.mutate(&config)
			_, err := RegisterMCPFacade(apptheory.New(), config)
			require.Error(t, err)
			require.Contains(t, err.Error(), testCase.want)
			require.Contains(t, err.Error(), "without Provider")
		})
	}
}

func TestFrontChannelRejectsApplicationOwnedHandlerFactories(t *testing.T) {
	t.Run("authorize and token", func(t *testing.T) {
		config := completeFrontChannelConfig()
		config.AuthorizeHandler = kindHandlerFactory("authorize")
		config.TokenHandler = kindHandlerFactory("token")
		_, err := RegisterMCPFacade(apptheory.New(), config)
		require.Error(t, err)
		require.Contains(t, err.Error(), "AuthorizeHandler")
	})
	t.Run("register", func(t *testing.T) {
		config := completeFrontChannelConfig()
		config.RegisterHandler = kindHandlerFactory("register")
		_, err := RegisterMCPFacade(apptheory.New(), config)
		require.Error(t, err)
		require.Contains(t, err.Error(), "RegisterHandler")
	})
	t.Run("callback", func(t *testing.T) {
		config := completeFrontChannelConfig()
		config.CallbackHandler = func(*apptheory.Context) (*apptheory.Response, error) { return apptheory.NoContent(), nil }
		_, err := RegisterMCPFacade(apptheory.New(), config)
		require.Error(t, err)
		require.Contains(t, err.Error(), "CallbackHandler")
	})
}

func TestFrontChannelLifecycleScopesAreValidatedLikeScopes(t *testing.T) {
	config := completeFrontChannelConfig()
	config.LifecycleScopes = []string{"offline_access", "offline_access"}
	_, err := RegisterMCPFacade(apptheory.New(), config)
	require.NoError(t, err)

	config = completeFrontChannelConfig()
	config.LifecycleScopes = []string{strings.Repeat("a", 3)}
	_, err = RegisterMCPFacade(apptheory.New(), config)
	require.NoError(t, err)
}

// TestFrontChannelConfigIsValidatedBeforeAnyRouteIsRegistered proves the
// validation runs before registration: an invalid front-channel set leaves the
// application with no facade route at all, not a half-registered surface.
func TestFrontChannelConfigIsValidatedBeforeAnyRouteIsRegistered(t *testing.T) {
	app := apptheory.New()
	config := completeFrontChannelConfig()
	config.UpstreamIssuer = "http://id.example.com"
	_, err := RegisterMCPFacade(app, config)
	require.Error(t, err)

	resourcePath := mustPath(t, func() (string, error) {
		return mcproutes.EndpointPath{Kind: mcproutes.EndpointKindNamespace, ClientNamespace: "acme"}.ProtectedResourcePath()
	})
	response := serve(app, "GET", resourcePath, nil)
	require.Equal(t, 404, response.Status)
}

// TestNonePublicPostureRefusesTheFrontChannelAndItsRegisterRoute pins the mount
// rule of the RFC 7591 registration route: it belongs to the framework-owned
// front channel, and the none-public posture registers no OAuth surface at all,
// so a none-public config that declares a front channel is refused at
// registration time and leaves no register route mounted. The route therefore
// cannot be reached without transport authorization through a front channel.
func TestNonePublicPostureRefusesTheFrontChannelAndItsRegisterRoute(t *testing.T) {
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	config := completeFrontChannelConfig()
	config.TransportPosture = TransportPostureNonePublic

	inventory, err := RegisterMCPFacade(app, config)
	require.Nil(t, inventory)
	require.ErrorContains(t, err, "none-public registers no OAuth surface; the front-channel field set must not be configured")

	registerPath := mustPath(t, func() (string, error) {
		return mcproutes.EndpointPath{Kind: mcproutes.EndpointKindNamespace, ClientNamespace: "acme"}.OAuthRegisterPath()
	})
	require.Equal(t, 404, serve(app, "POST", registerPath, nil).Status)
}
