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
		name      string
		resolver  SecurePrincipalResolver
		wantBody  string
		wantExtra map[string][]string
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
