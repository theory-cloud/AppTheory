package apptheory

import (
	"context"
	"strings"

	"github.com/theory-cloud/apptheory/pkg/limited"
)

// RateLimitDecisionKey is the Context key used by RateLimitMiddleware to store the last LimitDecision.
const RateLimitDecisionKey = "rate_limit_decision"

type RateLimitConfig struct {
	// Limiter is required. If nil, RateLimitMiddleware is a no-op.
	Limiter limited.RateLimiter

	// FailClosed controls behavior when the limiter returns an error.
	// If false (default), requests proceed on limiter errors.
	FailClosed bool

	ExtractIdentifier func(ctx *Context) string
	ExtractResource   func(ctx *Context) string
	ExtractOperation  func(ctx *Context) string

	OnError     func(ctx *Context, err error)
	OnSuccess   func(ctx *Context, decision *limited.LimitDecision)
	OnRateLimit func(ctx *Context, decision *limited.LimitDecision)
}

func RateLimitMiddleware(config RateLimitConfig) Middleware {
	cfg := normalizeRateLimitConfig(config)

	return func(next Handler) Handler {
		if next == nil || cfg.Limiter == nil {
			return next
		}

		return func(ctx *Context) (*Response, error) {
			key := limited.RateLimitKey{
				Identifier: cfg.ExtractIdentifier(ctx),
				Resource:   cfg.ExtractResource(ctx),
				Operation:  cfg.ExtractOperation(ctx),
				Metadata: map[string]string{
					"method": ctx.Request.Method,
					"path":   ctx.Request.Path,
					"tenant": ctx.TenantID,
				},
			}

			decision, err := checkRateLimit(ctx.Context(), cfg.Limiter, key)
			if err != nil {
				if cfg.OnError != nil {
					cfg.OnError(ctx, err)
				}
				if !cfg.FailClosed {
					return next(ctx)
				}
				return nil, &AppError{Code: errorCodeInternal, Message: errorMessageInternal}
			}

			ctx.Set(RateLimitDecisionKey, decision)

			if decision != nil && !decision.Allowed {
				if cfg.OnRateLimit != nil {
					cfg.OnRateLimit(ctx, decision)
				}
				return nil, &AppError{Code: errorCodeRateLimited, Message: errorMessageRateLimited}
			}

			if cfg.OnSuccess != nil {
				cfg.OnSuccess(ctx, decision)
			}

			return next(ctx)
		}
	}
}

func normalizeRateLimitConfig(in RateLimitConfig) RateLimitConfig {
	cfg := in

	if cfg.ExtractIdentifier == nil {
		cfg.ExtractIdentifier = defaultRateLimitIdentifier
	}
	if cfg.ExtractResource == nil {
		cfg.ExtractResource = defaultRateLimitResource
	}
	if cfg.ExtractOperation == nil {
		cfg.ExtractOperation = defaultRateLimitOperation
	}

	return cfg
}

func checkRateLimit(ctx context.Context, limiter limited.RateLimiter, key limited.RateLimitKey) (*limited.LimitDecision, error) {
	if limiter == nil {
		return &limited.LimitDecision{Allowed: true}, nil
	}

	if atomic, ok := limiter.(limited.AtomicRateLimiter); ok {
		return atomic.CheckAndIncrement(ctx, key)
	}

	decision, err := limiter.CheckLimit(ctx, key)
	if err != nil {
		return nil, err
	}

	if decision != nil && decision.Allowed {
		if err := limiter.RecordRequest(ctx, key); err != nil {
			_ = err
		}
	}

	return decision, nil
}

func defaultRateLimitIdentifier(ctx *Context) string {
	if ctx == nil {
		return "anonymous"
	}

	if apiKey := firstHeaderValue(ctx.Request.Headers, "x-api-key"); apiKey != "" {
		return apiKey
	}

	auth := firstHeaderValue(ctx.Request.Headers, "authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		if token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer ")); token != "" {
			return token
		}
	}

	if id := strings.TrimSpace(ctx.AuthIdentity); id != "" {
		return id
	}

	if tenant := strings.TrimSpace(ctx.TenantID); tenant != "" {
		return tenant
	}

	return "anonymous"
}

func defaultRateLimitResource(ctx *Context) string {
	if ctx == nil {
		return "/"
	}
	return ctx.Request.Path
}

func defaultRateLimitOperation(ctx *Context) string {
	if ctx == nil {
		return ""
	}
	return ctx.Request.Method
}
