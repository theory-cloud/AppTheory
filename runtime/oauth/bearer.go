package oauth

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

// ContextKeyBearerToken is set on apptheory.Context by RequireBearerTokenMiddleware.
const ContextKeyBearerToken = "oauth.bearer_token" //nolint:gosec // context key, not a credential

// ContextKeyBearerClaims is set on apptheory.Context when a claims validator is configured.
const ContextKeyBearerClaims = "oauth.bearer_claims" //nolint:gosec // context key, not a credential

// BearerTokenValidator validates a Bearer access token.
//
// Implementations can perform JWT verification using a JWKS, introspection,
// or any other mechanism suitable for the deployment.
type BearerTokenValidator func(ctx context.Context, token string) error

// BearerTokenClaimsValidator validates a Bearer access token and returns safe,
// non-secret claims for downstream handlers.
type BearerTokenClaimsValidator func(ctx context.Context, token string) (*BearerTokenClaims, error)

// BearerTokenClaims is the deterministic, local claim shape AppTheory uses for
// contract-pinned bearer validation. Token is intentionally not included so the
// safe context value cannot leak credentials.
type BearerTokenClaims struct {
	Subject   string
	Audience  string
	Scopes    []string
	ExpiresAt time.Time
}

// BearerTokenRecord seeds a deterministic in-memory bearer-token validator.
type BearerTokenRecord struct {
	Token     string
	Subject   string
	Audience  string
	Scope     string
	Scopes    []string
	ExpiresAt time.Time
}

// BearerTokenValidationOptions configures NewMemoryBearerTokenValidator.
type BearerTokenValidationOptions struct {
	RequiredAudience string
	RequiredScopes   []string
	Now              func() time.Time
}

// RequireBearerTokenOptions configures RequireBearerTokenMiddleware.
type RequireBearerTokenOptions struct {
	// ResourceMetadataURL is used to build the RFC9728 discovery challenge.
	//
	// If empty, the middleware attempts to derive it from MCP_ENDPOINT only.
	ResourceMetadataURL string

	// Validator is called for every request. If it is omitted, or if it returns
	// an error, the request is rejected with 401.
	Validator BearerTokenValidator

	// ClaimsValidator is preferred for new code because it can distinguish
	// unauthorized token failures from forbidden audience/scope failures and
	// expose safe claims to downstream handlers.
	ClaimsValidator BearerTokenClaimsValidator
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
			if opts.ClaimsValidator != nil {
				claims, err := opts.ClaimsValidator(c.Context(), token)
				if err != nil {
					return bearerErrorResponse(c, opts, err), nil
				}
				c.Set(ContextKeyBearerToken, token)
				if claims != nil {
					c.Set(ContextKeyBearerClaims, *claims)
				}
				return next(c)
			}
			if opts.Validator == nil {
				return unauthorizedResponse(c, opts), nil
			}
			if err := opts.Validator(c.Context(), token); err != nil {
				return bearerErrorResponse(c, opts, err), nil
			}

			c.Set(ContextKeyBearerToken, token)
			return next(c)
		}
	}
}

// NewMemoryBearerTokenValidator returns a deterministic local bearer validator
// over the provided token records.
func NewMemoryBearerTokenValidator(records []BearerTokenRecord, opts BearerTokenValidationOptions) BearerTokenClaimsValidator {
	byToken := make(map[string]BearerTokenClaims, len(records))
	for _, rec := range records {
		token := strings.TrimSpace(rec.Token)
		if token == "" {
			continue
		}
		scopes := append([]string(nil), rec.Scopes...)
		if len(scopes) == 0 {
			scopes = scopeFields(rec.Scope)
		}
		byToken[token] = BearerTokenClaims{
			Subject:   strings.TrimSpace(rec.Subject),
			Audience:  strings.TrimSpace(rec.Audience),
			Scopes:    scopes,
			ExpiresAt: rec.ExpiresAt,
		}
	}
	requiredAudience := strings.TrimSpace(opts.RequiredAudience)
	requiredScopes := append([]string(nil), opts.RequiredScopes...)
	now := opts.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return func(_ context.Context, token string) (*BearerTokenClaims, error) {
		claims, ok := byToken[strings.TrimSpace(token)]
		if !ok {
			return nil, ErrInvalidBearerToken
		}
		if !claims.ExpiresAt.IsZero() && !now().Before(claims.ExpiresAt) {
			return nil, ErrBearerTokenExpired
		}
		if requiredAudience != "" && claims.Audience != requiredAudience {
			return nil, ErrBearerTokenInvalidAudience
		}
		if missing := missingScopes(claims.Scopes, requiredScopes); len(missing) > 0 {
			return nil, ErrBearerTokenInsufficientScope
		}
		out := claims
		out.Scopes = append([]string(nil), claims.Scopes...)
		return &out, nil
	}
}

// BearerTokenClaimsFromContext returns safe bearer claims set by
// RequireBearerTokenMiddleware when ClaimsValidator is configured.
func BearerTokenClaimsFromContext(c *apptheory.Context) (BearerTokenClaims, bool) {
	if c == nil {
		return BearerTokenClaims{}, false
	}
	value := c.Get(ContextKeyBearerClaims)
	switch v := value.(type) {
	case BearerTokenClaims:
		v.Scopes = append([]string(nil), v.Scopes...)
		return v, true
	case *BearerTokenClaims:
		if v == nil {
			return BearerTokenClaims{}, false
		}
		out := *v
		out.Scopes = append([]string(nil), v.Scopes...)
		return out, true
	default:
		return BearerTokenClaims{}, false
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
		mcpEndpoint := os.Getenv("MCP_ENDPOINT")
		if resolved, ok := resolveAbsoluteURLPathTemplate(mcpEndpoint, c.Request.Path, c.Params); ok {
			mcpEndpoint = resolved
		}
		if derived, ok := ResourceMetadataURLFromMcpEndpoint(mcpEndpoint); ok {
			metaURL = derived
		}
	}

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
		Body:    []byte(`{"error":{"code":"app.unauthorized","message":"unauthorized"}}`),
	}
}

func forbiddenResponse() *apptheory.Response {
	return &apptheory.Response{
		Status: 403,
		Headers: map[string][]string{
			"content-type": {"application/json; charset=utf-8"},
		},
		Body: []byte(`{"error":{"code":"app.forbidden","message":"forbidden"}}`),
	}
}

func bearerErrorResponse(c *apptheory.Context, opts RequireBearerTokenOptions, err error) *apptheory.Response {
	if errors.Is(err, ErrBearerTokenInvalidAudience) || errors.Is(err, ErrBearerTokenInsufficientScope) {
		return forbiddenResponse()
	}
	return unauthorizedResponse(c, opts)
}

func scopeFields(scope string) []string {
	fields := strings.Fields(scope)
	if len(fields) == 0 {
		return nil
	}
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		if field = strings.TrimSpace(field); field != "" {
			out = append(out, field)
		}
	}
	return out
}

func missingScopes(got []string, required []string) []string {
	if len(required) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(got))
	for _, scope := range got {
		scope = strings.TrimSpace(scope)
		if scope != "" {
			seen[scope] = true
		}
	}
	var missing []string
	for _, scope := range required {
		scope = strings.TrimSpace(scope)
		if scope != "" && !seen[scope] {
			missing = append(missing, scope)
		}
	}
	return missing
}
