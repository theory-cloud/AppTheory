package oauth

import (
	"fmt"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"

	"github.com/stretchr/testify/require"
)

// resourceMetadataTemplateFixture mirrors the shared `resource_metadata_template`
// section of contract-tests/fixtures/routing/mcp-auth-facade/route-challenge.v1.json.
type resourceMetadataTemplateFixture struct {
	ResourceMetadataTemplate struct {
		Notes           string                              `json:"notes"`
		ValueRule       string                              `json:"value_rule"`
		Template        string                              `json:"template"`
		Accept          []resourceMetadataTemplateAcceptRow `json:"accept"`
		RefusedTemplate []struct {
			Template string `json:"template"`
		} `json:"refused_template"`
		RefusedValue []struct {
			Params map[string]string `json:"params"`
		} `json:"refused_value"`
		MissingParam []struct {
			Params map[string]string `json:"params"`
		} `json:"missing_param"`
		Precedence struct {
			FuncWins struct {
				ResourceMetadataURLFunc string            `json:"resource_metadata_url_func"`
				Template                string            `json:"template"`
				ResourceMetadataURL     string            `json:"resource_metadata_url"`
				Params                  map[string]string `json:"params"`
				ExpectURL               string            `json:"expect_url"`
			} `json:"func_wins"`
			TemplateWins struct {
				Template            string            `json:"template"`
				ResourceMetadataURL string            `json:"resource_metadata_url"`
				Params              map[string]string `json:"params"`
				ExpectURL           string            `json:"expect_url"`
			} `json:"template_wins"`
		} `json:"precedence"`
	} `json:"resource_metadata_template"`
}

type resourceMetadataTemplateAcceptRow struct {
	Template  string            `json:"template"`
	Params    map[string]string `json:"params"`
	ExpectURL string            `json:"expect_url"`
}

func loadResourceMetadataTemplateFixture(t *testing.T) resourceMetadataTemplateFixture {
	t.Helper()
	var fixture resourceMetadataTemplateFixture
	loadMCPAuthFacadeFixture(t, "route-challenge.v1.json", &fixture)
	require.NotEmpty(t, fixture.ResourceMetadataTemplate.Notes)
	require.NotEmpty(t, fixture.ResourceMetadataTemplate.ValueRule)
	require.NotEmpty(t, fixture.ResourceMetadataTemplate.Template)
	require.NotEmpty(t, fixture.ResourceMetadataTemplate.Accept)
	require.NotEmpty(t, fixture.ResourceMetadataTemplate.RefusedTemplate)
	require.NotEmpty(t, fixture.ResourceMetadataTemplate.RefusedValue)
	require.NotEmpty(t, fixture.ResourceMetadataTemplate.MissingParam)
	return fixture
}

// challengeHeaderFor drives the real middleware for one credential-free request
// whose matched route supplies params, and returns the WWW-Authenticate value.
func challengeHeaderFor(t *testing.T, opts RequireBearerTokenOptions, params map[string]string) string {
	t.Helper()
	handler := RequireBearerTokenMiddleware(opts)(func(*apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{Status: 200}, nil
	})
	resp, err := handler(&apptheory.Context{
		Params: params,
		Request: apptheory.Request{
			Path:    "/mcp/alpha",
			Headers: map[string][]string{"host": {"api.example.com"}, "x-forwarded-proto": {"https"}},
		},
	})
	require.NoError(t, err)
	require.Equal(t, 401, resp.Status)
	headers := resp.Headers["www-authenticate"]
	require.Len(t, headers, 1)
	return headers[0]
}

// requireRegistrationPanic runs fn and returns the recovered panic message.
func requireRegistrationPanic(t *testing.T, fn func()) string {
	t.Helper()
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		fn()
	}()
	require.NotNil(t, recovered, "a malformed template must fail at registration")
	message, ok := recovered.(string)
	require.True(t, ok, "the registration failure must carry a string message")
	return message
}

// TestRequireBearerTokenMiddlewareResolvesRouteParameterTemplate pins the
// first-class per-actor seam: with no hand-rolled resolver, a `{param}` template
// produces the matched route's own RFC 9728 metadata URL.
func TestRequireBearerTokenMiddlewareResolvesRouteParameterTemplate(t *testing.T) {
	t.Parallel()
	fixture := loadResourceMetadataTemplateFixture(t)

	for i, row := range fixture.ResourceMetadataTemplate.Accept {
		t.Run(fmt.Sprintf("accept/%d", i), func(t *testing.T) {
			got := challengeHeaderFor(t, RequireBearerTokenOptions{ResourceMetadataURLTemplate: row.Template}, row.Params)
			require.Equal(t, ProtectedResourceWWWAuthenticate(row.ExpectURL), got)
			require.NotContains(t, got, "{", "a literal placeholder must never be advertised")
		})
	}
}

// TestRequireBearerTokenMiddlewareRefusesUnsafeTemplateValues pins the value
// rule: a placeholder the matched route does not supply, or a value outside the
// pinned alphabet, degrades to the bare `Bearer` challenge rather than
// interpolating attacker-controlled path input.
func TestRequireBearerTokenMiddlewareRefusesUnsafeTemplateValues(t *testing.T) {
	t.Parallel()
	fixture := loadResourceMetadataTemplateFixture(t)
	template := fixture.ResourceMetadataTemplate.Template

	for i, row := range fixture.ResourceMetadataTemplate.RefusedValue {
		t.Run(fmt.Sprintf("refused_value/%d", i), func(t *testing.T) {
			got := challengeHeaderFor(t, RequireBearerTokenOptions{ResourceMetadataURLTemplate: template}, row.Params)
			require.Equal(t, "Bearer", got)
		})
	}
	for i, row := range fixture.ResourceMetadataTemplate.MissingParam {
		t.Run(fmt.Sprintf("missing_param/%d", i), func(t *testing.T) {
			got := challengeHeaderFor(t, RequireBearerTokenOptions{ResourceMetadataURLTemplate: template}, row.Params)
			require.Equal(t, "Bearer", got)
		})
	}
}

// TestRequireBearerTokenMiddlewarePanicsOnMalformedTemplate pins the
// registration-time error path: a malformed template fails closed at startup and
// never becomes an advertised discovery URL.
func TestRequireBearerTokenMiddlewarePanicsOnMalformedTemplate(t *testing.T) {
	t.Parallel()
	fixture := loadResourceMetadataTemplateFixture(t)

	for i, row := range fixture.ResourceMetadataTemplate.RefusedTemplate {
		t.Run(fmt.Sprintf("refused_template/%d", i), func(t *testing.T) {
			message := requireRegistrationPanic(t, func() {
				RequireBearerTokenMiddleware(RequireBearerTokenOptions{ResourceMetadataURLTemplate: row.Template})
			})
			require.Contains(t, message, "invalid ResourceMetadataURLTemplate")
		})
	}
}

// TestRequireBearerTokenMiddlewareTemplatePrecedence pins the option precedence
// recorded in the shared fixture.
func TestRequireBearerTokenMiddlewareTemplatePrecedence(t *testing.T) {
	t.Parallel()
	fixture := loadResourceMetadataTemplateFixture(t)
	precedence := fixture.ResourceMetadataTemplate.Precedence

	funcWins := precedence.FuncWins
	got := challengeHeaderFor(t, RequireBearerTokenOptions{
		ResourceMetadataURL: funcWins.ResourceMetadataURL,
		ResourceMetadataURLFunc: func(*apptheory.Context) (string, error) {
			return funcWins.ResourceMetadataURLFunc, nil
		},
		ResourceMetadataURLTemplate: funcWins.Template,
	}, funcWins.Params)
	require.Equal(t, ProtectedResourceWWWAuthenticate(funcWins.ExpectURL), got)

	templateWins := precedence.TemplateWins
	got = challengeHeaderFor(t, RequireBearerTokenOptions{
		ResourceMetadataURL:         templateWins.ResourceMetadataURL,
		ResourceMetadataURLTemplate: templateWins.Template,
	}, templateWins.Params)
	require.Equal(t, ProtectedResourceWWWAuthenticate(templateWins.ExpectURL), got)
}
