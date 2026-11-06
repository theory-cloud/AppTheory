package apptheory

import (
	"context"
	"strings"
	"testing"
)

func TestHandleStrict_ReturnsErrorOnInvalidPattern(t *testing.T) {
	app := New()
	_, err := app.HandleStrict("GET", "/{proxy+}/x", func(*Context) (*Response, error) {
		return Text(200, "ok"), nil
	})
	if err == nil {
		t.Fatal("expected HandleStrict to return an error for invalid pattern")
	}
}

func TestHandleStrict_NilAppReturnsError(t *testing.T) {
	var app *App
	_, err := app.HandleStrict("GET", "/", func(*Context) (*Response, error) {
		return Text(200, "ok"), nil
	})
	if err == nil {
		t.Fatal("expected nil app to return an error")
	}
}

// TestHandleStrict_ReturnsCanonicalErrorWithoutPanic proves the supported
// posture: the Strict path reports a registration failure as a value, and the
// fluent path reports the same failure by panicking, so the two surfaces cannot
// drift apart.
func TestHandleStrict_ReturnsCanonicalErrorWithoutPanic(t *testing.T) {
	handler := func(*Context) (*Response, error) { return Text(200, "ok"), nil }

	cases := []struct {
		name    string
		message string
		strict  func(*App) error
		fluent  func(*App)
	}{
		{
			name:    "invalid pattern",
			message: "invalid route pattern",
			strict: func(app *App) error {
				_, err := app.GetStrict("/x/{}", handler)
				return err
			},
			fluent: func(app *App) { app.Get("/x/{}", handler) },
		},
		{
			name:    "duplicate route",
			message: "duplicate route",
			strict: func(app *App) error {
				if _, err := app.GetStrict("/dup/{id}", handler); err != nil {
					return err
				}
				_, err := app.HandleStrict("get", "/dup/:id", handler)
				return err
			},
			fluent: func(app *App) {
				app.Get("/dup/{id}", handler)
				app.Handle("get", "/dup/:id", handler)
			},
		},
		{
			name:    "nil handler",
			message: "route handler is nil",
			strict: func(app *App) error {
				_, err := app.GetStrict("/nil", nil)
				return err
			},
			fluent: func(app *App) { app.Get("/nil", nil) },
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// A panic on the Strict path escapes this goroutine and fails the test,
			// which is exactly the contract being pinned.
			err := tc.strict(New(WithTier(TierP0)))
			if err == nil {
				t.Fatal("expected the Strict path to return an error")
			}
			appErr, ok := err.(*AppTheoryError)
			if !ok {
				t.Fatalf("expected *AppTheoryError, got %T (%v)", err, err)
			}
			if appErr.Code != errorCodeBadRequest || appErr.StatusCode != 400 {
				t.Fatalf("unexpected route registration error: %#v", appErr)
			}
			if !strings.Contains(appErr.Message, tc.message) {
				t.Fatalf("expected message to contain %q, got %q", tc.message, appErr.Message)
			}

			func() {
				defer func() {
					panicValue := recover()
					if panicValue == nil {
						t.Fatal("expected the fluent path to fail closed")
					}
					fluentErr, ok := panicValue.(*AppTheoryError)
					if !ok {
						t.Fatalf("expected *AppTheoryError panic, got %T", panicValue)
					}
					if fluentErr.Code != appErr.Code || fluentErr.Message != appErr.Message {
						t.Fatalf("fluent and Strict errors diverged: %#v vs %#v", fluentErr, appErr)
					}
				}()
				tc.fluent(New(WithTier(TierP0)))
			}()
		})
	}
}

func TestHandleStrict_RegistersValidRouteAndServes(t *testing.T) {
	app := New()
	if _, err := app.GetStrict("/ping", func(*Context) (*Response, error) {
		return Text(200, "pong"), nil
	}); err != nil {
		t.Fatalf("expected GetStrict to succeed, got err: %v", err)
	}

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/ping"})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
}

func TestHandle_FailsClosedOnInvalidRegistrations(t *testing.T) {
	handler := func(*Context) (*Response, error) { return Text(200, "ok"), nil }

	cases := []struct {
		name string
		fn   func()
	}{
		{
			name: "invalid pattern",
			fn: func() {
				New(WithTier(TierP0)).Get("/x/{}", handler)
			},
		},
		{
			name: "duplicate route",
			fn: func() {
				app := New(WithTier(TierP0))
				app.Get("/dup/{id}", handler)
				app.Handle("get", "/dup/:id", handler)
			},
		},
		{
			name: "nil handler",
			fn: func() {
				New(WithTier(TierP0)).Get("/nil", nil)
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				r := recover()
				if r == nil {
					t.Fatal("expected registration panic")
				}
				appErr, ok := r.(*AppTheoryError)
				if !ok {
					t.Fatalf("expected AppTheoryError panic, got %T", r)
				}
				if appErr.Code != errorCodeBadRequest || appErr.StatusCode != 400 {
					t.Fatalf("unexpected route registration error: %#v", appErr)
				}
			}()
			tc.fn()
		})
	}
}
