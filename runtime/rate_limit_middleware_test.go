package apptheory

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory/pkg/limited"
)

type stubRateLimiter struct {
	decision *limited.LimitDecision
	err      error

	recordCalls int
	lastKey     limited.RateLimitKey
}

func (s *stubRateLimiter) CheckLimit(_ context.Context, key limited.RateLimitKey) (*limited.LimitDecision, error) {
	s.lastKey = key
	return s.decision, s.err
}

func (s *stubRateLimiter) RecordRequest(_ context.Context, _ limited.RateLimitKey) error {
	s.recordCalls++
	return nil
}

func (s *stubRateLimiter) GetUsage(_ context.Context, _ limited.RateLimitKey) (*limited.UsageStats, error) {
	return nil, nil
}

func TestRateLimitMiddleware_AllowsAndStoresDecision(t *testing.T) {
	resetsAt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	limiter := &stubRateLimiter{
		decision: &limited.LimitDecision{Allowed: true, CurrentCount: 0, Limit: 10, ResetsAt: resetsAt},
	}

	app := New(WithTier(TierP0))
	app.Use(RateLimitMiddleware(RateLimitConfig{Limiter: limiter}))

	called := false
	app.Get("/ok", func(ctx *Context) (*Response, error) {
		called = true
		if got := ctx.Get(RateLimitDecisionKey); got == nil {
			t.Fatalf("expected decision in context, got nil")
		}
		return Text(200, "ok"), nil
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/ok"})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	if !called {
		t.Fatalf("expected handler to be called")
	}
	if limiter.recordCalls != 1 {
		t.Fatalf("expected RecordRequest to be called once, got %d", limiter.recordCalls)
	}
}

func TestRateLimitMiddleware_RateLimited(t *testing.T) {
	limiter := &stubRateLimiter{
		decision: &limited.LimitDecision{Allowed: false, CurrentCount: 10, Limit: 10, ResetsAt: time.Now()},
	}

	app := New(WithTier(TierP0))
	app.Use(RateLimitMiddleware(RateLimitConfig{Limiter: limiter}))

	app.Get("/nope", func(_ *Context) (*Response, error) {
		t.Fatalf("handler should not be called when rate limited")
		return nil, nil
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/nope"})
	if resp.Status != 429 {
		t.Fatalf("expected status 429, got %d", resp.Status)
	}
}

func TestRateLimitMiddleware_FailOpenOnLimiterError(t *testing.T) {
	limiter := &stubRateLimiter{decision: nil, err: context.DeadlineExceeded}

	app := New(WithTier(TierP0))
	app.Use(RateLimitMiddleware(RateLimitConfig{Limiter: limiter}))

	called := false
	app.Get("/ok", func(_ *Context) (*Response, error) {
		called = true
		return Text(200, "ok"), nil
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/ok"})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	if !called {
		t.Fatalf("expected handler to be called")
	}
}

func TestDefaultRateLimitIdentifier_HashesCredentialHeaders(t *testing.T) {
	apiKeyCtx := &Context{
		Request: Request{
			Headers: map[string][]string{
				"x-api-key": {"k_secret"},
			},
		},
	}
	if got := defaultRateLimitIdentifier(apiKeyCtx); got == "k_secret" {
		t.Fatalf("expected api key identifier to be fingerprinted, got raw value")
	} else if want := fingerprintRateLimitCredentialIdentifier("api_key", "k_secret"); got != want {
		t.Fatalf("expected fingerprinted api key identifier %q, got %q", want, got)
	} else if !strings.Contains(got, ":hmac-sha256:") {
		t.Fatalf("expected api key identifier to use an HMAC fingerprint, got %q", got)
	}

	bearerCtx := &Context{
		Request: Request{
			Headers: map[string][]string{
				"authorization": {"Bearer tok_secret"},
			},
		},
	}
	if got := defaultRateLimitIdentifier(bearerCtx); got == "tok_secret" {
		t.Fatalf("expected bearer identifier to be fingerprinted, got raw value")
	} else if want := fingerprintRateLimitCredentialIdentifier("bearer", "tok_secret"); got != want {
		t.Fatalf("expected fingerprinted bearer identifier %q, got %q", want, got)
	} else if !strings.Contains(got, ":hmac-sha256:") {
		t.Fatalf("expected bearer identifier to use an HMAC fingerprint, got %q", got)
	}
}

func TestDefaultRateLimitIdentifier_HashesWhitespaceAPIKey(t *testing.T) {
	ctx := &Context{
		Request: Request{
			Headers: map[string][]string{
				"x-api-key": {"   "},
			},
		},
		TenantID: "tenant_123",
	}

	got := defaultRateLimitIdentifier(ctx)
	if got == "" {
		t.Fatalf("expected whitespace api key to produce a non-empty limiter identifier")
	}
	if got == "tenant_123" || got == anonymousRateLimitIdentifier {
		t.Fatalf("expected whitespace api key to remain credential-scoped, got %q", got)
	}
	if want := fingerprintRateLimitCredentialIdentifier("api_key", "   "); got != want {
		t.Fatalf("expected whitespace api key fingerprint %q, got %q", want, got)
	}
}

func TestDefaultRateLimitIdentifier_FallbacksRemainStable(t *testing.T) {
	authIdentityCtx := &Context{AuthIdentity: "user_123"}
	if got := defaultRateLimitIdentifier(authIdentityCtx); got != "user_123" {
		t.Fatalf("expected auth identity fallback, got %q", got)
	}

	tenantCtx := &Context{TenantID: "tenant_123"}
	if got := defaultRateLimitIdentifier(tenantCtx); got != "tenant_123" {
		t.Fatalf("expected tenant fallback, got %q", got)
	}

	if got := defaultRateLimitIdentifier(&Context{}); got != "anonymous" {
		t.Fatalf("expected anonymous fallback, got %q", got)
	}
}

func TestRateLimitMiddleware_DefaultIdentifierStoredInLimiterIsHashed(t *testing.T) {
	limiter := &stubRateLimiter{
		decision: &limited.LimitDecision{Allowed: true, CurrentCount: 0, Limit: 10, ResetsAt: time.Now()},
	}

	app := New(WithTier(TierP0))
	app.Use(RateLimitMiddleware(RateLimitConfig{Limiter: limiter}))
	app.Get("/ok", func(_ *Context) (*Response, error) {
		return Text(200, "ok"), nil
	})

	resp := app.Serve(context.Background(), Request{
		Method: "GET",
		Path:   "/ok",
		Headers: map[string][]string{
			"x-api-key": {"k_secret"},
		},
	})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	if limiter.lastKey.Identifier == "" {
		t.Fatalf("expected limiter identifier to be recorded")
	}
	if strings.Contains(limiter.lastKey.Identifier, "k_secret") {
		t.Fatalf("expected fingerprinted limiter identifier, got %q", limiter.lastKey.Identifier)
	}
	if want := fingerprintRateLimitCredentialIdentifier("api_key", "k_secret"); limiter.lastKey.Identifier != want {
		t.Fatalf("expected fingerprinted limiter identifier %q, got %q", want, limiter.lastKey.Identifier)
	}
}
