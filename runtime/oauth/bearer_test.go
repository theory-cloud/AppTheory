package oauth

import (
	"context"
	"errors"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"

	"github.com/stretchr/testify/require"
)

func TestBearerTokenFromHeaders(t *testing.T) {
	token, err := BearerTokenFromHeaders(map[string][]string{
		"authorization": {"Bearer abc123"},
	})
	require.NoError(t, err)
	require.Equal(t, "abc123", token)
}

func TestBearerTokenFromHeaders_Missing(t *testing.T) {
	_, err := BearerTokenFromHeaders(map[string][]string{})
	require.ErrorIs(t, err, ErrMissingBearerToken)
}

func TestRequireBearerTokenMiddleware_401IncludesResourceMetadata(t *testing.T) {
	t.Setenv("MCP_ENDPOINT", "https://mcp.example.com/mcp")

	mw := RequireBearerTokenMiddleware(RequireBearerTokenOptions{})
	handler := mw(func(*apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{Status: 200}, nil
	})

	resp, err := handler(&apptheory.Context{
		Request: apptheory.Request{
			Headers: map[string][]string{
				"host":              {"mcp.example.com"},
				"x-forwarded-proto": {"https"},
			},
		},
	})
	require.NoError(t, err)
	require.Equal(t, 401, resp.Status)
	require.Equal(t, []string{`Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"`}, resp.Headers["www-authenticate"])
}

func TestRequireBearerTokenMiddleware_401ResolvesActorTemplate(t *testing.T) {
	t.Setenv("MCP_ENDPOINT", "https://mcp.example.com/mcp/{actor}")

	app := apptheory.New()
	app.Use(RequireBearerTokenMiddleware(RequireBearerTokenOptions{}))
	app.Get("/mcp/{actor}", func(*apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{Status: 200}, nil
	})

	resp := app.Serve(context.Background(), apptheory.Request{
		Method: "GET",
		Path:   "/mcp/Arch",
		Headers: map[string][]string{
			"host":              {"mcp.example.com"},
			"x-forwarded-proto": {"https"},
		},
	})

	require.Equal(t, 401, resp.Status)
	require.Equal(t, []string{`Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp/Arch"`}, resp.Headers["www-authenticate"])
}

func TestRequireBearerTokenMiddleware_ValidatorRuns(t *testing.T) {
	called := 0
	mw := RequireBearerTokenMiddleware(RequireBearerTokenOptions{
		ResourceMetadataURL: "https://mcp.example.com/.well-known/oauth-protected-resource",
		Validator: func(context.Context, string) error {
			called++
			return nil
		},
	})

	handler := mw(func(*apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{Status: 200}, nil
	})

	resp, err := handler(&apptheory.Context{
		Request: apptheory.Request{
			Headers: map[string][]string{
				"authorization": {"Bearer ok"},
			},
		},
	})
	require.NoError(t, err)
	require.Equal(t, 200, resp.Status)
	require.Equal(t, 1, called)
}

func TestRequireBearerTokenMiddleware_ClaimsValidatorStoresClaimsAndForbidsScope(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	validator := NewMemoryBearerTokenValidator([]BearerTokenRecord{
		{
			Token:     "valid-token",
			Subject:   "user-1",
			Audience:  "https://mcp.example.com/mcp",
			Scopes:    []string{"mcp:read", "mcp:write"},
			ExpiresAt: now.Add(time.Hour),
		},
		{
			Token:     "missing-scope-token",
			Subject:   "user-1",
			Audience:  "https://mcp.example.com/mcp",
			Scope:     "mcp:write",
			ExpiresAt: now.Add(time.Hour),
		},
	}, BearerTokenValidationOptions{
		RequiredAudience: "https://mcp.example.com/mcp",
		RequiredScopes:   []string{"mcp:read"},
		Now:              func() time.Time { return now },
	})

	mw := RequireBearerTokenMiddleware(RequireBearerTokenOptions{
		ResourceMetadataURL: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
		ClaimsValidator:     validator,
	})
	handler := mw(func(c *apptheory.Context) (*apptheory.Response, error) {
		claims, ok := BearerTokenClaimsFromContext(c)
		require.True(t, ok)
		require.Equal(t, "user-1", claims.Subject)
		require.Equal(t, []string{"mcp:read", "mcp:write"}, claims.Scopes)
		require.Equal(t, "valid-token", c.Get(ContextKeyBearerToken))
		claims.Scopes[0] = "mutated"
		again, ok := BearerTokenClaimsFromContext(c)
		require.True(t, ok)
		require.Equal(t, []string{"mcp:read", "mcp:write"}, again.Scopes)
		return &apptheory.Response{Status: 200}, nil
	})

	resp, err := handler(&apptheory.Context{
		Request: apptheory.Request{Headers: map[string][]string{"authorization": {"Bearer valid-token"}}},
	})
	require.NoError(t, err)
	require.Equal(t, 200, resp.Status)

	resp, err = handler(&apptheory.Context{
		Request: apptheory.Request{Headers: map[string][]string{"authorization": {"Bearer missing-scope-token"}}},
	})
	require.NoError(t, err)
	require.Equal(t, 403, resp.Status)
	require.JSONEq(t, `{"error":{"code":"app.forbidden","message":"forbidden"}}`, string(resp.Body))
}

func TestNewMemoryBearerTokenValidator_RejectsInvalidExpiredAndAudience(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	validator := NewMemoryBearerTokenValidator([]BearerTokenRecord{
		{
			Token:     "expired-token",
			Subject:   "user-1",
			Audience:  "https://mcp.example.com/mcp",
			Scope:     "mcp:read",
			ExpiresAt: now.Add(-time.Second),
		},
		{
			Token:     "wrong-audience-token",
			Subject:   "user-1",
			Audience:  "https://other.example.com/mcp",
			Scope:     "mcp:read",
			ExpiresAt: now.Add(time.Hour),
		},
		{Token: " ", Subject: "ignored"},
	}, BearerTokenValidationOptions{
		RequiredAudience: "https://mcp.example.com/mcp",
		RequiredScopes:   []string{"mcp:read"},
		Now:              func() time.Time { return now },
	})

	_, err := validator(context.Background(), "missing-token")
	require.ErrorIs(t, err, ErrInvalidBearerToken)
	_, err = validator(context.Background(), "expired-token")
	require.ErrorIs(t, err, ErrBearerTokenExpired)
	_, err = validator(context.Background(), "wrong-audience-token")
	require.ErrorIs(t, err, ErrBearerTokenInvalidAudience)
}

func TestBearerTokenClaimsFromContext_EdgeCases(t *testing.T) {
	_, ok := BearerTokenClaimsFromContext(nil)
	require.False(t, ok)

	ctx := &apptheory.Context{}
	_, ok = BearerTokenClaimsFromContext(ctx)
	require.False(t, ok)

	ctx.Set(ContextKeyBearerClaims, &BearerTokenClaims{Subject: "ptr", Scopes: []string{"a"}})
	claims, ok := BearerTokenClaimsFromContext(ctx)
	require.True(t, ok)
	require.Equal(t, "ptr", claims.Subject)
	require.Equal(t, []string{"a"}, claims.Scopes)

	ctx.Set(ContextKeyBearerClaims, (*BearerTokenClaims)(nil))
	_, ok = BearerTokenClaimsFromContext(ctx)
	require.False(t, ok)
}

func TestRequireBearerTokenMiddleware_MapsValidatorAudienceScopeErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{name: "audience", err: ErrBearerTokenInvalidAudience, status: 403},
		{name: "scope", err: ErrBearerTokenInsufficientScope, status: 403},
		{name: "generic", err: errors.New("invalid"), status: 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mw := RequireBearerTokenMiddleware(RequireBearerTokenOptions{
				ResourceMetadataURL: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
				Validator: func(context.Context, string) error {
					return tc.err
				},
			})
			resp, err := mw(func(*apptheory.Context) (*apptheory.Response, error) {
				t.Fatal("next should not run")
				return nil, nil
			})(&apptheory.Context{
				Request: apptheory.Request{Headers: map[string][]string{"authorization": {"Bearer bad-token"}}},
			})
			require.NoError(t, err)
			require.Equal(t, tc.status, resp.Status)
		})
	}
}

func TestRequireBearerTokenMiddleware_RejectsWhenValidatorMissing(t *testing.T) {
	mw := RequireBearerTokenMiddleware(RequireBearerTokenOptions{
		ResourceMetadataURL: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
	})

	called := false
	handler := mw(func(*apptheory.Context) (*apptheory.Response, error) {
		called = true
		return &apptheory.Response{Status: 200}, nil
	})

	resp, err := handler(&apptheory.Context{
		Request: apptheory.Request{
			Headers: map[string][]string{
				"authorization": {"Bearer ok"},
			},
		},
	})
	require.NoError(t, err)
	require.Equal(t, 401, resp.Status)
	require.Equal(t, []string{`Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"`}, resp.Headers["www-authenticate"])
	require.False(t, called)
}

func TestRequireBearerTokenMiddleware_DoesNotDeriveMetadataFromRequestHeaders(t *testing.T) {
	t.Setenv("MCP_ENDPOINT", "")

	mw := RequireBearerTokenMiddleware(RequireBearerTokenOptions{})
	handler := mw(func(*apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{Status: 200}, nil
	})

	resp, err := handler(&apptheory.Context{
		Request: apptheory.Request{
			Headers: map[string][]string{
				"host":              {"mcp.example.com"},
				"x-forwarded-proto": {"https"},
			},
		},
	})
	require.NoError(t, err)
	require.Equal(t, 401, resp.Status)
	require.Equal(t, []string{"Bearer"}, resp.Headers["www-authenticate"])
}
