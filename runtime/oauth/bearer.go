package oauth

import (
	"errors"
	"fmt"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
)

// ContextKeyBearerToken is set on apptheory.Context by RequireBearerTokenMiddleware.
const ContextKeyBearerToken = "oauth.bearer_token" //nolint:gosec // context key, not a credential

// ContextKeyBearerClaims is set on apptheory.Context when a claims validator is configured.
const ContextKeyBearerClaims = "oauth.bearer_claims" //nolint:gosec // context key, not a credential

// BearerTokenValidator validates a Bearer access token.
//
// The validator receives the route-aware AppTheory context, so a validator can
// derive the expected issuer, audience, and scope set from the matched route
// instead of a process-global value.
type BearerTokenValidator func(ctx *apptheory.Context, token string) error

// BearerTokenClaimsValidator validates a Bearer access token and returns safe,
// non-secret claims for downstream handlers.
type BearerTokenClaimsValidator func(ctx *apptheory.Context, token string) (*BearerTokenClaims, error)

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
	// RequiredAudienceFunc returns the route-derived audience the token must be
	// bound to. When set it takes precedence over RequiredAudience, so audience
	// can be the exact matched route URL.
	RequiredAudienceFunc func(*apptheory.Context) (string, error)
	// RequiredScopesFunc returns the route-derived scope set the token must
	// carry. When set it takes precedence over RequiredScopes.
	RequiredScopesFunc func(*apptheory.Context) ([]string, error)
	Now                func() time.Time
}

// RequireBearerTokenOptions configures RequireBearerTokenMiddleware.
type RequireBearerTokenOptions struct {
	// ResourceMetadataURL is used to build the RFC9728 discovery challenge.
	//
	// The middleware reads no environment variable. When this and
	// ResourceMetadataURLFunc are both empty the challenge is the bare
	// `Bearer` form with no resource_metadata parameter, so a missing
	// configuration fails closed to an unadvertised discovery endpoint rather
	// than to a value an injected MCP_ENDPOINT could influence.
	ResourceMetadataURL string

	// ResourceMetadataURLFunc returns the route-derived protected-resource
	// metadata URL for the matched route. When set it takes precedence over
	// ResourceMetadataURLTemplate and ResourceMetadataURL, so the challenge is
	// route-derived rather than family-wide.
	ResourceMetadataURLFunc func(*apptheory.Context) (string, error)

	// ResourceMetadataURLTemplate is an absolute HTTPS URL template whose
	// `{param}` placeholders are interpolated from the matched route's path
	// parameters, so a per-actor route (`/mcp/{actor}`) advertises that actor's
	// own RFC 9728 metadata URL with no hand-rolled resolver. It is explicit
	// application configuration: the middleware reads no environment variable.
	//
	// Pass the CDK construct's route-derived template straight through, for
	// example `AppTheoryRemoteMcpServer.protectedResourceMetadataUrl` on the
	// adopter's own configuration surface.
	//
	// The template is validated when the middleware is constructed — it must be
	// an absolute HTTPS URL with no userinfo, query, fragment, or percent
	// escape, and its placeholders must appear in the path and name route
	// parameters. A malformed template panics at registration rather than
	// advertising a broken discovery URL, so a bad template fails closed at
	// startup instead of at request time.
	//
	// At request time a placeholder that the matched route does not supply, or
	// whose value is not a safe single path segment (see
	// isSafeResourceMetadataURLTemplateValue), makes the middleware emit the
	// bare `Bearer` challenge. It never advertises a literal placeholder.
	//
	// When set it takes precedence over ResourceMetadataURL; ResourceMetadataURLFunc
	// still takes precedence over it.
	ResourceMetadataURLTemplate string

	// Validator is called for every request. If it is omitted, or if it returns
	// an error, the request is rejected with 401.
	Validator BearerTokenValidator

	// ClaimsValidator is preferred for new code because it can distinguish
	// unauthorized token failures from forbidden audience/scope failures and
	// expose safe claims to downstream handlers.
	ClaimsValidator BearerTokenClaimsValidator

	// RequiredScopesFunc returns the route-derived scope set used to build the
	// 403 insufficient_scope remediation challenge. It is consulted only when a
	// validator reports ErrBearerTokenInsufficientScope.
	RequiredScopesFunc func(*apptheory.Context) ([]string, error)

	// resourceMetadataURLTemplate is the compiled ResourceMetadataURLTemplate.
	// It is nil when no template is configured.
	resourceMetadataURLTemplate *resourceMetadataURLTemplate
}

// RequireBearerTokenMiddleware enforces `Authorization: Bearer <token>` and,
// when missing/invalid, returns 401 with the MCP 2025-06-18 compatible
// WWW-Authenticate challenge that points to protected resource metadata.
//
// A ResourceMetadataURLTemplate is compiled here, at registration, and a
// malformed template panics: the middleware never serves a request whose
// challenge would advertise a broken or partially resolved discovery URL.
func RequireBearerTokenMiddleware(opts RequireBearerTokenOptions) apptheory.Middleware {
	if strings.TrimSpace(opts.ResourceMetadataURLTemplate) != "" {
		compiled, err := compileResourceMetadataURLTemplate(opts.ResourceMetadataURLTemplate)
		if err != nil {
			panic(fmt.Sprintf("oauth: invalid ResourceMetadataURLTemplate: %v", err))
		}
		opts.resourceMetadataURLTemplate = compiled
	}
	return func(next apptheory.Handler) apptheory.Handler {
		return func(c *apptheory.Context) (*apptheory.Response, error) {
			token, err := BearerTokenFromHeaders(c.Request.Headers)
			if err != nil {
				return unauthorizedResponse(c, opts), nil
			}
			if opts.ClaimsValidator != nil {
				claims, err := opts.ClaimsValidator(c, token)
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
			if err := opts.Validator(c, token); err != nil {
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
	return func(ctx *apptheory.Context, token string) (*BearerTokenClaims, error) {
		claims, ok := byToken[strings.TrimSpace(token)]
		if !ok {
			return nil, ErrInvalidBearerToken
		}
		if !claims.ExpiresAt.IsZero() && !now().Before(claims.ExpiresAt) {
			return nil, ErrBearerTokenExpired
		}
		audience := requiredAudience
		if opts.RequiredAudienceFunc != nil {
			derived, err := opts.RequiredAudienceFunc(ctx)
			if err != nil {
				return nil, err
			}
			audience = strings.TrimSpace(derived)
		}
		if audience != "" && claims.Audience != audience {
			return nil, ErrBearerTokenInvalidAudience
		}
		required := requiredScopes
		if opts.RequiredScopesFunc != nil {
			derived, err := opts.RequiredScopesFunc(ctx)
			if err != nil {
				return nil, err
			}
			required = derived
		}
		if missing := missingScopes(claims.Scopes, required); len(missing) > 0 {
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

// InsufficientScopeWWWAuthenticate builds the RFC 6750 (RFC 9728-extended)
// insufficient_scope challenge carrying the route-derived remediation scope set.
func InsufficientScopeWWWAuthenticate(scopes []string, resourceMetadataURL string) string {
	normalized := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		if scope = strings.TrimSpace(scope); scope != "" {
			normalized = append(normalized, scope)
		}
	}
	parts := []string{`Bearer error="insufficient_scope"`}
	if len(normalized) > 0 {
		parts = append(parts, "scope="+quoteChallengeValue(strings.Join(normalized, " ")))
	}
	if url := strings.TrimSpace(resourceMetadataURL); url != "" {
		parts = append(parts, "resource_metadata="+quoteChallengeValue(url))
	}
	return strings.Join(parts, ", ")
}

func quoteChallengeValue(value string) string {
	escaped := strings.ReplaceAll(value, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "\"", "\\\"")
	return "\"" + escaped + "\""
}

// resolvedResourceMetadataURL returns the protected-resource metadata URL for
// the challenge. A route-derived resolver takes precedence, then a
// route-parameter template, then the static option. No environment variable is
// consulted, so an injected MCP_ENDPOINT cannot influence the challenge.
//
// A configured template that cannot be resolved for the matched route — a
// missing parameter, or a parameter value outside the pinned value alphabet —
// returns "" so the caller emits the bare `Bearer` challenge rather than a
// literal placeholder.
func resolvedResourceMetadataURL(c *apptheory.Context, opts RequireBearerTokenOptions) string {
	if opts.ResourceMetadataURLFunc != nil {
		derived, err := opts.ResourceMetadataURLFunc(c)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(derived)
	}
	if opts.resourceMetadataURLTemplate != nil {
		var params map[string]string
		if c != nil {
			params = c.Params
		}
		resolved, ok := opts.resourceMetadataURLTemplate.resolve(params)
		if !ok {
			return ""
		}
		return resolved
	}
	return strings.TrimSpace(opts.ResourceMetadataURL)
}

func unauthorizedResponse(c *apptheory.Context, opts RequireBearerTokenOptions) *apptheory.Response {
	headers := map[string][]string{
		"content-type": {"application/json; charset=utf-8"},
	}
	// Only include resource_metadata when we have a URL; it is required for
	// MCP auth (2025-06-18) discovery, but callers can also provide it via opts.
	if metaURL := resolvedResourceMetadataURL(c, opts); metaURL != "" {
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

// insufficientScopeResponse is the RFC 6750 403 for a scope failure the server
// actually observed, carrying the remediation scope set. An audience failure and
// every other forbidden denial advertise neither an error code nor a scope set.
func insufficientScopeResponse(c *apptheory.Context, opts RequireBearerTokenOptions) *apptheory.Response {
	var scopes []string
	if opts.RequiredScopesFunc != nil {
		if derived, err := opts.RequiredScopesFunc(c); err == nil {
			scopes = derived
		}
	}
	headers := map[string][]string{
		"content-type": {"application/json; charset=utf-8"},
		"www-authenticate": {
			InsufficientScopeWWWAuthenticate(scopes, resolvedResourceMetadataURL(c, opts)),
		},
	}
	return &apptheory.Response{
		Status:  403,
		Headers: headers,
		Body:    []byte(`{"error":{"code":"app.insufficient_scope","message":"insufficient scope"}}`),
	}
}

func bearerErrorResponse(c *apptheory.Context, opts RequireBearerTokenOptions, err error) *apptheory.Response {
	if errors.Is(err, ErrBearerTokenInsufficientScope) {
		return insufficientScopeResponse(c, opts)
	}
	if errors.Is(err, ErrBearerTokenInvalidAudience) {
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
