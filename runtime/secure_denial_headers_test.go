package apptheory

import (
	"context"
	"encoding/json"
	"testing"
)

// TestSecureDenialChallengeHeaders pins the denial-header mechanism: a
// SecurePrincipalResolver denial rendered as AppTheoryError with Headers
// carries those headers on the 401/403 response, while a plain denial keeps
// today's byte-identical envelope without any challenge header.
func TestSecureDenialChallengeHeaders(t *testing.T) {
	t.Parallel()

	const challenge = `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"`

	tests := []struct {
		name        string
		resolver    SecurePrincipalResolver
		wantBody    string
		wantExtra   map[string][]string
		wantCookies []string
	}{
		{
			name: "plain denial renders without challenge headers",
			resolver: func(*Context) (*SecurePrincipal, error) {
				return nil, &AppError{Code: errorCodeUnauthorized, Message: errorMessageUnauthorized}
			},
			wantBody: `{"error":{"code":"app.unauthorized","message":"unauthorized","request_id":"req_denial"}}`,
		},
		{
			name: "portable denial renders without challenge headers",
			resolver: func(*Context) (*SecurePrincipal, error) {
				return nil, NewAppTheoryError(errorCodeUnauthorized, errorMessageUnauthorized)
			},
			wantBody: `{"error":{"code":"app.unauthorized","message":"unauthorized","request_id":"req_denial"}}`,
		},
		{
			name: "denial carries www-authenticate challenge",
			resolver: func(*Context) (*SecurePrincipal, error) {
				return nil, NewAppTheoryError(errorCodeUnauthorized, errorMessageUnauthorized).
					WithHeaders(map[string][]string{"WWW-Authenticate": {challenge}})
			},
			wantBody: `{"error":{"code":"app.unauthorized","message":"unauthorized","request_id":"req_denial"}}`,
			wantExtra: map[string][]string{
				"www-authenticate": {challenge},
			},
		},
		{
			name: "forbidden denial carries bounded arbitrary headers",
			resolver: func(*Context) (*SecurePrincipal, error) {
				return nil, NewAppTheoryError(errorCodeForbidden, errorMessageForbidden).
					WithHeaders(map[string][]string{
						"www-authenticate": {challenge},
						"x-denial-reason":  {"insufficient_scope"},
					})
			},
			wantBody: `{"error":{"code":"app.forbidden","message":"forbidden","request_id":"req_denial"}}`,
			wantExtra: map[string][]string{
				"www-authenticate": {challenge},
				"x-denial-reason":  {"insufficient_scope"},
			},
		},
		{
			name: "denial set-cookie relocates into cookies",
			resolver: func(*Context) (*SecurePrincipal, error) {
				return nil, NewAppTheoryError(errorCodeUnauthorized, errorMessageUnauthorized).
					WithHeaders(map[string][]string{"set-cookie": {"a=1; Path=/", "b=2; Path=/"}})
			},
			wantBody: `{"error":{"code":"app.unauthorized","message":"unauthorized","request_id":"req_denial"}}`,
			wantCookies: []string{
				"a=1; Path=/",
				"b=2; Path=/",
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			app := NewSecure(SecureOptions{
				Tier:              TierP2,
				IDGenerator:       fixedIDs{id: "req_denial"},
				PrincipalResolver: tc.resolver,
			})
			app.Get("/mcp", secureOKHandler, Authenticated())

			resp := app.Serve(context.Background(), Request{
				Method: "GET",
				Path:   "/mcp",
			})

			if resp.Status != 401 && resp.Status != 403 {
				t.Fatalf("status = %d, want 401 or 403", resp.Status)
			}
			if got := string(resp.Body); got != tc.wantBody {
				t.Fatalf("body = %q, want %q", got, tc.wantBody)
			}
			if _, ok := resp.Headers["www-authenticate"]; ok && len(tc.wantExtra) == 0 {
				t.Fatalf("unexpected www-authenticate header: %#v", resp.Headers["www-authenticate"])
			}
			if _, ok := resp.Headers["set-cookie"]; ok {
				t.Fatalf("set-cookie must be relocated out of headers: %#v", resp.Headers["set-cookie"])
			}
			if len(resp.Cookies) != len(tc.wantCookies) {
				t.Fatalf("cookies = %#v, want %#v", resp.Cookies, tc.wantCookies)
			}
			for i := range tc.wantCookies {
				if resp.Cookies[i] != tc.wantCookies[i] {
					t.Fatalf("cookies = %#v, want %#v", resp.Cookies, tc.wantCookies)
				}
			}
			for key, want := range tc.wantExtra {
				got := resp.Headers[key]
				if len(got) != len(want) {
					t.Fatalf("header %q = %#v, want %#v", key, got, want)
				}
				for i := range want {
					if got[i] != want[i] {
						t.Fatalf("header %q = %#v, want %#v", key, got, want)
					}
				}
			}
			// content-type and the P2 request-id header must still be present.
			if got := resp.Headers["content-type"]; len(got) != 1 || got[0] != "application/json; charset=utf-8" {
				t.Fatalf("content-type = %#v", got)
			}
			if got := resp.Headers["x-request-id"]; len(got) != 1 || got[0] != "req_denial" {
				t.Fatalf("x-request-id = %#v", got)
			}
		})
	}
}

// TestAppTheoryErrorHeadersRender confirms the portable error renderer itself
// merges AppTheoryError.Headers, independent of the secure gate.
func TestAppTheoryErrorHeadersRender(t *testing.T) {
	t.Parallel()

	app := New(WithTier(TierP2), WithIDGenerator(fixedIDs{id: "req_headers"}))
	app.Get("/deny", func(_ *Context) (*Response, error) {
		return nil, NewAppTheoryError("app.unauthorized", "unauthorized").
			WithHeaders(map[string][]string{"WWW-Authenticate": {"Bearer realm=\"example\""}})
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/deny"})

	if resp.Status != 401 {
		t.Fatalf("status = %d, want 401", resp.Status)
	}
	if got := resp.Headers["www-authenticate"]; len(got) != 1 || got[0] != `Bearer realm="example"` {
		t.Fatalf("www-authenticate = %#v", got)
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("parse body: %v", err)
	}
	envelope, ok := body["error"].(map[string]any)
	if !ok || envelope["code"] != "app.unauthorized" {
		t.Fatalf("unexpected body: %s", resp.Body)
	}
}

// TestErrorRenderersRelocateSetCookie pins that every Go error renderer
// relocates a non-empty set-cookie into Cookies exactly like normalizeResponse
// (and like the TS/Py normalizers), so no renderer leaks set-cookie into
// Headers while its siblings relocate it. An empty set-cookie list stays in
// Headers and yields no cookies, matching the guarded Go/TS behavior.
func TestErrorRenderersRelocateSetCookie(t *testing.T) {
	t.Parallel()

	const (
		cookieA   = "a=1; Path=/"
		cookieB   = "b=2; Path=/"
		challenge = `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"`
	)

	renderers := []struct {
		name   string
		render func(headers map[string][]string) Response
	}{
		{
			name: "errorResponseWithFormat",
			render: func(headers map[string][]string) Response {
				return errorResponseWithFormat(HTTPErrorFormatNested, errorCodeUnauthorized, errorMessageUnauthorized, headers)
			},
		},
		{
			name: "errorResponseFromAppTheoryErrorWithFormat",
			render: func(headers map[string][]string) Response {
				return errorResponseFromAppTheoryErrorWithFormat(
					HTTPErrorFormatNested,
					NewAppTheoryError(errorCodeUnauthorized, errorMessageUnauthorized),
					headers,
					"req_denial",
				)
			},
		},
		{
			name: "errorResponseWithRequestIDTraceIDAndFormat",
			render: func(headers map[string][]string) Response {
				return errorResponseWithRequestIDTraceIDAndFormat(HTTPErrorFormatNested, errorCodeUnauthorized, errorMessageUnauthorized, headers, "req_denial", "")
			},
		},
	}

	tests := []struct {
		name        string
		headers     map[string][]string
		wantCookies []string
	}{
		{
			name: "non-empty set-cookie relocates into cookies",
			headers: map[string][]string{
				"set-cookie":       {cookieA, cookieB},
				"www-authenticate": {challenge},
			},
			wantCookies: []string{cookieA, cookieB},
		},
		{
			name: "empty set-cookie stays in headers",
			headers: map[string][]string{
				"set-cookie": {},
			},
			wantCookies: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, r := range renderers {
				t.Run(r.name, func(t *testing.T) {
					t.Parallel()
					resp := r.render(tc.headers)
					if len(resp.Cookies) != len(tc.wantCookies) {
						t.Fatalf("cookies = %#v, want %#v", resp.Cookies, tc.wantCookies)
					}
					for i := range tc.wantCookies {
						if resp.Cookies[i] != tc.wantCookies[i] {
							t.Fatalf("cookies = %#v, want %#v", resp.Cookies, tc.wantCookies)
						}
					}
					if len(tc.wantCookies) > 0 {
						if _, ok := resp.Headers["set-cookie"]; ok {
							t.Fatalf("set-cookie must be relocated out of headers: %#v", resp.Headers["set-cookie"])
						}
					} else if _, ok := resp.Headers["set-cookie"]; !ok {
						t.Fatalf("empty set-cookie must stay in headers")
					}
					if got := resp.Headers["content-type"]; len(got) != 1 || got[0] != "application/json; charset=utf-8" {
						t.Fatalf("content-type = %#v", got)
					}
				})
			}
		})
	}
}
