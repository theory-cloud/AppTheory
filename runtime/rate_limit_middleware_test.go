package apptheory

import (
	"context"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory/pkg/limited"
)

type stubRateLimiter struct {
	decision *limited.LimitDecision
	err      error

	recordCalls int
}

func (s *stubRateLimiter) CheckLimit(_ context.Context, _ limited.RateLimitKey) (*limited.LimitDecision, error) {
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
