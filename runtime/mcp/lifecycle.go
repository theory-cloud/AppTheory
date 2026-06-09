package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

const (
	lifecycleInvalidToolArgumentsMessage = "Invalid params: invalid tool arguments"
	lifecycleMissingToolArgumentsMessage = "Invalid params: missing tool arguments"
	lifecycleNoArgsMessage               = "Invalid params: tool accepts no arguments"
	lifecycleValidationMessage           = "Invalid params: validation failed"
	lifecycleInternalMessage             = "internal error"
)

var (
	errToolLifecycleInvalidArguments = errors.New(lifecycleInvalidToolArgumentsMessage)
	errToolLifecycleMissingArguments = errors.New(lifecycleMissingToolArgumentsMessage)
	errToolLifecycleNoArgs           = errors.New(lifecycleNoArgsMessage)
	errToolLifecycleValidation       = errors.New(lifecycleValidationMessage)
	errToolLifecycleInternal         = errors.New(lifecycleInternalMessage)
)

// ToolLifecycleOutcome describes the sanitized result class for a wrapped MCP
// tool invocation. Outcomes intentionally carry no raw tool arguments, bearer
// tokens, panic values, or unhandled error text.
type ToolLifecycleOutcome string

const (
	ToolLifecycleOutcomeSuccess         ToolLifecycleOutcome = "success"
	ToolLifecycleOutcomeInvalidParams   ToolLifecycleOutcome = "invalid_params"
	ToolLifecycleOutcomeHandledError    ToolLifecycleOutcome = "handled_error"
	ToolLifecycleOutcomeTimeout         ToolLifecycleOutcome = "timeout"
	ToolLifecycleOutcomePanic           ToolLifecycleOutcome = "panic"
	ToolLifecycleOutcomeUnhandledError  ToolLifecycleOutcome = "unhandled_error"
	ToolLifecycleOutcomeContextCanceled ToolLifecycleOutcome = "context_canceled"
)

// ToolLifecycleStart is emitted before a wrapped MCP tool handler runs. It is a
// sanitized telemetry payload and intentionally excludes raw arguments.
type ToolLifecycleStart struct {
	Name      string    `json:"name"`
	StartedAt time.Time `json:"startedAt"`
}

// ToolLifecycleFinish is emitted after a wrapped MCP tool handler finishes. It
// is a sanitized telemetry payload and intentionally excludes raw arguments,
// bearer tokens, panic values, and unhandled error text.
type ToolLifecycleFinish struct {
	Name              string               `json:"name"`
	StartedAt         time.Time            `json:"startedAt"`
	FinishedAt        time.Time            `json:"finishedAt"`
	Duration          time.Duration        `json:"duration"`
	Outcome           ToolLifecycleOutcome `json:"outcome"`
	JSONRPCErrorCode  int                  `json:"jsonrpcErrorCode,omitempty"`
	ResultMarkedError bool                 `json:"resultMarkedError,omitempty"`
}

// ToolLifecycleTelemetry configures sanitized lifecycle hooks for wrapped MCP
// tool handlers. Hook payloads are deliberately small and safe for logs or
// metrics; raw request arguments and raw error values are never supplied.
type ToolLifecycleTelemetry struct {
	Start  func(context.Context, ToolLifecycleStart)
	Finish func(context.Context, ToolLifecycleFinish)
}

// ToolLifecycleOptions configures WrapTool and WrapStreamingTool. The wrapper is
// a handler adapter only: callers still register the returned handler through
// RegisterTool or RegisterStreamingTool, so all buffered, streaming, and task
// execution stays on the single registry dispatch path.
type ToolLifecycleOptions[Args any] struct {
	Name        string
	Timeout     time.Duration
	NoArgs      bool
	StrictJSON  bool
	Validate    func(context.Context, Args) error
	HandleError func(context.Context, error) (*ToolResult, bool)
	Telemetry   ToolLifecycleTelemetry
	Clock       apptheory.Clock
}

// WrapTool adapts a typed MCP tool handler to the raw ToolHandler contract while
// applying one lifecycle policy for argument binding, validation, timeout,
// handled product failures, sanitized unhandled failures, panic recovery, and
// telemetry.
func WrapTool[Args any](options ToolLifecycleOptions[Args], handler func(context.Context, Args) (*ToolResult, error)) ToolHandler {
	return func(ctx context.Context, raw json.RawMessage) (result *ToolResult, err error) {
		return runToolLifecycle(ctx, raw, options, func(runCtx context.Context, args Args) (*ToolResult, error) {
			return handler(runCtx, args)
		})
	}
}

// WrapStreamingTool adapts a typed MCP streaming tool handler to the raw
// StreamingToolHandler contract while applying the same lifecycle policy as
// WrapTool. It remains a registration-time adapter; streaming dispatch still
// goes through ToolRegistry.CallStreaming.
func WrapStreamingTool[Args any](
	options ToolLifecycleOptions[Args],
	handler func(context.Context, Args, func(SSEEvent)) (*ToolResult, error),
) StreamingToolHandler {
	return func(ctx context.Context, raw json.RawMessage, emit func(SSEEvent)) (result *ToolResult, err error) {
		return runToolLifecycle(ctx, raw, options, func(runCtx context.Context, args Args) (*ToolResult, error) {
			return handler(runCtx, args, emit)
		})
	}
}

func runToolLifecycle[Args any](
	ctx context.Context,
	raw json.RawMessage,
	options ToolLifecycleOptions[Args],
	handler func(context.Context, Args) (*ToolResult, error),
) (result *ToolResult, err error) {
	clock := options.Clock
	if clock == nil {
		clock = apptheory.RealClock{}
	}

	startedAt := clock.Now().UTC()
	if options.Telemetry.Start != nil {
		callToolLifecycleStart(ctx, options.Telemetry.Start, ToolLifecycleStart{Name: options.Name, StartedAt: startedAt})
	}

	outcome := ToolLifecycleOutcomeSuccess
	jsonrpcCode := 0
	resultMarkedError := false
	telemetryCtx := ctx
	defer func() {
		if recovered := recover(); recovered != nil {
			outcome = ToolLifecycleOutcomePanic
			jsonrpcCode = CodeInternalError
			result = nil
			err = lifecycleInternalError()
		}

		if options.Telemetry.Finish != nil {
			finishedAt := clock.Now().UTC()
			duration := finishedAt.Sub(startedAt)
			if duration < 0 {
				duration = 0
			}
			callToolLifecycleFinish(telemetryCtx, options.Telemetry.Finish, ToolLifecycleFinish{
				Name:              options.Name,
				StartedAt:         startedAt,
				FinishedAt:        finishedAt,
				Duration:          duration,
				Outcome:           outcome,
				JSONRPCErrorCode:  jsonrpcCode,
				ResultMarkedError: resultMarkedError,
			})
		}
	}()

	args, bindErr := bindToolLifecycleArgs(ctx, raw, options)
	if bindErr != nil {
		outcome = ToolLifecycleOutcomeInvalidParams
		jsonrpcCode = CodeInvalidParams
		return nil, bindErr
	}

	runCtx := ctx
	cancel := func() {}
	if options.Timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, options.Timeout)
	}
	defer cancel()
	telemetryCtx = runCtx

	result, err = handler(runCtx, args)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || runCtx.Err() == context.DeadlineExceeded {
			outcome = ToolLifecycleOutcomeTimeout
			jsonrpcCode = CodeServerError
			return nil, context.DeadlineExceeded
		}
		if errors.Is(err, context.Canceled) || runCtx.Err() == context.Canceled {
			outcome = ToolLifecycleOutcomeContextCanceled
			jsonrpcCode = CodeServerError
			return nil, context.Canceled
		}
		if options.HandleError != nil {
			if handled, ok := options.HandleError(runCtx, err); ok {
				outcome = ToolLifecycleOutcomeHandledError
				if handled == nil {
					handled = &ToolResult{IsError: true}
				}
				if handled.IsError {
					resultMarkedError = true
				}
				return handled, nil
			}
		}
		outcome = ToolLifecycleOutcomeUnhandledError
		jsonrpcCode = CodeInternalError
		return nil, lifecycleInternalError()
	}
	if runCtx.Err() == context.DeadlineExceeded {
		outcome = ToolLifecycleOutcomeTimeout
		jsonrpcCode = CodeServerError
		return nil, context.DeadlineExceeded
	}
	if result != nil && result.IsError {
		resultMarkedError = true
	}
	return result, nil
}

func bindToolLifecycleArgs[Args any](ctx context.Context, raw json.RawMessage, options ToolLifecycleOptions[Args]) (Args, error) {
	var args Args

	if options.NoArgs {
		if !emptyToolLifecycleArgs(raw) {
			return args, errToolLifecycleNoArgs
		}
		if options.Validate != nil {
			if err := options.Validate(ctx, args); err != nil {
				return args, errToolLifecycleValidation
			}
		}
		return args, nil
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return args, errToolLifecycleMissingArguments
	}
	if trimmed[0] != '{' {
		return args, errToolLifecycleInvalidArguments
	}

	if options.StrictJSON {
		dec := json.NewDecoder(bytes.NewReader(trimmed))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&args); err != nil {
			return args, errToolLifecycleInvalidArguments
		}
		var extra any
		if err := dec.Decode(&extra); err != io.EOF {
			return args, errToolLifecycleInvalidArguments
		}
	} else if err := json.Unmarshal(trimmed, &args); err != nil {
		return args, errToolLifecycleInvalidArguments
	}

	if options.Validate != nil {
		if err := options.Validate(ctx, args); err != nil {
			return args, errToolLifecycleValidation
		}
	}

	return args, nil
}

func callToolLifecycleStart(ctx context.Context, hook func(context.Context, ToolLifecycleStart), event ToolLifecycleStart) {
	defer func() {
		_ = recover()
	}()
	hook(ctx, event)
}

func callToolLifecycleFinish(ctx context.Context, hook func(context.Context, ToolLifecycleFinish), event ToolLifecycleFinish) {
	defer func() {
		_ = recover()
	}()
	hook(ctx, event)
}

func emptyToolLifecycleArgs(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return true
	}

	var args map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &args); err != nil {
		return false
	}
	return len(args) == 0
}

func lifecycleInternalError() error {
	return errToolLifecycleInternal
}

func toolLifecycleRPCError(err error) (*RPCError, bool) {
	switch {
	case errors.Is(err, errToolLifecycleInvalidArguments):
		return &RPCError{Code: CodeInvalidParams, Message: lifecycleInvalidToolArgumentsMessage}, true
	case errors.Is(err, errToolLifecycleMissingArguments):
		return &RPCError{Code: CodeInvalidParams, Message: lifecycleMissingToolArgumentsMessage}, true
	case errors.Is(err, errToolLifecycleNoArgs):
		return &RPCError{Code: CodeInvalidParams, Message: lifecycleNoArgsMessage}, true
	case errors.Is(err, errToolLifecycleValidation):
		return &RPCError{Code: CodeInvalidParams, Message: lifecycleValidationMessage}, true
	case errors.Is(err, errToolLifecycleInternal):
		return &RPCError{Code: CodeInternalError, Message: lifecycleInternalMessage}, true
	default:
		return nil, false
	}
}

func toolLifecycleErrorResponse(reqID any, err error) (*Response, bool) {
	rpcErr, ok := toolLifecycleRPCError(err)
	if !ok {
		return nil, false
	}
	return &Response{
		JSONRPC: jsonrpcVersion,
		ID:      reqID,
		Error:   rpcErr,
	}, true
}

func formatToolTimeoutMessage(toolName string) string {
	return fmt.Sprintf("tool %q timed out", toolName)
}
