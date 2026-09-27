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
				// The timeout has expired, and the handler chain's context is
				// cancelled, but the invocation must not return while the handler
				// this middleware started can still run: the work would outlive
				// its invocation (in Lambda the environment is frozen after the
				// handler returns, so a detached handler resumes at an
				// unpredictable time or never). Wait for the handler to unwind
				// before reporting the timeout.
				//
				// The wait is bounded by the handler's own cooperation: a handler
				// that observes its context returns immediately, and one that
				// ignores it holds the invocation until it returns on its own.
				<-ch
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
