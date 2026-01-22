package apptheory

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestServe_DefaultTierFallback_UnknownTier(t *testing.T) {
	t.Parallel()

	app := New(WithTier(Tier("unknown")))
	app.Get("/", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/"})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}
}

func TestServe_PutAndDelete_WrappersRegisterHandlers(t *testing.T) {
	t.Parallel()

	app := New(WithTier(TierP0))
	app.Put("/put", func(_ *Context) (*Response, error) { return Text(200, "put"), nil })
	app.Delete("/del", func(_ *Context) (*Response, error) { return Text(200, "del"), nil })

	resp := app.Serve(context.Background(), Request{Method: "PUT", Path: "/put"})
	if resp.Status != 200 || string(resp.Body) != "put" {
		t.Fatalf("unexpected put response: %#v", resp)
	}

	resp = app.Serve(context.Background(), Request{Method: "DELETE", Path: "/del"})
	if resp.Status != 200 || string(resp.Body) != "del" {
		t.Fatalf("unexpected delete response: %#v", resp)
	}
}

func TestServePortable_ErrorCodeForError_AndRouteNotFoundResponse(t *testing.T) {
	t.Parallel()

	if got := errorCodeForError(&AppError{Code: errorCodeForbidden, Message: errorMessageForbidden}); got != errorCodeForbidden {
		t.Fatalf("expected errorCodeForError to return AppError.Code, got %q", got)
	}
	if got := errorCodeForError(errors.New("boom")); got != errorCodeInternal {
		t.Fatalf("expected errorCodeForError to map unknown errors to internal, got %q", got)
	}

	resp, code := routeNotFoundResponse([]string{"GET", "POST"}, "req_1")
	if resp.Status != 405 || code != errorCodeMethodNotAllowed {
		t.Fatalf("expected 405/method_not_allowed, got %d/%s", resp.Status, code)
	}
	if allow := resp.Headers["allow"]; len(allow) != 1 || allow[0] == "" {
		t.Fatalf("expected allow header, got %#v", resp.Headers)
	}

	resp, code = routeNotFoundResponse(nil, "req_1")
	if resp.Status != 404 || code != errorCodeNotFound {
		t.Fatalf("expected 404/not_found, got %d/%s", resp.Status, code)
	}
}

func TestServePortable_AuthorizeAndPolicyBranches(t *testing.T) {
	t.Parallel()

	// AuthRequired with no auth hook should fail closed.
	app := New(WithTier(TierP2), WithIDGenerator(fixedIDGenerator("req_1")))
	app.Get("/auth", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil }, RequireAuth())
	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/auth"})
	if resp.Status != 401 {
		t.Fatalf("expected 401, got %d", resp.Status)
	}

	// Auth hook error uses responseForErrorWithRequestID (and errorCodeForError).
	app = New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithAuthHook(func(_ *Context) (string, error) {
			return "", &AppError{Code: errorCodeForbidden, Message: errorMessageForbidden}
		}),
	)
	app.Get("/auth", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil }, RequireAuth())
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/auth"})
	if resp.Status != 403 {
		t.Fatalf("expected 403, got %d", resp.Status)
	}

	// Empty identity should be treated as unauthorized.
	app = New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithAuthHook(func(_ *Context) (string, error) { return "   ", nil }),
	)
	app.Get("/auth", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil }, RequireAuth())
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/auth"})
	if resp.Status != 401 {
		t.Fatalf("expected 401, got %d", resp.Status)
	}

	// Policy: nil decision and blank code should be ignored (handler runs).
	app = New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithPolicyHook(func(_ *Context) (*PolicyDecision, error) { return nil, nil }),
	)
	app.Get("/ok", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/ok"})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}

	app = New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithPolicyHook(func(_ *Context) (*PolicyDecision, error) { return &PolicyDecision{Code: "  ", Message: "ignored"}, nil }),
	)
	app.Get("/ok", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/ok"})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}

	// Policy: error fails closed.
	app = New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithPolicyHook(func(_ *Context) (*PolicyDecision, error) { return nil, errors.New("boom") }),
	)
	app.Get("/ok", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/ok"})
	if resp.Status != 500 {
		t.Fatalf("expected 500, got %d", resp.Status)
	}

	// Policy: default message selection (overloaded + fallback).
	app = New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithPolicyHook(func(_ *Context) (*PolicyDecision, error) { return &PolicyDecision{Code: errorCodeOverloaded}, nil }),
	)
	app.Get("/ok", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/ok"})
	if resp.Status != 503 {
		t.Fatalf("expected 503, got %d", resp.Status)
	}

	app = New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithPolicyHook(func(_ *Context) (*PolicyDecision, error) { return &PolicyDecision{Code: "app.weird"}, nil }),
	)
	app.Get("/ok", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/ok"})
	if resp.Status != 500 {
		t.Fatalf("expected 500, got %d", resp.Status)
	}
}

func TestRemainingMSFromContext_Branches(t *testing.T) {
	t.Parallel()

	if got := remainingMSFromContext(context.Background(), nil); got != 0 {
		t.Fatalf("expected no deadline to return 0, got %d", got)
	}

	pastCtx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	cancel()
	if got := remainingMSFromContext(pastCtx, nil); got != 0 {
		t.Fatalf("expected past deadline to return 0, got %d", got)
	}

	fixedNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	futureCtx, cancel := context.WithDeadline(context.Background(), fixedNow.Add(1500*time.Millisecond))
	defer cancel()

	if got := remainingMSFromContext(futureCtx, testFixedClock{now: fixedNow}); got != 1500 {
		t.Fatalf("expected 1500ms remaining, got %d", got)
	}
}
