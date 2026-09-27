package apptheory

import (
	"context"
	"fmt"
	"time"
)

type TimeoutConfig struct {
	DefaultTimeout    time.Duration
	OperationTimeouts map[string]time.Duration
	TenantTimeouts    map[string]time.Duration
	TimeoutMessage    string
}

// TimeoutMiddleware fails a request closed when its timeout policy expires.
//
// The handler chain runs on the invoking goroutine with a deadline-bearing
// context, and the middleware reports app.timeout when the deadline passed while
// the chain was running. It starts no goroutine of its own: a handler that
// observes its canceled context returns immediately, and a handler that ignores
// it runs until it returns, bounded by the Lambda function timeout rather than
// abandoned by the middleware. There is no grace window and no abandoned work.
func TimeoutMiddleware(config TimeoutConfig) Middleware {
	cfg := normalizeTimeoutConfig(config)

	return func(next Handler) Handler {
		if next == nil {
			return next
		}
		return func(ctx *Context) (*Response, error) {
			timeout := timeoutForContext(ctx, cfg)
			if timeout <= 0 {
				return next(ctx)
			}

			timeoutCtx, cancel := context.WithTimeout(ctx.Context(), timeout)
			defer cancel()

			handlerCtx := withDerivedTimeoutContext(timeoutCtx, ctx)

			resp, err := runHandlerWithRecovery(next, handlerCtx)
			if timeoutCtx.Err() != nil {
				return nil, &AppError{Code: errorCodeTimeout, Message: cfg.TimeoutMessage}
			}
			return resp, err
		}
	}
}

// runHandlerWithRecovery runs the handler chain on the calling goroutine and
// converts a panic into the internal error the serve pipeline expects, so the
// middleware keeps the recovery it had while it ran the chain on its own
// goroutine.
func runHandlerWithRecovery(next Handler, ctx *Context) (resp *Response, err error) {
	defer func() {
		if r := recover(); r != nil {
			resp = nil
			err = &AppError{Code: errorCodeInternal, Message: errorMessageInternal}
		}
	}()
	return next(ctx)
}

func withDerivedTimeoutContext(derived context.Context, ctx *Context) *Context {
	if ctx == nil {
		return &Context{ctx: derived}
	}

	cloned := *ctx
	cloned.ctx = derived
	return &cloned
}

func normalizeTimeoutConfig(in TimeoutConfig) TimeoutConfig {
	cfg := TimeoutConfig{
		DefaultTimeout:    in.DefaultTimeout,
		OperationTimeouts: in.OperationTimeouts,
		TenantTimeouts:    in.TenantTimeouts,
		TimeoutMessage:    in.TimeoutMessage,
	}
	if cfg.DefaultTimeout == 0 {
		cfg.DefaultTimeout = 30 * time.Second
	}
	if cfg.TimeoutMessage == "" {
		cfg.TimeoutMessage = errorMessageTimeout
	}
	return cfg
}

func timeoutForContext(ctx *Context, cfg TimeoutConfig) time.Duration {
	if ctx == nil {
		return 0
	}

	timeout := cfg.DefaultTimeout

	if tenant := ctx.TenantID; tenant != "" && cfg.TenantTimeouts != nil {
		if t, ok := cfg.TenantTimeouts[tenant]; ok {
			timeout = t
		}
	}

	if cfg.OperationTimeouts != nil {
		op := fmt.Sprintf("%s:%s", ctx.Request.Method, ctx.Request.Path)
		if t, ok := cfg.OperationTimeouts[op]; ok {
			timeout = t
		}
	}

	if ctx.RemainingMS > 0 {
		remaining := time.Duration(ctx.RemainingMS) * time.Millisecond
		if remaining > 0 && remaining < timeout {
			timeout = remaining
		}
	}

	return timeout
}
