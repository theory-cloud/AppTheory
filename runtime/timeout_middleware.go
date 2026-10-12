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
// the handler chain it timed out to unwind before returning the timeout
// response.
//
// A handler that observes its canceled context returns immediately and is never
// left running. A handler that ignores cancellation is exactly the case this
// middleware exists to bound, so its response is not held open for the
// handler's full runtime; it is the one documented place where a handler the
// middleware started can still be running when the response returns.
const timeoutMiddlewareJoinGrace = 250 * time.Millisecond

// TimeoutMiddleware fails a request closed when its timeout policy expires.
//
// The handler chain runs on a worker goroutine with a deadline-bearing context,
// and the middleware reports app.timeout when the deadline fires while the chain
// is still running -- at the deadline, not after the chain returns. A handler
// that observes its canceled context returns immediately and is never left
// running; a handler that ignores cancellation is exactly the case this
// middleware exists to bound.
//
// The middleware does not abandon the worker: after the deadline it joins the
// worker for a bounded grace window (timeoutMiddlewareJoinGrace) before
// returning the timeout response. A handler that ignores cancellation and does
// not unwind within that window is the one documented place where work the
// middleware started can still be running when the response returns; the Lambda
// function timeout remains its outer bound. A synchronous handler that never
// checks cancellation (for example a CPU loop with no cancellation points)
// cannot be interrupted by the middleware by construction.
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

			// Buffered so the worker can always send and exit, even when the
			// middleware has already returned on the deadline.
			done := make(chan result, 1)
			go func() {
				resp, err := runHandlerWithRecovery(next, handlerCtx)
				done <- result{resp: resp, err: err}
			}()

			select {
			case res := <-done:
				if timeoutCtx.Err() != nil {
					return nil, &AppError{Code: errorCodeTimeout, Message: cfg.TimeoutMessage}
				}
				return res.resp, res.err
			case <-timeoutCtx.Done():
				// The deadline fired and the handler chain's context is
				// canceled. Join the worker for a bounded grace window so a
				// cooperative handler is never left running, then return the
				// timeout response without holding the invocation open for an
				// uncooperative handler.
				joinCtx, joinCancel := context.WithTimeout(context.Background(), timeoutMiddlewareJoinGrace)
				defer joinCancel()
				select {
				case <-done:
				case <-joinCtx.Done():
				}
				return nil, &AppError{Code: errorCodeTimeout, Message: cfg.TimeoutMessage}
			}
		}
	}
}

// runHandlerWithRecovery runs the handler chain on the middleware's worker
// goroutine and converts a panic into the internal error the serve pipeline
// expects, so the middleware keeps its panic recovery on the worker path.
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
