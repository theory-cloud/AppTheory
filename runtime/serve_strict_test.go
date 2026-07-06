package apptheory

import (
	"context"
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

func TestGetStrict_RegistersRouteAndServes(t *testing.T) {
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
