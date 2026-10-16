package apptheory

import (
	"context"
	"testing"
)

// TestServedErrorEnvelopeCarriesTheServedStatusCode pins issue #1161 end to end
// for every producer class reachable through the serve path: each framework-emitted
// rejection carries error.status_code equal to the status the runtime returns.
func TestServedErrorEnvelopeCarriesTheServedStatusCode(t *testing.T) {
	tests := []struct {
		name    string
		app     func() *App
		request Request
	}{
		{
			name:    "routing not found",
			app:     func() *App { app := New(WithTier(TierP0)); app.Get("/ping", okHandler); return app },
			request: Request{Method: "GET", Path: "/missing"},
		},
		{
			name:    "routing method not allowed",
			app:     func() *App { app := New(WithTier(TierP0)); app.Get("/ping", okHandler); return app },
			request: Request{Method: "DELETE", Path: "/ping"},
		},
		{
			name: "panic recovery",
			app: func() *App {
				app := New(WithTier(TierP0))
				app.Get("/panic", func(_ *Context) (*Response, error) { panic("boom") })
				return app
			},
			request: Request{Method: "GET", Path: "/panic"},
		},
		{
			name: "policy rate limit",
			app: func() *App {
				return New(WithTier(TierP2), WithPolicyHook(func(_ *Context) (*PolicyDecision, error) {
					return &PolicyDecision{Code: errorCodeRateLimited}, nil
				}))
			},
			request: Request{Method: "GET", Path: "/limited"},
		},
		{
			name: "policy load shed",
			app: func() *App {
				return New(WithTier(TierP2), WithPolicyHook(func(_ *Context) (*PolicyDecision, error) {
					return &PolicyDecision{Code: errorCodeOverloaded}, nil
				}))
			},
			request: Request{Method: "GET", Path: "/shed"},
		},
		{
			name:    "request too large",
			app:     func() *App { return New(WithTier(TierP2), WithLimits(Limits{MaxRequestBytes: 1})) },
			request: Request{Method: "GET", Path: "/big", Body: []byte("too big")},
		},
		{
			name: "response too large",
			app: func() *App {
				app := New(WithTier(TierP2), WithLimits(Limits{MaxResponseBytes: 1}))
				app.Get("/big", func(_ *Context) (*Response, error) { return Text(200, "too big"), nil })
				return app
			},
			request: Request{Method: "GET", Path: "/big"},
		},
		{
			name: "legacy AppError from a handler",
			app: func() *App {
				app := New(WithTier(TierP0))
				app.Get("/legacy", func(_ *Context) (*Response, error) {
					return nil, &AppError{Code: errorCodeBadRequest, Message: "invalid json"}
				})
				return app
			},
			request: Request{Method: "GET", Path: "/legacy"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp := tc.app().Serve(context.Background(), tc.request)
			status, ok := statusCodeFromNestedBody(t, resp.Body)
			if !ok {
				t.Fatalf("nested body %q has no error.status_code", string(resp.Body))
			}
			if status != resp.Status {
				t.Fatalf("error.status_code = %d, response status = %d (body %q)", status, resp.Status, string(resp.Body))
			}
		})
	}
}

// TestServedSecureDenialEnvelopeCarriesTheServedStatusCode covers the SecureApp
// principal-resolver denial producer: the resolver throws the portable error
// without a status, and the envelope still reports the status that was sent.
func TestServedSecureDenialEnvelopeCarriesTheServedStatusCode(t *testing.T) {
	app := NewSecure(SecureOptions{
		Tier:        TierP2,
		IDGenerator: fixedIDGenerator("req_denial"),
		PrincipalResolver: func(*Context) (*SecurePrincipal, error) {
			return nil, NewAppTheoryError(errorCodeUnauthorized, errorMessageUnauthorized)
		},
	})
	app.Get("/mcp", okHandler, Authenticated())

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/mcp"})
	if resp.Status != 401 {
		t.Fatalf("status = %d, want 401", resp.Status)
	}
	status, ok := statusCodeFromNestedBody(t, resp.Body)
	if !ok {
		t.Fatalf("nested body %q has no error.status_code", string(resp.Body))
	}
	if status != resp.Status {
		t.Fatalf("error.status_code = %d, response status = %d", status, resp.Status)
	}
}

func okHandler(_ *Context) (*Response, error) {
	return Text(200, "ok"), nil
}

// unserializableDetailsApp serves an AppTheoryError whose Details carry a value
// encoding/json cannot marshal, so no envelope renderer can serialize it.
func unserializableDetailsApp(format HTTPErrorFormat) *App {
	app := New(WithTier(TierP0), WithHTTPErrorFormat(format))
	app.Get("/teapot", func(_ *Context) (*Response, error) {
		portable := NewAppTheoryError("teapot", "I am a teapot")
		portable.StatusCode = 418
		portable.Details = map[string]any{"unserializable": make(chan int)}
		return nil, portable
	})
	return app
}

// TestServedUnserializableDetailsSendsTheInternalErrorFallbackNested pins the
// nested half of the issue #1161 boundary for an envelope that cannot be
// serialized: the internal-error fallback is sent with status 500, so the nested
// status_code can never disagree with the status on the wire.
func TestServedUnserializableDetailsSendsTheInternalErrorFallbackNested(t *testing.T) {
	resp := unserializableDetailsApp(HTTPErrorFormatNested).Serve(context.Background(), Request{Method: "GET", Path: "/teapot"})
	assertUnserializableDetailsFallback(t, resp, `{"error":{"code":"app.internal","message":"internal error","status_code":500}}`)
}

// TestServedUnserializableDetailsSendsTheInternalErrorFallbackFlatLegacy pins the
// flat-legacy half: its fallback body stays byte-identical to the fallback the
// format has always sent, and it too is sent with status 500.
func TestServedUnserializableDetailsSendsTheInternalErrorFallbackFlatLegacy(t *testing.T) {
	resp := unserializableDetailsApp(HTTPErrorFormatFlatLegacy).Serve(context.Background(), Request{Method: "GET", Path: "/teapot"})
	assertUnserializableDetailsFallback(t, resp, `{"code":"app.internal","message":"internal error"}`)
}

func assertUnserializableDetailsFallback(t *testing.T, resp Response, wantBody string) {
	t.Helper()
	if resp.Status != fallbackHTTPErrorStatus() {
		t.Fatalf("status = %d, want %d (body %q)", resp.Status, fallbackHTTPErrorStatus(), string(resp.Body))
	}
	if got := string(resp.Body); got != wantBody {
		t.Fatalf("body = %q, want %q", got, wantBody)
	}
	contentType := resp.Headers["content-type"]
	if len(contentType) != 1 || contentType[0] != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %v, want the header the normal error path sets", contentType)
	}
}
