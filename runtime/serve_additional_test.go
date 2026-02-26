package apptheory

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestHTTPVerbHelpers_StrictAndNonStrict(t *testing.T) {
	t.Parallel()

	app := New()
	handler := func(*Context) (*Response, error) { return Text(200, "ok"), nil }

	if _, err := app.PostStrict("/post", handler); err != nil {
		t.Fatalf("PostStrict: %v", err)
	}
	if _, err := app.PutStrict("/put", handler); err != nil {
		t.Fatalf("PutStrict: %v", err)
	}
	if _, err := app.DeleteStrict("/delete", handler); err != nil {
		t.Fatalf("DeleteStrict: %v", err)
	}
	if _, err := app.PatchStrict("/patch-strict", handler); err != nil {
		t.Fatalf("PatchStrict: %v", err)
	}
	if _, err := app.OptionsStrict("/options-strict", handler); err != nil {
		t.Fatalf("OptionsStrict: %v", err)
	}

	if got := app.Patch("/patch", handler); got == nil {
		t.Fatalf("Patch: expected non-nil app")
	}
	if got := app.Options("/options", handler); got == nil {
		t.Fatalf("Options: expected non-nil app")
	}
	if got := app.Put("/put", handler); got == nil {
		t.Fatalf("Put: expected non-nil app")
	}
	if got := app.Delete("/delete", handler); got == nil {
		t.Fatalf("Delete: expected non-nil app")
	}

	// Smoke test: route is actually reachable.
	resp := app.Serve(context.Background(), Request{Method: "POST", Path: "/post"})
	if resp.Status != 200 {
		t.Fatalf("Serve: got %d want %d", resp.Status, 200)
	}

	// Not found should produce a deterministic error response.
	resp = app.Serve(context.Background(), Request{Method: "GET", Path: "/missing"})
	if resp.Status != 404 {
		t.Fatalf("expected 404, got %d", resp.Status)
	}
}

func TestHandleStrict_InvalidInputs_ReturnError(t *testing.T) {
	t.Parallel()

	handler := func(*Context) (*Response, error) { return Text(200, "ok"), nil }

	var nilApp *App
	if _, err := nilApp.GetStrict("/any", handler); err == nil {
		t.Fatalf("expected nil app to error")
	}

	app := New()
	if _, err := app.GetStrict("/nil-handler", nil); err == nil {
		t.Fatalf("expected nil handler to error")
	}
}

func TestErrorCodeForError_CoversAllTypes(t *testing.T) {
	t.Parallel()

	if got := errorCodeForError(&AppTheoryError{Code: "X"}); got != "X" {
		t.Fatalf("AppTheoryError: got %q", got)
	}
	if got := errorCodeForError(&AppTheoryError{Code: " "}); got != errorCodeInternal {
		t.Fatalf("AppTheoryError empty code: got %q", got)
	}
	if got := errorCodeForError(&AppError{Code: errorCodeBadRequest}); got != errorCodeBadRequest {
		t.Fatalf("AppError: got %q", got)
	}
	if got := errorCodeForError(errors.New("boom")); got != errorCodeInternal {
		t.Fatalf("generic error: got %q", got)
	}
}

func TestExtractTenantID_QueryFallback(t *testing.T) {
	t.Parallel()

	if got := extractTenantID(map[string][]string{}, map[string][]string{"tenant": {"t1"}}); got != "t1" {
		t.Fatalf("tenant query fallback: got %q", got)
	}
	if got := extractTenantID(map[string][]string{"x-tenant-id": {"t2"}}, map[string][]string{"tenant": {"t1"}}); got != "t2" {
		t.Fatalf("tenant header precedence: got %q", got)
	}
}

func TestRemainingMSFromContext_DeadlineMath(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithDeadline(context.Background(), RealClock{}.Now().Add(50*time.Millisecond))
	defer cancel()

	if got := remainingMSFromContext(ctx, RealClock{}); got <= 0 {
		t.Fatalf("expected remainingMS > 0, got %d", got)
	}

	pastCtx, pastCancel := context.WithDeadline(context.Background(), RealClock{}.Now().Add(-time.Millisecond))
	defer pastCancel()

	if got := remainingMSFromContext(pastCtx, RealClock{}); got != 0 {
		t.Fatalf("expected remainingMS = 0 for past deadline, got %d", got)
	}
}

func TestDefaultPolicyMessage_KnownAndUnknownCodes(t *testing.T) {
	t.Parallel()

	if got := defaultPolicyMessage(errorCodeRateLimited); got != errorMessageRateLimited {
		t.Fatalf("rate limited: got %q", got)
	}
	if got := defaultPolicyMessage(errorCodeOverloaded); got != errorMessageOverloaded {
		t.Fatalf("overloaded: got %q", got)
	}
	if got := defaultPolicyMessage("something-else"); got != errorMessageInternal {
		t.Fatalf("default: got %q", got)
	}
}

func TestPortableServe_PolicyAndAuth_ErrorBranches(t *testing.T) {
	t.Parallel()

	t.Run("policy hook error returns 500", func(t *testing.T) {
		app := New(
			WithTier(TierP2),
			WithIDGenerator(fixedIDGenerator("req_1")),
			WithPolicyHook(func(*Context) (*PolicyDecision, error) {
				return nil, errors.New("boom")
			}),
		)
		app.Get("/ok", func(*Context) (*Response, error) { return Text(200, "ok"), nil })

		resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/ok"})
		if resp.Status != 500 {
			t.Fatalf("expected 500, got %d", resp.Status)
		}
	})

	t.Run("policy decision with empty code is ignored", func(t *testing.T) {
		app := New(
			WithTier(TierP2),
			WithIDGenerator(fixedIDGenerator("req_1")),
			WithPolicyHook(func(*Context) (*PolicyDecision, error) {
				return &PolicyDecision{Code: " "}, nil
			}),
		)
		app.Get("/ok", func(*Context) (*Response, error) { return Text(200, "ok"), nil })

		resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/ok"})
		if resp.Status != 200 {
			t.Fatalf("expected 200, got %d", resp.Status)
		}
	})

	t.Run("auth required without hook returns 401", func(t *testing.T) {
		app := New(WithTier(TierP2), WithIDGenerator(fixedIDGenerator("req_1")))
		app.Get("/protected", func(*Context) (*Response, error) { return Text(200, "ok"), nil }, RequireAuth())

		resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/protected"})
		if resp.Status != 401 {
			t.Fatalf("expected 401, got %d", resp.Status)
		}
	})

	t.Run("auth hook error returns 500", func(t *testing.T) {
		app := New(
			WithTier(TierP2),
			WithIDGenerator(fixedIDGenerator("req_1")),
			WithAuthHook(func(*Context) (string, error) {
				return "", errors.New("auth boom")
			}),
		)
		app.Get("/protected", func(*Context) (*Response, error) { return Text(200, "ok"), nil }, RequireAuth())

		resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/protected"})
		if resp.Status != 500 {
			t.Fatalf("expected 500, got %d", resp.Status)
		}
	})

	t.Run("auth hook empty identity returns 401", func(t *testing.T) {
		app := New(
			WithTier(TierP2),
			WithIDGenerator(fixedIDGenerator("req_1")),
			WithAuthHook(func(*Context) (string, error) {
				return " ", nil
			}),
		)
		app.Get("/protected", func(*Context) (*Response, error) { return Text(200, "ok"), nil }, RequireAuth())

		resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/protected"})
		if resp.Status != 401 {
			t.Fatalf("expected 401, got %d", resp.Status)
		}
	})
}

func TestPortableServe_MethodNotAllowed_WhenRouteExists(t *testing.T) {
	t.Parallel()

	app := New(WithTier(TierP2), WithIDGenerator(fixedIDGenerator("req_1")))
	app.Get("/ok", func(*Context) (*Response, error) { return Text(200, "ok"), nil })

	resp := app.Serve(context.Background(), Request{Method: "POST", Path: "/ok"})
	if resp.Status != 405 {
		t.Fatalf("expected 405, got %d", resp.Status)
	}
}

func TestHandleStrict_InitializesRouter_WhenNil(t *testing.T) {
	t.Parallel()

	app := &App{}
	_, err := app.HandleStrict("GET", "/x", func(*Context) (*Response, error) { return Text(200, "ok"), nil })
	if err != nil {
		t.Fatalf("HandleStrict: %v", err)
	}
	if app.router == nil {
		t.Fatalf("expected router to be initialized")
	}
}

func TestServe_UsesBackgroundWhenContextNil_AndDefaultsToP2(t *testing.T) {
	t.Parallel()

	app := New(WithTier(Tier("unknown")))
	app.Get("/ok", func(*Context) (*Response, error) { return Text(200, "ok"), nil })

	//nolint:staticcheck // testing nil context handling
	resp := app.Serve(nil, Request{Method: "GET", Path: "/ok"})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}
}
