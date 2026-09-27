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

// timeoutMiddlewareJoinGrace bounds how long the timeout middleware waits for
// the handler it timed out to unwind before returning the timeout response.
//
// A handler that observes its canceled context returns immediately and is never
// left running. A handler that ignores cancellation is the case this middleware
// exists to bound, so its response is not held open for the handler's full
// runtime; it is the one documented place where a handler the middleware started
// can still be running when the response is returned.
const timeoutMiddlewareJoinGrace = 250 * time.Millisecond

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

			type result struct {
				resp *Response
				err  error
			}

			ch := make(chan result, 1)
			go func() {
				defer func() {
					if r := recover(); r != nil {
						ch <- result{resp: nil, err: &AppError{Code: errorCodeInternal, Message: errorMessageInternal}}
					}
				}()
				resp, err := next(handlerCtx)
				ch <- result{resp: resp, err: err}
			}()

			select {
			case res := <-ch:
				return res.resp, res.err
			case <-timeoutCtx.Done():
				// The deadline expired and the handler chain's context is
				// canceled, but the invocation must not return while the handler
				// this middleware started can still run: in Lambda the execution
				// environment is frozen once the handler returns, so detached work
				// resumes at an unpredictable time (or never). Wait for the
				// handler to unwind.
				//
				// The wait is bounded. A handler that observes its context
				// returns immediately, and is therefore never left running; a
				// handler that ignores cancellation is exactly the case this
				// middleware exists to bound, so its response is not held open
				// for the handler's full runtime.
				joinTimer := time.NewTimer(timeoutMiddlewareJoinGrace)
				defer joinTimer.Stop()
				select {
				case <-ch:
				case <-joinTimer.C:
				}
				return nil, &AppError{Code: errorCodeTimeout, Message: cfg.TimeoutMessage}
			}
		}
	}
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
