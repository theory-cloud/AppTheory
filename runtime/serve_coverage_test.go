package apptheory

import (
	"context"
	"testing"
)

func TestServe_NilAppOrNilRouter_ReturnsInternal(t *testing.T) {
	t.Parallel()

	var nilApp *App
	resp := nilApp.Serve(context.Background(), Request{Method: "GET", Path: "/"})
	if resp.Status != 500 {
		t.Fatalf("expected 500 for nil app, got %d", resp.Status)
	}

	app := New()
	app.router = nil
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/"})
	if resp.Status != 500 {
		t.Fatalf("expected 500 for nil router, got %d", resp.Status)
	}
}

func TestHandle_InitializesRouterAndSkipsNilOptions(t *testing.T) {
	t.Parallel()

	app := &App{
		clock: RealClock{},
		ids:   fixedIDGenerator("req_1"),
		tier:  TierP2,
	}

	app.Handle("GET", "/", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil }, nil)

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/"})
	if resp.Status != 200 || string(resp.Body) != "ok" {
		t.Fatalf("unexpected response: %#v", resp)
	}
}

func TestServePortable_PanicRecoveryAndNilHandlerOutput(t *testing.T) {
	t.Parallel()

	app := New(WithTier(TierP2), WithIDGenerator(fixedIDGenerator("req_panic")))

	app.Get("/panic", func(*Context) (*Response, error) {
		panic("boom")
	})
	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/panic"})
	if resp.Status != 500 {
		t.Fatalf("expected 500 after panic, got %d", resp.Status)
	}
	if got := resp.Headers["x-request-id"]; len(got) != 1 || got[0] == "" {
		t.Fatalf("expected x-request-id to be set, got %#v", resp.Headers)
	}

	app.Get("/nil", func(*Context) (*Response, error) {
		return nil, nil
	})
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/nil"})
	if resp.Status != 500 {
		t.Fatalf("expected 500 for nil handler output, got %d", resp.Status)
	}
}

func TestApp_newRequestID_NilReceiverUsesRandom(t *testing.T) {
	t.Parallel()

	var nilApp *App
	if got := nilApp.newRequestID(); got == "" {
		t.Fatal("expected non-empty request id")
	}
}

func TestHandle_NilReceiver_IsNoOp(t *testing.T) {
	t.Parallel()

	var nilApp *App
	if got := nilApp.Handle("GET", "/", func(*Context) (*Response, error) { return Text(200, "ok"), nil }); got != nil {
		t.Fatal("expected nil app to remain nil")
	}
}
