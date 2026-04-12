package apptheory

import (
	"context"
	"encoding/json"
	"testing"
)

func TestOptionalAuth_AllowsAnonymousRequests(t *testing.T) {
	t.Parallel()

	app := New(WithTier(TierP2), WithIDGenerator(fixedIDGenerator("req_1")))
	app.Get("/feed", func(ctx *Context) (*Response, error) {
		if ctx.AuthPrincipal != nil {
			t.Fatalf("expected anonymous request, got %#v", ctx.AuthPrincipal)
		}
		return Text(200, "ok"), nil
	}, OptionalAuth())

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/feed"})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}
}

func TestAuthPrincipalHook_ProvidesPrincipalAndScopes(t *testing.T) {
	t.Parallel()

	app := New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithAuthPrincipalHook(func(*Context) (*AuthPrincipal, error) {
			return &AuthPrincipal{
				Identity: "user_1",
				Scopes:   []string{"profile:read", "profile:read"},
				Claims: map[string]any{
					"role": "member",
				},
			}, nil
		}),
	)
	app.Get("/profile", func(ctx *Context) (*Response, error) {
		return MustJSON(200, map[string]any{
			"identity": ctx.AuthIdentity,
			"scopes":   ctx.AuthPrincipal.Scopes,
			"role":     ctx.AuthPrincipal.Claims["role"],
		}), nil
	}, RequireScope("profile:read"))

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/profile"})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d (%s)", resp.Status, string(resp.Body))
	}

	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["identity"] != "user_1" || body["role"] != "member" {
		t.Fatalf("unexpected auth payload: %#v", body)
	}
	scopes, ok := body["scopes"].([]any)
	if !ok || len(scopes) != 1 || scopes[0] != "profile:read" {
		t.Fatalf("unexpected scopes: %#v", body["scopes"])
	}
}

func TestRequireAnyScope_RejectsUnauthorizedPrincipal(t *testing.T) {
	t.Parallel()

	app := New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithAuthPrincipalHook(func(*Context) (*AuthPrincipal, error) {
			return &AuthPrincipal{
				Identity: "user_2",
				Scopes:   []string{"profile:read"},
			}, nil
		}),
	)
	app.Post("/admin", func(*Context) (*Response, error) { return Text(200, "ok"), nil }, RequireAnyScope("admin", "tasks:write"))

	resp := app.Serve(context.Background(), Request{Method: "POST", Path: "/admin"})
	if resp.Status != 403 {
		t.Fatalf("expected 403, got %d", resp.Status)
	}
}

func TestRequireScope_WithoutHookReturnsUnauthorized(t *testing.T) {
	t.Parallel()

	app := New(WithTier(TierP2), WithIDGenerator(fixedIDGenerator("req_1")))
	app.Get("/profile", func(*Context) (*Response, error) { return Text(200, "ok"), nil }, RequireScope("profile:read"))

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/profile"})
	if resp.Status != 401 {
		t.Fatalf("expected 401, got %d", resp.Status)
	}
}

func TestWithAuthHook_RemainsCompatibleWithPrincipalFlow(t *testing.T) {
	t.Parallel()

	app := New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithAuthHook(func(*Context) (string, error) {
			return "legacy-user", nil
		}),
	)
	app.Get("/protected", func(ctx *Context) (*Response, error) {
		return MustJSON(200, map[string]any{
			"identity":           ctx.AuthIdentity,
			"principal_identity": ctx.AuthPrincipal.Identity,
		}), nil
	}, RequireAuth())

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/protected"})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}

	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["identity"] != "legacy-user" || body["principal_identity"] != "legacy-user" {
		t.Fatalf("unexpected payload: %#v", body)
	}
}
