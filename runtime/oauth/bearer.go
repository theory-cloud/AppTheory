package oauth

import (
	"context"
	"os"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

// ContextKeyBearerToken is set on apptheory.Context by RequireBearerTokenMiddleware.
const ContextKeyBearerToken = "oauth.bearer_token" //nolint:gosec // context key, not a credential

// BearerTokenValidator validates a Bearer access token.
//
// Implementations can perform JWT verification using a JWKS, introspection,
// or any other mechanism suitable for the deployment.
type BearerTokenValidator func(ctx context.Context, token string) error

// RequireBearerTokenOptions configures RequireBearerTokenMiddleware.
type RequireBearerTokenOptions struct {
	// ResourceMetadataURL is used to build the RFC9728 discovery challenge.
	//
	// If empty, the middleware attempts to derive it from MCP_ENDPOINT, and then
	// from request headers (Host + X-Forwarded-Proto) as a last resort.
	ResourceMetadataURL string

	// Validator, when provided, is called for every request. If it returns an
	// error the request is rejected with 401.
	Validator BearerTokenValidator
}

// RequireBearerTokenMiddleware enforces `Authorization: Bearer <token>` and,
// when missing/invalid, returns 401 with the MCP 2025-06-18 compatible
// WWW-Authenticate challenge that points to protected resource metadata.
func RequireBearerTokenMiddleware(opts RequireBearerTokenOptions) apptheory.Middleware {
	return func(next apptheory.Handler) apptheory.Handler {
		return func(c *apptheory.Context) (*apptheory.Response, error) {
			token, err := BearerTokenFromHeaders(c.Request.Headers)
			if err != nil {
				return unauthorizedResponse(c, opts), nil
			}
			if opts.Validator != nil {
				if err := opts.Validator(c.Context(), token); err != nil {
					return unauthorizedResponse(c, opts), nil
				}
			}

			c.Set(ContextKeyBearerToken, token)
			return next(c)
		}
	}
}

// BearerTokenFromHeaders extracts the bearer token from normalized headers.
func BearerTokenFromHeaders(headers map[string][]string) (string, error) {
	auth := firstHeader(headers, "authorization")
	auth = strings.TrimSpace(auth)
	if auth == "" {
		return "", ErrMissingBearerToken
	}
	scheme, rest, ok := strings.Cut(auth, " ")
	if !ok || !strings.EqualFold(strings.TrimSpace(scheme), "bearer") {
		return "", ErrInvalidAuthorizationHeader
	}
	token := strings.TrimSpace(rest)
	if token == "" {
		return "", ErrInvalidAuthorizationHeader
	}
	return token, nil
}

func unauthorizedResponse(c *apptheory.Context, opts RequireBearerTokenOptions) *apptheory.Response {
	metaURL := strings.TrimSpace(opts.ResourceMetadataURL)
	if metaURL == "" {
		if derived, ok := ResourceMetadataURLFromMcpEndpoint(os.Getenv("MCP_ENDPOINT")); ok {
			metaURL = derived
		} else if derived, ok := ProtectedResourceMetadataURLForRequest(c.Request.Headers); ok {
			metaURL = derived
		}
	}

	body := []byte(`{"error":"unauthorized"}`)

	headers := map[string][]string{
		"content-type": {"application/json; charset=utf-8"},
	}
	// Only include resource_metadata when we have a URL; it is required for
	// MCP auth (2025-06-18) discovery, but callers can also provide it via opts.
	if metaURL != "" {
		headers["www-authenticate"] = []string{ProtectedResourceWWWAuthenticate(metaURL)}
	} else {
		headers["www-authenticate"] = []string{"Bearer"}
	}

	return &apptheory.Response{
		Status:  401,
		Headers: headers,
		Body:    body,
	}
}
