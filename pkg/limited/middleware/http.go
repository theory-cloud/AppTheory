// Package middleware provides HTTP middleware for the AppTheory limited rate limiter.
package middleware

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/theory-cloud/apptheory/pkg/limited"
)

type contextKey string

const (
	IdentifierKey contextKey = "rate_limit_identifier"
)

// Options configures the HTTP rate limiting middleware.
type Options struct {
	Limiter limited.RateLimiter

	ExtractIdentifier func(r *http.Request) string
	ExtractResource   func(r *http.Request) string
	ExtractOperation  func(r *http.Request) string

	ErrorHandler func(w http.ResponseWriter, r *http.Request, decision *limited.LimitDecision)
	OnSuccess    func(r *http.Request, decision *limited.LimitDecision)
	OnRateLimit  func(r *http.Request, decision *limited.LimitDecision)

	SkipRequest func(r *http.Request) bool
}

func Middleware(opts Options) func(http.HandlerFunc) http.HandlerFunc {
	if opts.ExtractIdentifier == nil {
		opts.ExtractIdentifier = defaultExtractIdentifier
	}
	if opts.ExtractResource == nil {
		opts.ExtractResource = defaultExtractResource
	}
	if opts.ExtractOperation == nil {
		opts.ExtractOperation = defaultExtractOperation
	}
	if opts.ErrorHandler == nil {
		opts.ErrorHandler = defaultErrorHandler
	}

	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if opts.SkipRequest != nil && opts.SkipRequest(r) {
				next(w, r)
				return
			}

			key := limited.RateLimitKey{
				Identifier: opts.ExtractIdentifier(r),
				Resource:   opts.ExtractResource(r),
				Operation:  opts.ExtractOperation(r),
				Metadata: map[string]string{
					"path":       r.URL.Path,
					"user_agent": r.UserAgent(),
					"ip":         getClientIP(r),
				},
			}

			if atomicLimiter, ok := opts.Limiter.(limited.AtomicRateLimiter); ok {
				decision, err := atomicLimiter.CheckAndIncrement(r.Context(), key)
				if err != nil {
					setFailOpenHeaders(w)
					next(w, r)
					return
				}
				handleDecision(w, r, decision, &opts, next)
				return
			}

			decision, err := opts.Limiter.CheckLimit(r.Context(), key)
			if err != nil {
				setFailOpenHeaders(w)
				next(w, r)
				return
			}

			if decision.Allowed {
				if err := opts.Limiter.RecordRequest(r.Context(), key); err != nil {
					_ = err
				}
			}

			handleDecision(w, r, decision, &opts, next)
		}
	}
}

func handleDecision(w http.ResponseWriter, r *http.Request, decision *limited.LimitDecision, opts *Options, next http.HandlerFunc) {
	remaining := decision.Limit - decision.CurrentCount
	if remaining < 0 {
		remaining = 0
	}

	w.Header().Set("X-RateLimit-Limit", strconv.Itoa(decision.Limit))
	w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
	w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(decision.ResetsAt.Unix(), 10))

	if !decision.Allowed {
		if decision.RetryAfter != nil {
			w.Header().Set("Retry-After", strconv.Itoa(int(decision.RetryAfter.Seconds())))
		}
		if opts.OnRateLimit != nil {
			opts.OnRateLimit(r, decision)
		}
		opts.ErrorHandler(w, r, decision)
		return
	}

	if opts.OnSuccess != nil {
		opts.OnSuccess(r, decision)
	}
	next(w, r)
}

func setFailOpenHeaders(w http.ResponseWriter) {
	w.Header().Set("X-RateLimit-Limit", "0")
	w.Header().Set("X-RateLimit-Remaining", "0")
	w.Header().Set("X-RateLimit-Reset", "0")
}

func defaultExtractIdentifier(r *http.Request) string {
	if apiKey := r.Header.Get("X-API-Key"); apiKey != "" {
		return apiKey
	}

	if auth := r.Header.Get("Authorization"); auth != "" && strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}

	if val := r.Context().Value(IdentifierKey); val != nil {
		if id, ok := val.(string); ok {
			return id
		}
	}

	return getClientIP(r)
}

func defaultExtractResource(r *http.Request) string {
	path := r.URL.Path
	if idx := strings.Index(path, "?"); idx != -1 {
		path = path[:idx]
	}
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		return "/"
	}
	return path
}

func defaultExtractOperation(r *http.Request) string {
	return r.Method
}

func defaultErrorHandler(w http.ResponseWriter, _ *http.Request, _ *limited.LimitDecision) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	if _, err := w.Write([]byte(`{"error":"rate_limit_exceeded","message":"Too many requests. Please retry later."}`)); err != nil {
		_ = err
	}
}

func getClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if idx := strings.Index(xff, ","); idx != -1 {
			return strings.TrimSpace(xff[:idx])
		}
		return xff
	}

	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}

	if idx := strings.LastIndex(r.RemoteAddr, ":"); idx != -1 {
		return r.RemoteAddr[:idx]
	}

	return r.RemoteAddr
}

func WithIdentifier(r *http.Request, identifier string) *http.Request {
	ctx := context.WithValue(r.Context(), IdentifierKey, identifier)
	return r.WithContext(ctx)
}
