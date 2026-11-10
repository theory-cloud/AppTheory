package mcp

import (
	"context"
	"testing"
	"time"
)

// TestDeclinedGETValidationFirst_DefaultOrderUnchanged pins the v7.1.0 default:
// a stream-less plain GET is the 405 no-stream answer before the session checks,
// so the response does not depend on whether the caller sent a session.
func TestDeclinedGETValidationFirst_DefaultOrderUnchanged(t *testing.T) {
	t.Parallel()

	s := NewServer("test", "dev", WithInitialSessionListenerEnabled(false))
	sessionID := initializeSession(t, s)

	tests := []struct {
		name    string
		headers map[string][]string
	}{
		{
			name:    "no session",
			headers: map[string][]string{"accept": {"text/event-stream"}},
		},
		{
			name:    "valid session",
			headers: sseSessionHeaders(sessionID),
		},
		{
			name: "unknown session",
			headers: map[string][]string{
				"accept":               {"text/event-stream"},
				"mcp-session-id":       {"missing"},
				"mcp-protocol-version": {protocolVersion},
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, tc.headers)
			if err != nil {
				t.Fatalf("invoke GET: %v", err)
			}
			if resp.Status != 405 {
				t.Fatalf("status = %d, want 405 (body: %s)", resp.Status, resp.Body)
			}
		})
	}
}

// TestDeclinedGETValidationFirst_Ordering pins the opted-in sequence- origin,
// GET headers, session, protocol version, then 405 - for a deployment that
// declines the common stream.
func TestDeclinedGETValidationFirst_Ordering(t *testing.T) {
	t.Parallel()

	s := NewServer("test", "dev",
		WithInitialSessionListenerEnabled(false),
		WithDeclinedGETValidationFirst(true),
	)
	sessionID := initializeSession(t, s)

	tests := []struct {
		name    string
		headers map[string][]string
		status  int
		body    string
	}{
		{
			name: "bad origin stays 403 before any session check",
			headers: map[string][]string{
				"accept": {"text/event-stream"},
				"origin": {"https://evil.example"},
			},
			status: 403,
			body:   `{"error":"forbidden"}`,
		},
		{
			name:    "missing Accept header is 400 before the session check",
			headers: map[string][]string{"mcp-session-id": {sessionID}},
			status:  400,
			body:    `{"error":"GET /mcp requires Accept: text/event-stream"}`,
		},
		{
			name:    "missing session is 400",
			headers: map[string][]string{"accept": {"text/event-stream"}},
			status:  400,
			body:    `{"error":"missing Mcp-Session-Id"}`,
		},
		{
			name: "unknown session is 404",
			headers: map[string][]string{
				"accept":               {"text/event-stream"},
				"mcp-session-id":       {"missing"},
				"mcp-protocol-version": {protocolVersion},
			},
			status: 404,
			body:   `{"error":"session not found"}`,
		},
		{
			name: "unsupported protocol version is 400 after the session check",
			headers: map[string][]string{
				"accept":               {"text/event-stream"},
				"mcp-session-id":       {sessionID},
				"mcp-protocol-version": {"1999-01-01"},
			},
			status: 400,
			body:   `{"error":"unsupported MCP-Protocol-Version"}`,
		},
		{
			name:    "valid session is the declined 405",
			headers: sseSessionHeaders(sessionID),
			status:  405,
			body:    `{"error":"method not allowed"}`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, tc.headers)
			if err != nil {
				t.Fatalf("invoke GET: %v", err)
			}
			if resp.Status != tc.status {
				t.Fatalf("status = %d, want %d (body: %s)", resp.Status, tc.status, resp.Body)
			}
			if string(resp.Body) != tc.body {
				t.Fatalf("body = %q, want %q", string(resp.Body), tc.body)
			}
			if tc.status == 405 {
				if got := resp.Headers["allow"]; len(got) != 1 || got[0] != "DELETE, GET, POST" {
					t.Fatalf("allow = %v, want [DELETE, GET, POST]", got)
				}
			}
		})
	}
}

// TestDeclinedGETValidationFirst_UnsupportedVersionNoSession pins the delta the
// option deliberately restores: without a session id, an unsupported
// MCP-Protocol-Version is no longer the early mandatory 400; the missing-session
// 400 is the first failure.
func TestDeclinedGETValidationFirst_UnsupportedVersionNoSession(t *testing.T) {
	t.Parallel()

	headers := map[string][]string{
		"accept":               {"text/event-stream"},
		"mcp-protocol-version": {"1999-01-01"},
	}

	defaultServer := NewServer("test", "dev", WithInitialSessionListenerEnabled(false))
	defaultResp, err := invokeHandlerWithMethod(context.Background(), defaultServer, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke default GET: %v", err)
	}
	if defaultResp.Status != 400 || string(defaultResp.Body) != `{"error":"unsupported MCP-Protocol-Version"}` {
		t.Fatalf("default = %d %s, want the early unsupported-version 400", defaultResp.Status, defaultResp.Body)
	}

	optedIn := NewServer("test", "dev",
		WithInitialSessionListenerEnabled(false),
		WithDeclinedGETValidationFirst(true),
	)
	optedInResp, err := invokeHandlerWithMethod(context.Background(), optedIn, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke opted-in GET: %v", err)
	}
	if optedInResp.Status != 400 || string(optedInResp.Body) != `{"error":"missing Mcp-Session-Id"}` {
		t.Fatalf("opted-in = %d %s, want the missing-session 400", optedInResp.Status, optedInResp.Body)
	}
}

// TestDeclinedGETValidationFirst_RefreshesSessionTTL pins the intent of the
// option: a declined GET with a valid session returns 405 and slides the
// session TTL, while the default 405-first order does not touch the session.
func TestDeclinedGETValidationFirst_RefreshesSessionTTL(t *testing.T) {
	t.Parallel()

	seedSession := func(t *testing.T, store *MemorySessionStore, id string) time.Time {
		t.Helper()
		expiresAt := time.Now().UTC().Add(5 * time.Minute)
		store.Seed(&Session{
			ID:        id,
			CreatedAt: time.Now().UTC(),
			ExpiresAt: expiresAt,
			Data:      map[string]string{"protocolVersion": protocolVersion},
		})
		return expiresAt
	}

	t.Run("default 405-first leaves the TTL untouched", func(t *testing.T) {
		t.Parallel()

		store := NewMemorySessionStore()
		expiresAt := seedSession(t, store, "sess-default")
		s := NewServer("test", "dev",
			WithSessionStore(store),
			WithInitialSessionListenerEnabled(false),
		)

		resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, sseSessionHeaders("sess-default"))
		if err != nil {
			t.Fatalf("invoke GET: %v", err)
		}
		if resp.Status != 405 {
			t.Fatalf("status = %d, want 405 (body: %s)", resp.Status, resp.Body)
		}
		stored, err := store.Get(context.Background(), "sess-default")
		if err != nil {
			t.Fatalf("get session: %v", err)
		}
		if !stored.ExpiresAt.Equal(expiresAt) {
			t.Fatalf("expiresAt = %s, want unchanged %s", stored.ExpiresAt, expiresAt)
		}
	})

	t.Run("validation-first 405 refreshes the TTL", func(t *testing.T) {
		t.Parallel()

		store := NewMemorySessionStore()
		expiresAt := seedSession(t, store, "sess-opted-in")
		s := NewServer("test", "dev",
			WithSessionStore(store),
			WithInitialSessionListenerEnabled(false),
			WithDeclinedGETValidationFirst(true),
		)

		resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, sseSessionHeaders("sess-opted-in"))
		if err != nil {
			t.Fatalf("invoke GET: %v", err)
		}
		if resp.Status != 405 {
			t.Fatalf("status = %d, want 405 (body: %s)", resp.Status, resp.Body)
		}
		stored, err := store.Get(context.Background(), "sess-opted-in")
		if err != nil {
			t.Fatalf("get session: %v", err)
		}
		if !stored.ExpiresAt.After(expiresAt) {
			t.Fatalf("expiresAt = %s, want refreshed beyond %s", stored.ExpiresAt, expiresAt)
		}
		want := time.Now().UTC().Add(sessionTTL())
		if delta := stored.ExpiresAt.Sub(want); delta < -2*time.Minute || delta > 2*time.Minute {
			t.Fatalf("expiresAt = %s, want about one session TTL from now (%s)", stored.ExpiresAt, want)
		}
	})
}

// TestDeclinedGETValidationFirst_ReplayUnaffected pins that Last-Event-ID replay
// keeps its path when the option is set.
func TestDeclinedGETValidationFirst_ReplayUnaffected(t *testing.T) {
	t.Parallel()

	store := NewMemoryStreamStore()
	s := NewServer("test", "dev",
		WithStreamStore(store),
		WithInitialSessionListenerEnabled(false),
		WithDeclinedGETValidationFirst(true),
	)
	sessionID := initializeSession(t, s)

	ctx := context.Background()
	streamID, err := store.Create(ctx, sessionID)
	if err != nil {
		t.Fatalf("create stream: %v", err)
	}
	eventID, err := store.Append(ctx, sessionID, streamID, []byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`))
	if err != nil {
		t.Fatalf("append event: %v", err)
	}
	if err := store.Close(ctx, sessionID, streamID); err != nil {
		t.Fatalf("close stream: %v", err)
	}

	headers := sseSessionHeaders(sessionID)
	headers["last-event-id"] = []string{eventID}
	resp, err := invokeHandlerWithMethod(ctx, s, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke replay GET: %v", err)
	}
	if resp.Status != 200 || resp.BodyReader == nil {
		t.Fatalf("status = %d bodyReader = %v, want 200 with a body", resp.Status, resp.BodyReader != nil)
	}
}
