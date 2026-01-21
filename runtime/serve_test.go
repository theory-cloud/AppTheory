package apptheory

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestServe_NilAppFailsClosed(t *testing.T) {
	var app *App
	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/"})
	if resp.Status != 500 {
		t.Fatalf("expected 500, got %d", resp.Status)
	}
}

func TestServeP0_MethodNotAllowedAndPanicRecovery(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Post("/", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })
	app.Get("/panic", func(_ *Context) (*Response, error) { panic("boom") })

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/"})
	if resp.Status != 405 {
		t.Fatalf("expected 405, got %d", resp.Status)
	}
	if allow := resp.Headers["allow"]; len(allow) != 1 || allow[0] != "POST" {
		t.Fatalf("unexpected allow header: %v", allow)
	}

	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/panic"})
	if resp.Status != 500 {
		t.Fatalf("expected 500, got %d", resp.Status)
	}
}

func TestServeP0_HandlerErrors(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Get("/app", func(_ *Context) (*Response, error) {
		return nil, &AppError{Code: errorCodeUnauthorized, Message: errorMessageUnauthorized}
	})
	app.Get("/err", func(_ *Context) (*Response, error) {
		return nil, errors.New("boom")
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/app"})
	if resp.Status != 401 {
		t.Fatalf("expected 401, got %d", resp.Status)
	}

	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/err"})
	if resp.Status != 500 {
		t.Fatalf("expected 500, got %d", resp.Status)
	}
}

func TestServePortable_AddsRequestIDAuthAndCORS(t *testing.T) {
	app := New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithCORS(CORSConfig{
			AllowedOrigins:   []string{"https://a.example"},
			AllowCredentials: true,
		}),
		WithAuthHook(func(ctx *Context) (string, error) {
			if ctx == nil {
				return "", errors.New("nil ctx")
			}
			return "user1", nil
		}),
	)

	app.Get("/ok", func(ctx *Context) (*Response, error) {
		return MustJSON(200, map[string]any{
			"request_id": ctx.RequestID,
			"tenant_id":  ctx.TenantID,
			"auth":       ctx.AuthIdentity,
			"trace":      ctx.MiddlewareTrace,
		}), nil
	}, RequireAuth())

	resp := app.Serve(context.Background(), Request{
		Method: "GET",
		Path:   "/ok",
		Headers: map[string][]string{
			"Origin":      {"https://a.example"},
			"X-Tenant-Id": {"t1"},
		},
	})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d (%s)", resp.Status, string(resp.Body))
	}
	if got := resp.Headers["x-request-id"]; len(got) != 1 || got[0] != "req_1" {
		t.Fatalf("unexpected x-request-id: %v", got)
	}
	if got := resp.Headers["access-control-allow-origin"]; len(got) != 1 || got[0] != "https://a.example" {
		t.Fatalf("unexpected allow-origin: %v", got)
	}
	if got := resp.Headers["access-control-allow-credentials"]; len(got) != 1 || got[0] != "true" {
		t.Fatalf("unexpected allow-credentials: %v", got)
	}

	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["request_id"] != "req_1" || body["tenant_id"] != "t1" || body["auth"] != "user1" {
		t.Fatalf("unexpected response body: %v", body)
	}
	trace, ok := body["trace"].([]any)
	if !ok {
		t.Fatalf("expected trace to be []any, got %T", body["trace"])
	}
	if len(trace) < 3 {
		t.Fatalf("unexpected middleware trace: %v", trace)
	}
}

func TestServePortable_Preflight(t *testing.T) {
	app := New(WithTier(TierP1), WithIDGenerator(fixedIDGenerator("req_1")))

	resp := app.Serve(context.Background(), Request{
		Method: "OPTIONS",
		Path:   "/whatever",
		Headers: map[string][]string{
			"Origin":                        {"https://a.example"},
			"Access-Control-Request-Method": {"GET"},
		},
	})
	if resp.Status != 204 {
		t.Fatalf("expected 204, got %d", resp.Status)
	}
	if got := resp.Headers["access-control-allow-methods"]; len(got) != 1 || got[0] != "GET" {
		t.Fatalf("unexpected allow-methods: %v", got)
	}
}

func TestServePortable_PolicyAndLimits(t *testing.T) {
	app := New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithLimits(Limits{MaxRequestBytes: 1, MaxResponseBytes: 1}),
		WithPolicyHook(func(_ *Context) (*PolicyDecision, error) {
			return &PolicyDecision{Code: errorCodeRateLimited}, nil
		}),
	)
	app.Get("/ok", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/ok"})
	if resp.Status != 429 {
		t.Fatalf("expected 429 from policy, got %d", resp.Status)
	}

	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/ok", Body: []byte("xx")})
	if resp.Status != 413 {
		t.Fatalf("expected 413 request too large, got %d", resp.Status)
	}

	app = New(WithTier(TierP2), WithLimits(Limits{MaxResponseBytes: 1}))
	app.Get("/big", func(_ *Context) (*Response, error) { return Text(200, "xx"), nil })
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/big"})
	if resp.Status != 413 {
		t.Fatalf("expected 413 response too large, got %d", resp.Status)
	}
}
