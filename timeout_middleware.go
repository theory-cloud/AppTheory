package apptheory

import (
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
				resp, err := next(ctx)
				ch <- result{resp: resp, err: err}
			}()

			timer := time.NewTimer(timeout)
			defer timer.Stop()

			select {
			case res := <-ch:
				return res.resp, res.err
			case <-timer.C:
				return nil, &AppError{Code: errorCodeTimeout, Message: cfg.TimeoutMessage}
			}
		}
	}
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
