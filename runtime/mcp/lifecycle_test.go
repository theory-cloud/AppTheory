package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type lifecycleTelemetryRecorder struct {
	mu       sync.Mutex
	starts   []ToolLifecycleStart
	finishes []ToolLifecycleFinish
}

type lifecycleSequenceClock struct {
	mu     sync.Mutex
	values []time.Time
}

func (c *lifecycleSequenceClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.values) == 0 {
		return time.Unix(0, 0)
	}
	next := c.values[0]
	c.values = c.values[1:]
	return next
}

func (r *lifecycleTelemetryRecorder) telemetry() ToolLifecycleTelemetry {
	return ToolLifecycleTelemetry{
		Start: func(_ context.Context, ev ToolLifecycleStart) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.starts = append(r.starts, ev)
		},
		Finish: func(_ context.Context, ev ToolLifecycleFinish) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.finishes = append(r.finishes, ev)
		},
	}
}

func (r *lifecycleTelemetryRecorder) finishOutcomes() []ToolLifecycleOutcome {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ToolLifecycleOutcome, len(r.finishes))
	for i, ev := range r.finishes {
		out[i] = ev.Outcome
	}
	return out
}

func (r *lifecycleTelemetryRecorder) marshalFinishes(t *testing.T) string {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	b, err := json.Marshal(r.finishes)
	if err != nil {
		t.Fatalf("marshal telemetry: %v", err)
	}
	return string(b)
}

func TestWrapToolLifecycle_BufferedPolicy(t *testing.T) {
	type echoArgs struct {
		Message string `json:"message"`
	}
	productErr := errors.New("product failure with bearer-secret-123")
	rec := &lifecycleTelemetryRecorder{}
	s := NewServer("test", "dev")

	if err := s.Registry().RegisterTool(ToolDef{
		Name:        "echo",
		Description: "wrapped echo",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`),
	}, WrapTool(ToolLifecycleOptions[echoArgs]{
		Name:       "echo",
		StrictJSON: true,
		Validate: func(_ context.Context, args echoArgs) error {
			if strings.TrimSpace(args.Message) == "" {
				return errors.New("validation mentioned bearer-secret-123")
			}
			return nil
		},
		HandleError: func(_ context.Context, err error) (*ToolResult, bool) {
			if errors.Is(err, productErr) {
				return &ToolResult{
					IsError: true,
					Content: []ContentBlock{{Type: "text", Text: "safe product failure"}},
				}, true
			}
			return nil, false
		},
		Telemetry: rec.telemetry(),
	}, func(_ context.Context, args echoArgs) (*ToolResult, error) {
		switch args.Message {
		case "handled":
			return nil, productErr
		case "unhandled":
			return nil, errors.New("unhandled bearer-secret-123")
		case "panic":
			panic("panic bearer-secret-123")
		default:
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: args.Message}}}, nil
		}
	})); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	success := s.dispatchForProtocol(context.Background(), toolLifecycleCallRequest(1, "echo", `{"message":"ok"}`, false), protocolVersion, "sess-1")
	if success.Error != nil {
		t.Fatalf("success error: %+v", success.Error)
	}
	successResult, ok := success.Result.(*ToolResult)
	if !ok || len(successResult.Content) != 1 || successResult.Content[0].Text != "ok" {
		t.Fatalf("unexpected success result: %#v", success.Result)
	}

	invalid := s.dispatchForProtocol(
		context.Background(),
		toolLifecycleCallRequest(2, "echo", `{"message":"ok","bearer-secret-123":"leak"}`, false),
		protocolVersion,
		"sess-1",
	)
	if invalid.Error == nil || invalid.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid params, got %+v", invalid.Error)
	}
	if strings.Contains(invalid.Error.Message, "bearer-secret-123") {
		t.Fatalf("invalid params leaked raw argument data: %q", invalid.Error.Message)
	}

	handled := s.dispatchForProtocol(context.Background(), toolLifecycleCallRequest(3, "echo", `{"message":"handled"}`, false), protocolVersion, "sess-1")
	if handled.Error != nil {
		t.Fatalf("handled product failure returned JSON-RPC error: %+v", handled.Error)
	}
	handledResult, ok := handled.Result.(*ToolResult)
	if !ok || !handledResult.IsError || handledResult.Content[0].Text != "safe product failure" {
		t.Fatalf("unexpected handled result: %#v", handled.Result)
	}

	unhandled := s.dispatchForProtocol(context.Background(), toolLifecycleCallRequest(4, "echo", `{"message":"unhandled"}`, false), protocolVersion, "sess-1")
	if unhandled.Error == nil || unhandled.Error.Code != CodeInternalError || unhandled.Error.Message != lifecycleInternalMessage {
		t.Fatalf("expected sanitized internal error, got %+v", unhandled.Error)
	}
	if strings.Contains(unhandled.Error.Message, "bearer-secret-123") {
		t.Fatalf("unhandled error leaked raw error text: %q", unhandled.Error.Message)
	}

	panicked := s.dispatchForProtocol(context.Background(), toolLifecycleCallRequest(5, "echo", `{"message":"panic"}`, false), protocolVersion, "sess-1")
	if panicked.Error == nil || panicked.Error.Code != CodeInternalError || panicked.Error.Message != lifecycleInternalMessage {
		t.Fatalf("expected sanitized panic error, got %+v", panicked.Error)
	}

	assertLifecycleOutcomes(t, rec.finishOutcomes(),
		ToolLifecycleOutcomeSuccess,
		ToolLifecycleOutcomeInvalidParams,
		ToolLifecycleOutcomeHandledError,
		ToolLifecycleOutcomeUnhandledError,
		ToolLifecycleOutcomePanic,
	)
	if telemetry := rec.marshalFinishes(t); strings.Contains(telemetry, "bearer-secret-123") {
		t.Fatalf("telemetry leaked raw args/errors/panic values: %s", telemetry)
	}
}

func TestWrapToolLifecycle_NoArgs(t *testing.T) {
	rec := &lifecycleTelemetryRecorder{}
	s := NewServer("test", "dev")

	if err := s.Registry().RegisterTool(ToolDef{
		Name:        "ping",
		Description: "no-arg wrapped tool",
		InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`),
	}, WrapTool(ToolLifecycleOptions[struct{}]{
		Name:      "ping",
		NoArgs:    true,
		Telemetry: rec.telemetry(),
	}, func(context.Context, struct{}) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "pong"}}}, nil
	})); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	omitted := s.dispatchForProtocol(context.Background(), toolLifecycleCallRequest(1, "ping", "", false), protocolVersion, "sess-1")
	if omitted.Error != nil {
		t.Fatalf("omitted args error: %+v", omitted.Error)
	}
	empty := s.dispatchForProtocol(context.Background(), toolLifecycleCallRequest(2, "ping", `{}`, false), protocolVersion, "sess-1")
	if empty.Error != nil {
		t.Fatalf("empty args error: %+v", empty.Error)
	}
	extra := s.dispatchForProtocol(context.Background(), toolLifecycleCallRequest(3, "ping", `{"secret":"bearer-secret-123"}`, false), protocolVersion, "sess-1")
	if extra.Error == nil || extra.Error.Code != CodeInvalidParams {
		t.Fatalf("expected extra args to fail closed, got %+v", extra.Error)
	}
	if strings.Contains(extra.Error.Message, "bearer-secret-123") {
		t.Fatalf("no-arg error leaked raw args: %q", extra.Error.Message)
	}

	assertLifecycleOutcomes(t, rec.finishOutcomes(),
		ToolLifecycleOutcomeSuccess,
		ToolLifecycleOutcomeSuccess,
		ToolLifecycleOutcomeInvalidParams,
	)
}

func TestWrapStreamingToolLifecycle_StreamingPolicy(t *testing.T) {
	type streamArgs struct {
		Steps int `json:"steps"`
	}
	rec := &lifecycleTelemetryRecorder{}
	s := NewServer("test", "dev")
	sessionID := initializeSession(t, s)

	if err := s.Registry().RegisterStreamingTool(ToolDef{
		Name:        "stream_count",
		Description: "wrapped streaming counter",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"steps":{"type":"integer","minimum":1}},"required":["steps"]}`),
	}, WrapStreamingTool(ToolLifecycleOptions[streamArgs]{
		Name:       "stream_count",
		StrictJSON: true,
		Validate: func(_ context.Context, args streamArgs) error {
			if args.Steps <= 0 {
				return errors.New("validation bearer-secret-123")
			}
			return nil
		},
		Telemetry: rec.telemetry(),
	}, func(_ context.Context, args streamArgs, emit func(SSEEvent)) (*ToolResult, error) {
		if args.Steps == 13 {
			return nil, errors.New("stream bearer-secret-123")
		}
		emit(SSEEvent{Data: map[string]any{"progress": 1, "total": args.Steps, "message": "started"}})
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "stream ok"}}}, nil
	})); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	successStream := invokeLifecycleStream(t, s, sessionID, toolLifecycleStreamingCallRequest(1, "stream_count", `{"steps":2}`))
	if !strings.Contains(successStream, `"method":"notifications/progress"`) {
		t.Fatalf("expected progress notification, got:\n%s", successStream)
	}
	if !strings.Contains(successStream, `"text":"stream ok"`) {
		t.Fatalf("expected final result, got:\n%s", successStream)
	}

	invalidStream := invokeLifecycleStream(
		t,
		s,
		sessionID,
		toolLifecycleCallRequest(2, "stream_count", `{"steps":2,"bearer-secret-123":"leak"}`, false),
	)
	if !strings.Contains(invalidStream, `"code":-32602`) {
		t.Fatalf("expected invalid params in stream, got:\n%s", invalidStream)
	}
	if strings.Contains(invalidStream, "bearer-secret-123") {
		t.Fatalf("stream invalid params leaked raw args:\n%s", invalidStream)
	}

	unhandledStream := invokeLifecycleStream(t, s, sessionID, toolLifecycleCallRequest(3, "stream_count", `{"steps":13}`, false))
	if !strings.Contains(unhandledStream, `"code":-32603`) || !strings.Contains(unhandledStream, `"message":"internal error"`) {
		t.Fatalf("expected sanitized internal stream error, got:\n%s", unhandledStream)
	}
	if strings.Contains(unhandledStream, "bearer-secret-123") {
		t.Fatalf("stream unhandled error leaked raw error text:\n%s", unhandledStream)
	}

	assertLifecycleOutcomes(t, rec.finishOutcomes(),
		ToolLifecycleOutcomeSuccess,
		ToolLifecycleOutcomeInvalidParams,
		ToolLifecycleOutcomeUnhandledError,
	)
	if telemetry := rec.marshalFinishes(t); strings.Contains(telemetry, "bearer-secret-123") {
		t.Fatalf("stream telemetry leaked raw args/errors: %s", telemetry)
	}
}

func TestWrapToolLifecycle_TaskPolicy(t *testing.T) {
	type taskArgs struct {
		Mode string `json:"mode"`
	}
	productErr := errors.New("task product failure bearer-secret-123")

	run := func(t *testing.T, args string) (*TaskRecord, *lifecycleTelemetryRecorder) {
		t.Helper()
		rec := &lifecycleTelemetryRecorder{}
		store := NewMemoryTaskStore()
		s := NewServer("test", "dev",
			WithServerIDGenerator(staticIDGenerator{id: "task-lifecycle"}),
			WithTaskRuntime(TaskRuntimeOptions{
				Store:        store,
				PollInterval: time.Millisecond,
			}),
		)
		if err := s.Registry().RegisterTool(ToolDef{
			Name:        "task_tool",
			Description: "wrapped task tool",
			Execution:   &ToolExecution{TaskSupport: TaskSupportOptional},
			InputSchema: json.RawMessage(`{"type":"object","properties":{"mode":{"type":"string"}},"required":["mode"]}`),
		}, WrapTool(ToolLifecycleOptions[taskArgs]{
			Name:       "task_tool",
			StrictJSON: true,
			Validate: func(_ context.Context, args taskArgs) error {
				if args.Mode == "" {
					return errors.New("validation bearer-secret-123")
				}
				return nil
			},
			HandleError: func(_ context.Context, err error) (*ToolResult, bool) {
				if errors.Is(err, productErr) {
					return &ToolResult{
						IsError: true,
						Content: []ContentBlock{{Type: "text", Text: "safe task product failure"}},
					}, true
				}
				return nil, false
			},
			Telemetry: rec.telemetry(),
		}, func(_ context.Context, args taskArgs) (*ToolResult, error) {
			switch args.Mode {
			case "handled":
				return nil, productErr
			case "unhandled":
				return nil, errors.New("task bearer-secret-123")
			default:
				return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "task ok"}}}, nil
			}
		})); err != nil {
			t.Fatalf("register task tool: %v", err)
		}

		createResp := s.dispatchForProtocol(context.Background(), toolLifecycleCallRequest(1, "task_tool", args, true), protocolVersion, "sess-1")
		if createResp.Error != nil {
			t.Fatalf("create task: %+v", createResp.Error)
		}
		record := waitForTaskTerminal(t, store, "sess-1", "task-lifecycle")
		return record, rec
	}

	success, successRec := run(t, `{"mode":"success"}`)
	if success.Task.Status != TaskStatusCompleted || success.Error != nil || !strings.Contains(string(success.Result), "task ok") {
		t.Fatalf("unexpected task success record: %+v result=%s", success, string(success.Result))
	}
	assertLifecycleOutcomes(t, successRec.finishOutcomes(), ToolLifecycleOutcomeSuccess)

	invalid, invalidRec := run(t, `{"bearer-secret-123":"leak"}`)
	if invalid.Task.Status != TaskStatusFailed || invalid.Error == nil || invalid.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid task failure, got %+v", invalid)
	}
	if strings.Contains(invalid.Error.Message, "bearer-secret-123") {
		t.Fatalf("task invalid params leaked raw args: %q", invalid.Error.Message)
	}
	assertLifecycleOutcomes(t, invalidRec.finishOutcomes(), ToolLifecycleOutcomeInvalidParams)

	handled, handledRec := run(t, `{"mode":"handled"}`)
	if handled.Task.Status != TaskStatusFailed || handled.Error != nil || !strings.Contains(string(handled.Result), "safe task product failure") {
		t.Fatalf("unexpected handled task record: %+v result=%s", handled, string(handled.Result))
	}
	assertLifecycleOutcomes(t, handledRec.finishOutcomes(), ToolLifecycleOutcomeHandledError)

	unhandled, unhandledRec := run(t, `{"mode":"unhandled"}`)
	if unhandled.Task.Status != TaskStatusFailed || unhandled.Error == nil || unhandled.Error.Code != CodeInternalError || unhandled.Error.Message != lifecycleInternalMessage {
		t.Fatalf("expected sanitized unhandled task failure, got %+v", unhandled)
	}
	if strings.Contains(unhandled.Error.Message, "bearer-secret-123") {
		t.Fatalf("task unhandled error leaked raw error text: %q", unhandled.Error.Message)
	}
	assertLifecycleOutcomes(t, unhandledRec.finishOutcomes(), ToolLifecycleOutcomeUnhandledError)
	if telemetry := unhandledRec.marshalFinishes(t); strings.Contains(telemetry, "bearer-secret-123") {
		t.Fatalf("task telemetry leaked raw args/errors: %s", telemetry)
	}
}

func TestWrapToolLifecycle_TimeoutMapsToSafeTimeout(t *testing.T) {
	type args struct {
		Message string `json:"message"`
	}
	rec := &lifecycleTelemetryRecorder{}
	s := NewServer("test", "dev")

	if err := s.Registry().RegisterTool(ToolDef{
		Name:        "timeout_tool",
		Description: "wrapped timeout tool",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}}}`),
	}, WrapTool(ToolLifecycleOptions[args]{
		Name:      "timeout_tool",
		Timeout:   time.Nanosecond,
		Telemetry: rec.telemetry(),
	}, func(ctx context.Context, _ args) (*ToolResult, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	resp := s.dispatchForProtocol(context.Background(), toolLifecycleCallRequest(1, "timeout_tool", `{"message":"ok"}`, false), protocolVersion, "sess-1")
	if resp.Error == nil || resp.Error.Code != CodeServerError || resp.Error.Message != `tool "timeout_tool" timed out` {
		t.Fatalf("expected safe timeout error, got %+v", resp.Error)
	}
	assertLifecycleOutcomes(t, rec.finishOutcomes(), ToolLifecycleOutcomeTimeout)
}

func TestWrapToolLifecycle_EdgeCasesStaySanitized(t *testing.T) {
	type args struct {
		Message string `json:"message"`
	}

	t.Run("missing arguments", func(t *testing.T) {
		rec := &lifecycleTelemetryRecorder{}
		handler := WrapTool(ToolLifecycleOptions[args]{Name: "edge", Telemetry: rec.telemetry()}, func(context.Context, args) (*ToolResult, error) {
			t.Fatal("handler should not run")
			return nil, nil
		})
		_, err := handler(context.Background(), nil)
		assertLifecycleRPCError(t, err, CodeInvalidParams, lifecycleMissingToolArgumentsMessage)
		assertLifecycleOutcomes(t, rec.finishOutcomes(), ToolLifecycleOutcomeInvalidParams)
	})

	t.Run("non-object arguments", func(t *testing.T) {
		handler := WrapTool(ToolLifecycleOptions[args]{Name: "edge"}, func(context.Context, args) (*ToolResult, error) {
			t.Fatal("handler should not run")
			return nil, nil
		})
		_, err := handler(context.Background(), json.RawMessage(`["bearer-secret-123"]`))
		assertLifecycleRPCError(t, err, CodeInvalidParams, lifecycleInvalidToolArgumentsMessage)
		if strings.Contains(err.Error(), "bearer-secret-123") {
			t.Fatalf("non-object args leaked raw input: %v", err)
		}
	})

	t.Run("strict trailing json", func(t *testing.T) {
		handler := WrapTool(ToolLifecycleOptions[args]{Name: "edge", StrictJSON: true}, func(context.Context, args) (*ToolResult, error) {
			t.Fatal("handler should not run")
			return nil, nil
		})
		_, err := handler(context.Background(), json.RawMessage(`{"message":"ok"} {}`))
		assertLifecycleRPCError(t, err, CodeInvalidParams, lifecycleInvalidToolArgumentsMessage)
	})

	t.Run("non-strict invalid json", func(t *testing.T) {
		handler := WrapTool(ToolLifecycleOptions[map[string]any]{Name: "edge"}, func(context.Context, map[string]any) (*ToolResult, error) {
			t.Fatal("handler should not run")
			return nil, nil
		})
		_, err := handler(context.Background(), json.RawMessage(`{"message":`))
		assertLifecycleRPCError(t, err, CodeInvalidParams, lifecycleInvalidToolArgumentsMessage)
	})

	t.Run("validation failure", func(t *testing.T) {
		handler := WrapTool(ToolLifecycleOptions[args]{
			Name: "edge",
			Validate: func(context.Context, args) error {
				return errors.New("validation bearer-secret-123")
			},
		}, func(context.Context, args) (*ToolResult, error) {
			t.Fatal("handler should not run")
			return nil, nil
		})
		_, err := handler(context.Background(), json.RawMessage(`{"message":"ok"}`))
		assertLifecycleRPCError(t, err, CodeInvalidParams, lifecycleValidationMessage)
		if strings.Contains(err.Error(), "bearer-secret-123") {
			t.Fatalf("validation error leaked raw text: %v", err)
		}
	})

	t.Run("no args validation failure", func(t *testing.T) {
		handler := WrapTool(ToolLifecycleOptions[struct{}]{
			Name:   "edge",
			NoArgs: true,
			Validate: func(context.Context, struct{}) error {
				return errors.New("validation bearer-secret-123")
			},
		}, func(context.Context, struct{}) (*ToolResult, error) {
			t.Fatal("handler should not run")
			return nil, nil
		})
		_, err := handler(context.Background(), json.RawMessage(`null`))
		assertLifecycleRPCError(t, err, CodeInvalidParams, lifecycleValidationMessage)
	})

	t.Run("no args invalid json", func(t *testing.T) {
		handler := WrapTool(ToolLifecycleOptions[struct{}]{
			Name:   "edge",
			NoArgs: true,
		}, func(context.Context, struct{}) (*ToolResult, error) {
			t.Fatal("handler should not run")
			return nil, nil
		})
		_, err := handler(context.Background(), json.RawMessage(`{`))
		assertLifecycleRPCError(t, err, CodeInvalidParams, lifecycleNoArgsMessage)
	})

	t.Run("successful isError result is reported", func(t *testing.T) {
		rec := &lifecycleTelemetryRecorder{}
		handler := WrapTool(ToolLifecycleOptions[args]{
			Name:      "edge",
			Telemetry: rec.telemetry(),
		}, func(context.Context, args) (*ToolResult, error) {
			return &ToolResult{IsError: true}, nil
		})
		result, err := handler(context.Background(), json.RawMessage(`{"message":"ok"}`))
		if err != nil {
			t.Fatalf("isError result returned error: %v", err)
		}
		if result == nil || !result.IsError {
			t.Fatalf("expected isError result, got %#v", result)
		}
		rec.mu.Lock()
		defer rec.mu.Unlock()
		if len(rec.finishes) != 1 || !rec.finishes[0].ResultMarkedError {
			t.Fatalf("expected ResultMarkedError telemetry, got %+v", rec.finishes)
		}
	})

	t.Run("context canceled", func(t *testing.T) {
		rec := &lifecycleTelemetryRecorder{}
		handler := WrapTool(ToolLifecycleOptions[args]{Name: "edge", Telemetry: rec.telemetry()}, func(context.Context, args) (*ToolResult, error) {
			return nil, context.Canceled
		})
		_, err := handler(context.Background(), json.RawMessage(`{"message":"ok"}`))
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context canceled, got %v", err)
		}
		assertLifecycleOutcomes(t, rec.finishOutcomes(), ToolLifecycleOutcomeContextCanceled)
	})

	t.Run("handle error nil result", func(t *testing.T) {
		rec := &lifecycleTelemetryRecorder{}
		handler := WrapTool(ToolLifecycleOptions[args]{
			Name:      "edge",
			Telemetry: rec.telemetry(),
			HandleError: func(context.Context, error) (*ToolResult, bool) {
				return nil, true
			},
		}, func(context.Context, args) (*ToolResult, error) {
			return nil, errors.New("handled bearer-secret-123")
		})
		result, err := handler(context.Background(), json.RawMessage(`{"message":"ok"}`))
		if err != nil {
			t.Fatalf("handled nil result error: %v", err)
		}
		if result == nil || !result.IsError {
			t.Fatalf("expected synthesized isError result, got %#v", result)
		}
		assertLifecycleOutcomes(t, rec.finishOutcomes(), ToolLifecycleOutcomeHandledError)
	})

	t.Run("telemetry hook panics are contained", func(t *testing.T) {
		handler := WrapTool(ToolLifecycleOptions[args]{
			Name:  "edge",
			Clock: fixedClock(time.Unix(100, 0)),
			Telemetry: ToolLifecycleTelemetry{
				Start: func(context.Context, ToolLifecycleStart) {
					panic("start bearer-secret-123")
				},
				Finish: func(context.Context, ToolLifecycleFinish) {
					panic("finish bearer-secret-123")
				},
			},
		}, func(context.Context, args) (*ToolResult, error) {
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		})
		if _, err := handler(context.Background(), json.RawMessage(`{"message":"ok"}`)); err != nil {
			t.Fatalf("telemetry panic should not fail tool: %v", err)
		}
	})

	t.Run("negative clock duration clamps to zero", func(t *testing.T) {
		rec := &lifecycleTelemetryRecorder{}
		handler := WrapTool(ToolLifecycleOptions[args]{
			Name:      "edge",
			Clock:     &lifecycleSequenceClock{values: []time.Time{time.Unix(200, 0), time.Unix(100, 0)}},
			Telemetry: rec.telemetry(),
		}, func(context.Context, args) (*ToolResult, error) {
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		})
		if _, err := handler(context.Background(), json.RawMessage(`{"message":"ok"}`)); err != nil {
			t.Fatalf("negative clock case failed: %v", err)
		}
		rec.mu.Lock()
		defer rec.mu.Unlock()
		if len(rec.finishes) != 1 || rec.finishes[0].Duration != 0 {
			t.Fatalf("expected clamped zero duration, got %+v", rec.finishes)
		}
	})

	t.Run("deadline after nil handler error", func(t *testing.T) {
		rec := &lifecycleTelemetryRecorder{}
		handler := WrapTool(ToolLifecycleOptions[args]{
			Name:      "edge",
			Timeout:   time.Nanosecond,
			Telemetry: rec.telemetry(),
		}, func(ctx context.Context, _ args) (*ToolResult, error) {
			<-ctx.Done()
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "late"}}}, nil
		})
		_, err := handler(context.Background(), json.RawMessage(`{"message":"ok"}`))
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expected deadline, got %v", err)
		}
		assertLifecycleOutcomes(t, rec.finishOutcomes(), ToolLifecycleOutcomeTimeout)
	})
}

func toolLifecycleCallRequest(id int, name, args string, task bool) *Request {
	params := map[string]any{"name": name}
	if args != "" {
		params["arguments"] = json.RawMessage(args)
	}
	if task {
		params["task"] = map[string]any{}
	}
	return &Request{
		JSONRPC: jsonrpcVersion,
		ID:      id,
		Method:  methodToolsCall,
		Params:  mustMarshalJSON(params),
	}
}

func toolLifecycleStreamingCallRequest(id int, name, args string) *Request {
	req := toolLifecycleCallRequest(id, name, args, false)
	var params map[string]any
	if err := json.Unmarshal(req.Params, &params); err != nil {
		panic(err)
	}
	params["_meta"] = map[string]any{"progressToken": "progress-token"}
	req.Params = mustMarshalJSON(params)
	return req
}

func invokeLifecycleStream(t *testing.T, s *Server, sessionID string, req *Request) string {
	t.Helper()
	body := mustMarshal(t, req)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}
	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke stream: %v", err)
	}
	if resp.BodyReader == nil {
		t.Fatalf("expected streaming response BodyReader to be set")
	}
	b, err := io.ReadAll(resp.BodyReader)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	return string(b)
}

func waitForTaskTerminal(t *testing.T, store TaskStore, sessionID, taskID string) *TaskRecord {
	t.Helper()
	deadline := time.After(time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		record, err := store.Get(context.Background(), TaskLookup{SessionID: sessionID, TaskID: taskID})
		if err == nil && (record.Task.Status == TaskStatusCompleted || record.Task.Status == TaskStatusFailed || record.Task.Status == TaskStatusCanceled) {
			return record
		}
		select {
		case <-deadline:
			if err != nil {
				t.Fatalf("task did not reach terminal status: %v", err)
			}
			t.Fatalf("task did not reach terminal status; latest status %s", record.Task.Status)
		case <-ticker.C:
		}
	}
}

func assertLifecycleRPCError(t *testing.T, err error, code int, message string) {
	t.Helper()
	rpcErr, ok := toolLifecycleRPCError(err)
	if !ok {
		t.Fatalf("expected lifecycle RPC error, got %v", err)
	}
	if rpcErr.Code != code || rpcErr.Message != message {
		t.Fatalf("RPC error: got %+v, want code=%d message=%q", rpcErr, code, message)
	}
}

func assertLifecycleOutcomes(t *testing.T, got []ToolLifecycleOutcome, want ...ToolLifecycleOutcome) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("outcomes len: got %d (%v), want %d (%v)", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("outcome[%d]: got %q in %v, want %q", i, got[i], got, want[i])
		}
	}
}
