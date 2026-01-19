package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/pkg/limited"
)

type atomicStub struct {
	decision *limited.LimitDecision
	err      error
}

func (s atomicStub) CheckAndIncrement(_ context.Context, _ limited.RateLimitKey) (*limited.LimitDecision, error) {
	return s.decision, s.err
}

func (atomicStub) CheckLimit(context.Context, limited.RateLimitKey) (*limited.LimitDecision, error) {
	return nil, errors.New("not implemented")
}

func (atomicStub) RecordRequest(context.Context, limited.RateLimitKey) error { return errors.New("not implemented") }

func (atomicStub) GetUsage(context.Context, limited.RateLimitKey) (*limited.UsageStats, error) {
	return nil, errors.New("not implemented")
}

func TestMiddleware_AllowsAndSetsHeaders(t *testing.T) {
	resetAt := time.Unix(1700000000, 0).UTC()

	handler := Middleware(Options{
		Limiter: atomicStub{decision: &limited.LimitDecision{
			Allowed:      true,
			CurrentCount: 3,
			Limit:        10,
			ResetsAt:     resetAt,
		}},
	})(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	rr := httptest.NewRecorder()
	handler(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, "10", rr.Header().Get("X-RateLimit-Limit"))
	require.Equal(t, "7", rr.Header().Get("X-RateLimit-Remaining"))
	require.Equal(t, "1700000000", rr.Header().Get("X-RateLimit-Reset"))
}

func TestMiddleware_RateLimitedCallsErrorHandler(t *testing.T) {
	resetAt := time.Unix(1700000000, 0).UTC()
	retry := 10 * time.Second

	called := false

	handler := Middleware(Options{
		Limiter: atomicStub{decision: &limited.LimitDecision{
			Allowed:      false,
			CurrentCount: 10,
			Limit:        10,
			ResetsAt:     resetAt,
			RetryAfter:   &retry,
		}},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ *limited.LimitDecision) {
			called = true
			w.WriteHeader(http.StatusTooManyRequests)
		},
	})(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	rr := httptest.NewRecorder()
	handler(rr, req)

	require.True(t, called)
	require.Equal(t, http.StatusTooManyRequests, rr.Code)
	require.Equal(t, "10", rr.Header().Get("Retry-After"))
}

func TestMiddleware_FailsOpenOnLimiterError(t *testing.T) {
	handler := Middleware(Options{
		Limiter: atomicStub{err: errors.New("boom")},
	})(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	rr := httptest.NewRecorder()
	handler(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, "0", rr.Header().Get("X-RateLimit-Limit"))
	require.Equal(t, "0", rr.Header().Get("X-RateLimit-Remaining"))
	require.Equal(t, "0", rr.Header().Get("X-RateLimit-Reset"))
}

