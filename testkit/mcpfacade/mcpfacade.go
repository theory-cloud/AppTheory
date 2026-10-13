// Package mcpfacade provides conformance-kit assertions for an application's
// MCP transport routes.
//
// The helpers implement Layer B of the MCP auth facade conformance kit
// (docs/development/planning/apptheory/mcp-auth-facade/CONFORMANCE_KIT.md): a
// credential-free request to a transport route is denied with the RFC 9728
// challenge and never reaches the application handler, a token that is missing a
// route-required scope is denied with the RFC 6750 insufficient_scope challenge
// and likewise never reaches it, while an accepted bearer token does reach it.
package mcpfacade

import (
	"context"
	"net/http"
	"sync"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
	"github.com/theory-cloud/apptheory/v6/testkit"
)

// Handler is a counting MCP transport handler. Every request is counted and
// answered with 204 No Content, so a test can prove whether a denied request
// reached the application handler.
type Handler struct {
	mu          sync.Mutex
	invocations int
}

// NewHandler returns a counting MCP transport handler.
func NewHandler() *Handler {
	return &Handler{}
}

// Invocations reports how many requests reached the handler.
func (h *Handler) Invocations() int {
	if h == nil {
		return 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.invocations
}

// Handle is the apptheory.Handler to mount on the transport routes. Every call
// is counted and answered with 204 No Content.
func (h *Handler) Handle(*apptheory.Context) (*apptheory.Response, error) {
	h.mu.Lock()
	h.invocations++
	h.mu.Unlock()
	return apptheory.NoContent(), nil
}

// AssertCredentialFreeDenied drives a credential-free API Gateway v2 request to
// method path through env and asserts the RFC 9728 denial: HTTP 401, the exact
// WWW-Authenticate challenge for resourceMetadataURL, and no invocation of the
// application handler.
func AssertCredentialFreeDenied(tb testing.TB, env *testkit.Env, app *apptheory.App, method, path, resourceMetadataURL string, handler *Handler) {
	tb.Helper()
	response := invokeTransport(tb, env, app, method, path, nil)
	if response.StatusCode != http.StatusUnauthorized {
		tb.Fatalf("credential-free %s %s: status = %d, want 401", method, path, response.StatusCode)
	}
	expected := oauth.ProtectedResourceWWWAuthenticate(resourceMetadataURL)
	if got := response.Headers["www-authenticate"]; got != expected {
		tb.Fatalf("credential-free %s %s: www-authenticate = %q, want %q", method, path, got, expected)
	}
	if got := handler.Invocations(); got != 0 {
		tb.Fatalf("credential-free %s %s: MCP handler invoked %d times, want 0", method, path, got)
	}
}

// AssertBearerTokenReachesHandler is the positive control for
// AssertCredentialFreeDenied: a request carrying token reaches the handler
// exactly once, proving the denial is not "always deny".
func AssertBearerTokenReachesHandler(tb testing.TB, env *testkit.Env, app *apptheory.App, method, path, token string, handler *Handler) {
	tb.Helper()
	before := handler.Invocations()
	response := invokeTransport(tb, env, app, method, path, map[string]string{"authorization": "Bearer " + token})
	if response.StatusCode != http.StatusNoContent {
		tb.Fatalf("bearer %s %s: status = %d, want 204", method, path, response.StatusCode)
	}
	if got := handler.Invocations(); got != before+1 {
		tb.Fatalf("bearer %s %s: MCP handler invocations = %d, want %d", method, path, got, before+1)
	}
}

// AssertInsufficientScopeRemediation drives a bearer request to method path
// through env and asserts the RFC 6750 insufficient_scope denial for a token
// that is otherwise valid: HTTP 403 with the exact WWW-Authenticate challenge
// expectedChallenge, and no invocation of the application handler.
//
// expectedChallenge is compared verbatim, so a caller passes the challenge the
// matched route's scope map produces, for example
// `Bearer error="insufficient_scope", scope="namespace:use", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp"`.
func AssertInsufficientScopeRemediation(tb testing.TB, env *testkit.Env, app *apptheory.App, method, path, token, expectedChallenge string, handler *Handler) {
	tb.Helper()
	before := handler.Invocations()
	response := invokeTransport(tb, env, app, method, path, map[string]string{"authorization": "Bearer " + token})
	if response.StatusCode != http.StatusForbidden {
		tb.Fatalf("insufficient-scope %s %s: status = %d, want 403", method, path, response.StatusCode)
	}
	if got := response.Headers["www-authenticate"]; got != expectedChallenge {
		tb.Fatalf("insufficient-scope %s %s: www-authenticate = %q, want %q", method, path, got, expectedChallenge)
	}
	if got := handler.Invocations(); got != before {
		tb.Fatalf("insufficient-scope %s %s: MCP handler invoked %d times, want 0 additional invocations", method, path, got-before)
	}
}

func invokeTransport(tb testing.TB, env *testkit.Env, app *apptheory.App, method, path string, headers map[string]string) events.APIGatewayV2HTTPResponse {
	tb.Helper()
	if env == nil {
		tb.Fatal("mcpfacade: env is required")
	}
	if app == nil {
		tb.Fatal("mcpfacade: app is required")
	}
	return env.InvokeAPIGatewayV2(context.Background(), app, events.APIGatewayV2HTTPRequest{
		RawPath: path,
		Headers: headers,
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			Stage: "$default",
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method: method,
				Path:   path,
			},
		},
	})
}
