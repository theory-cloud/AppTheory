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

type nonAtomicStub struct {
	checkDecision *limited.LimitDecision
	checkErr      error
	recordErr     error

	checkCalls  int
	recordCalls int
}

func (s *nonAtomicStub) CheckLimit(_ context.Context, _ limited.RateLimitKey) (*limited.LimitDecision, error) {
	s.checkCalls++
	return s.checkDecision, s.checkErr
}

func (s *nonAtomicStub) RecordRequest(_ context.Context, _ limited.RateLimitKey) error {
	s.recordCalls++
	return s.recordErr
}

func (s *nonAtomicStub) GetUsage(context.Context, limited.RateLimitKey) (*limited.UsageStats, error) {
	return nil, errors.New("not implemented")
}

func TestMiddleware_NonAtomic_AllowsAndRecordsRequestAndCallsHooks(t *testing.T) {
	resetAt := time.Unix(1700000000, 0).UTC()
	stub := &nonAtomicStub{
		checkDecision: &limited.LimitDecision{
			Allowed:      true,
			CurrentCount: 1,
			Limit:        2,
			ResetsAt:     resetAt,
		},
		recordErr: errors.New("ignored"),
	}

	var onSuccessCalled bool
	handler := Middleware(Options{
		Limiter: stub,
		OnSuccess: func(_ *http.Request, _ *limited.LimitDecision) {
			onSuccessCalled = true
		},
	})(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "1.2.3.4:9999"
	rr := httptest.NewRecorder()
	handler(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, 1, stub.checkCalls)
	require.Equal(t, 1, stub.recordCalls)
	require.True(t, onSuccessCalled)
	require.Equal(t, "2", rr.Header().Get("X-RateLimit-Limit"))
	require.Equal(t, "1", rr.Header().Get("X-RateLimit-Remaining"))
}

func TestMiddleware_NonAtomic_FailsOpenOnCheckLimitError(t *testing.T) {
	stub := &nonAtomicStub{
		checkErr: errors.New("boom"),
	}

	handler := Middleware(Options{
		Limiter: stub,
	})(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	rr := httptest.NewRecorder()
	handler(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, "0", rr.Header().Get("X-RateLimit-Limit"))
	require.Equal(t, "0", rr.Header().Get("X-RateLimit-Remaining"))
	require.Equal(t, 1, stub.checkCalls)
}

func TestMiddleware_SkipRequest_SkipsLimiter(t *testing.T) {
	stub := &nonAtomicStub{
		checkDecision: &limited.LimitDecision{Allowed: true},
	}

	handler := Middleware(Options{
		Limiter: stub,
		SkipRequest: func(_ *http.Request) bool {
			return true
		},
	})(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	rr := httptest.NewRecorder()
	handler(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	require.Equal(t, 0, stub.checkCalls)
	require.Equal(t, 0, stub.recordCalls)
}

func TestDefaultExtractIdentifier_UsesAPIKeyBearerContextAndClientIP(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	req.Header.Set("X-API-Key", "k1")
	require.Equal(t, "k1", defaultExtractIdentifier(req))

	req = httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	req.Header.Set("Authorization", "Bearer token1")
	require.Equal(t, "token1", defaultExtractIdentifier(req))

	req = httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	req = WithIdentifier(req, "id1")
	require.Equal(t, "id1", defaultExtractIdentifier(req))

	req = httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "5.6.7.8:1234"
	require.Equal(t, "5.6.7.8", defaultExtractIdentifier(req))
}

func TestDefaultExtractResource_AndGetClientIP_Branches(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "https://example.com/test/?a=b", nil)
	require.Equal(t, "/test", defaultExtractResource(req))

	// Cover the (unusual) path-with-query branch.
	req.URL.Path = "/test?a=b"
	require.Equal(t, "/test", defaultExtractResource(req))

	req.URL.Path = ""
	require.Equal(t, "/", defaultExtractResource(req))

	req = httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	req.Header.Set("X-Forwarded-For", " 1.1.1.1, 2.2.2.2 ")
	require.Equal(t, "1.1.1.1", getClientIP(req))

	req = httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	req.Header.Set("X-Real-IP", "3.3.3.3")
	require.Equal(t, "3.3.3.3", getClientIP(req))

	req = httptest.NewRequest(http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "4.4.4.4"
	require.Equal(t, "4.4.4.4", getClientIP(req))
}
