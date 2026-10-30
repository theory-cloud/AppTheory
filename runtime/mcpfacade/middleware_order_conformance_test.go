package mcpfacade

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/mcproutes"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
)

// middlewareOrderGroup names the runtime-bearer ordering group the shared
// facade-conformance table carries. The same rows drive the Go, TypeScript, and
// Python loaders.
const middlewareOrderGroup = "middleware_order"

// middlewareOrderCaseCount is the number of middleware_order rows the shared
// table must carry. A row added to the table must also be a deliberate edit in
// the TypeScript and Python loaders, so no runtime can silently execute a
// smaller table.
const middlewareOrderCaseCount = 16

const middlewareOrderFixture = "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-middleware-order.v1.json"

type middlewareOrderMount struct {
	IssuerURL           string              `json:"issuer_url"`
	JWKSURI             string              `json:"jwks_uri"`
	PublicBaseURL       string              `json:"public_base_url"`
	ClientNamespace     string              `json:"client_namespace"`
	ResourceMetadataURL string              `json:"resource_metadata_url"`
	ValidToken          string              `json:"valid_token"`
	InvalidToken        string              `json:"invalid_token"`
	Subject             string              `json:"subject"`
	Audience            string              `json:"audience"`
	Scopes              map[string][]string `json:"scopes"`
}

type middlewareOrderExpectation struct {
	Status                int      `json:"status"`
	WWWAuthenticate       string   `json:"www_authenticate"`
	Order                 []string `json:"order"`
	MiddlewareInvocations int      `json:"middleware_invocations"`
	CacheLookups          int      `json:"cache_lookups"`
	MiddlewareWrites      int      `json:"middleware_writes"`
	HandlerInvocations    int      `json:"handler_invocations"`
	PolicyHookInvocations int      `json:"policy_hook_invocations"`
	Body                  string   `json:"body"`
}

type middlewareOrderCase struct {
	ID         string                     `json:"id"`
	Group      string                     `json:"group"`
	Surface    string                     `json:"surface"`
	Tier       string                     `json:"tier"`
	Methods    []string                   `json:"methods"`
	Credential string                     `json:"credential"`
	Middleware string                     `json:"middleware"`
	Policy     string                     `json:"policy"`
	Expect     middlewareOrderExpectation `json:"expect"`
}

type middlewareOrderDocument struct {
	Mount middlewareOrderMount `json:"mount"`
	Cases []json.RawMessage    `json:"cases"`
}

type middlewareOrderRecorder struct {
	order                 []string
	middlewareInvocations int
	cacheLookups          int
	middlewareWrites      int
	handlerInvocations    int
	policyInvocations     int
}

func (r *middlewareOrderRecorder) record(name string) {
	r.order = append(r.order, name)
}

func middlewareOrderMiddleware(name string, recorder *middlewareOrderRecorder) apptheory.Middleware {
	switch name {
	case "short_circuit_cache":
		return func(next apptheory.Handler) apptheory.Handler {
			return func(*apptheory.Context) (*apptheory.Response, error) {
				recorder.middlewareInvocations++
				recorder.cacheLookups++
				recorder.record("middleware")
				return apptheory.Text(200, "cached-protected"), nil
			}
		}
	case "pass_through_writer":
		return func(next apptheory.Handler) apptheory.Handler {
			return func(ctx *apptheory.Context) (*apptheory.Response, error) {
				recorder.middlewareInvocations++
				recorder.middlewareWrites++
				recorder.record("middleware")
				return next(ctx)
			}
		}
	default:
		panic("unknown middleware_order middleware: " + name)
	}
}

func loadMiddlewareOrderCases(t *testing.T) (middlewareOrderMount, []middlewareOrderCase) {
	t.Helper()
	raw, err := os.ReadFile(middlewareOrderFixture)
	require.NoError(t, err)
	var document middlewareOrderDocument
	require.NoError(t, json.Unmarshal(raw, &document))

	cases := make([]middlewareOrderCase, 0, middlewareOrderCaseCount)
	seen := make(map[string]struct{}, middlewareOrderCaseCount)
	for _, rawCase := range document.Cases {
		var group struct {
			Group string `json:"group"`
		}
		require.NoError(t, json.Unmarshal(rawCase, &group))
		if group.Group != middlewareOrderGroup {
			continue
		}
		var candidate middlewareOrderCase
		require.NoError(t, json.Unmarshal(rawCase, &candidate))
		require.NotEmpty(t, candidate.ID)
		_, duplicate := seen[candidate.ID]
		require.False(t, duplicate, "duplicate middleware_order case %q", candidate.ID)
		seen[candidate.ID] = struct{}{}
		cases = append(cases, candidate)
	}
	require.Len(t, cases, middlewareOrderCaseCount)
	return document.Mount, cases
}

func middlewareOrderTier(value string) apptheory.Tier {
	switch value {
	case "p0":
		return apptheory.TierP0
	case "p1":
		return apptheory.TierP1
	default:
		return apptheory.TierP2
	}
}

func middlewareOrderHeaders(mount middlewareOrderMount, credential string) map[string][]string {
	switch credential {
	case "missing":
		return nil
	case "invalid":
		return map[string][]string{"authorization": {"Bearer " + mount.InvalidToken}}
	case "valid":
		return map[string][]string{"authorization": {"Bearer " + mount.ValidToken}}
	default:
		panic("unknown middleware_order credential: " + credential)
	}
}

func TestMiddlewareOrderConformance(t *testing.T) {
	t.Parallel()
	mount, cases := loadMiddlewareOrderCases(t)
	route := mcproutes.EndpointPath{Kind: mcproutes.EndpointKindNamespace, ClientNamespace: mount.ClientNamespace}
	path := mustPath(t, route.MCPPath)

	for _, testCase := range cases {
		t.Run(testCase.ID, func(t *testing.T) {
			for _, method := range testCase.Methods {
				t.Run(method, func(t *testing.T) {
					recorder := &middlewareOrderRecorder{order: []string{}}
					claimsValidator := func(_ *apptheory.Context, token string) (*oauth.BearerTokenClaims, error) {
						recorder.record("bearer")
						if token != mount.ValidToken {
							return nil, oauth.ErrInvalidBearerToken
						}
						return &oauth.BearerTokenClaims{
							Subject:  mount.Subject,
							Audience: mount.Audience,
							Scopes:   append([]string(nil), mount.Scopes["namespace"]...),
						}, nil
					}
					config := validConfig(URLModePublicBaseURL)
					config.TransportPosture = TransportPostureRuntimeBearer
					config.RequireBearerToken = &oauth.RequireBearerTokenOptions{
						ResourceMetadataURL: mount.ResourceMetadataURL,
						ClaimsValidator:     claimsValidator,
					}
					config.MCPHandler = func(*apptheory.Context) (*apptheory.Response, error) {
						recorder.handlerInvocations++
						recorder.record("handler")
						return apptheory.NoContent(), nil
					}

					var policy apptheory.PolicyHook
					switch testCase.Policy {
					case "allow":
						policy = func(*apptheory.Context) (*apptheory.PolicyDecision, error) {
							recorder.policyInvocations++
							recorder.record("policy")
							return nil, nil
						}
					case "deny":
						policy = func(*apptheory.Context) (*apptheory.PolicyDecision, error) {
							recorder.policyInvocations++
							recorder.record("policy")
							return &apptheory.PolicyDecision{Code: "app.rate_limited"}, nil
						}
					}

					var surface interface {
						Serve(context.Context, apptheory.Request) apptheory.Response
					}
					switch testCase.Surface {
					case "plain":
						app := apptheory.New(apptheory.WithTier(middlewareOrderTier(testCase.Tier)))
						app.Use(middlewareOrderMiddleware(testCase.Middleware, recorder))
						_, err := RegisterMCPFacade(app, config)
						require.NoError(t, err)
						surface = app
					case "secure":
						secure := apptheory.NewSecure(apptheory.SecureOptions{
							Tier:       middlewareOrderTier(testCase.Tier),
							PolicyHook: policy,
						})
						secure.Use(middlewareOrderMiddleware(testCase.Middleware, recorder))
						_, err := RegisterMCPFacadeSecure(secure, config)
						require.NoError(t, err)
						surface = secure
					default:
						t.Fatalf("unknown middleware_order surface %q", testCase.Surface)
					}

					response := surface.Serve(context.Background(), apptheory.Request{
						Method:  method,
						Path:    path,
						Headers: middlewareOrderHeaders(mount, testCase.Credential),
					})

					require.Equal(t, testCase.Expect.Status, response.Status)
					if testCase.Expect.WWWAuthenticate != "" {
						require.Equal(t, []string{testCase.Expect.WWWAuthenticate}, response.Headers["www-authenticate"])
					}
					require.Equal(t, testCase.Expect.Order, recorder.order)
					require.Equal(t, testCase.Expect.MiddlewareInvocations, recorder.middlewareInvocations)
					require.Equal(t, testCase.Expect.CacheLookups, recorder.cacheLookups)
					require.Equal(t, testCase.Expect.MiddlewareWrites, recorder.middlewareWrites)
					require.Equal(t, testCase.Expect.HandlerInvocations, recorder.handlerInvocations)
					require.Equal(t, testCase.Expect.PolicyHookInvocations, recorder.policyInvocations)
					if testCase.Expect.Body != "" {
						require.Equal(t, testCase.Expect.Body, string(response.Body))
					}
				})
			}
		})
	}
}
