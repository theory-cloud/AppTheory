package apptheory

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestNormalizeTimeoutConfig_Defaults(t *testing.T) {
	cfg := normalizeTimeoutConfig(TimeoutConfig{})
	if cfg.DefaultTimeout != 30*time.Second {
		t.Fatalf("expected default timeout 30s, got %v", cfg.DefaultTimeout)
	}
	if cfg.TimeoutMessage != errorMessageTimeout {
		t.Fatalf("expected default timeout message %q, got %q", errorMessageTimeout, cfg.TimeoutMessage)
	}
}

func TestTimeoutForContext_PrioritiesAndClamp(t *testing.T) {
	cfg := TimeoutConfig{
		DefaultTimeout: 100 * time.Millisecond,
		OperationTimeouts: map[string]time.Duration{
			"GET:/op": 50 * time.Millisecond,
		},
		TenantTimeouts: map[string]time.Duration{
			"t1": 20 * time.Millisecond,
		},
		TimeoutMessage: "ignored",
	}

	ctx := &Context{
		Request:     Request{Method: "GET", Path: "/op"},
		TenantID:    "t1",
		RemainingMS: 10, // clamp below tenant/op timeout
	}

	timeout := timeoutForContext(ctx, cfg)
	if timeout != 10*time.Millisecond {
		t.Fatalf("expected remainingMS to clamp timeout to 10ms, got %v", timeout)
	}
}

func TestTimeoutMiddleware_TimeoutAndPanicRecovery(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Use(TimeoutMiddleware(TimeoutConfig{DefaultTimeout: 5 * time.Millisecond}))
	app.Get("/sleep", func(_ *Context) (*Response, error) {
		time.Sleep(50 * time.Millisecond)
		return Text(200, "ok"), nil
	})
	app.Get("/panic", func(_ *Context) (*Response, error) {
		panic("boom")
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/sleep"})
	if resp.Status != 408 {
		t.Fatalf("expected timeout response (408), got %d", resp.Status)
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal timeout body: %v", err)
	}
	errObj, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected error object, got %T", body["error"])
	}
	if errObj["code"] != errorCodeTimeout {
		t.Fatalf("unexpected error code: %v", errObj["code"])
	}

	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/panic"})
	if resp.Status != 500 {
		t.Fatalf("expected internal error response for panic, got %d", resp.Status)
	}
}
