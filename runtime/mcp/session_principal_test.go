package mcp

import (
	"context"
	"encoding/json"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
)

func invokeHandlerAsIdentity(
	t *testing.T,
	s *Server,
	method string,
	body []byte,
	headers map[string][]string,
	identity string,
) *apptheory.Response {
	t.Helper()

	handler := s.Handler()
	app := apptheory.New()
	if identity != "" {
		app.Use(func(next apptheory.Handler) apptheory.Handler {
			return func(c *apptheory.Context) (*apptheory.Response, error) {
				c.AuthIdentity = identity
				return next(c)
			}
		})
	}
	app.Post("/mcp", handler)
	app.Get("/mcp", handler)
	app.Delete("/mcp", handler)

	if headers == nil {
		headers = map[string][]string{}
	}
	if method == "POST" {
		if _, ok := headers["content-type"]; !ok {
			headers["content-type"] = []string{"application/json"}
		}
		if _, ok := headers["accept"]; !ok {
			headers["accept"] = []string{"application/json, text/event-stream"}
		}
	}

	resp := app.Serve(context.Background(), apptheory.Request{
		Method:  method,
		Path:    "/mcp",
		Headers: headers,
		Body:    body,
	})
	return &resp
}

func initializeSessionAsIdentity(t *testing.T, s *Server, identity string) string {
	t.Helper()

	body, err := json.Marshal(Request{JSONRPC: "2.0", ID: 1, Method: methodInitialize})
	if err != nil {
		t.Fatalf("marshal initialize: %v", err)
	}
	resp := invokeHandlerAsIdentity(t, s, "POST", body, nil, identity)
	if resp.Status != 200 {
		t.Fatalf("initialize status: got %d, want %d (body: %s)", resp.Status, 200, resp.Body)
	}
	ids := resp.Headers["mcp-session-id"]
	if len(ids) == 0 || ids[0] == "" {
		t.Fatalf("expected mcp-session-id header on initialize response")
	}
	return ids[0]
}

func TestSessionPrincipal_SamePrincipalCanUseSession(t *testing.T) {
	s := NewServer("test", "dev")
	sessionID := initializeSessionAsIdentity(t, s, "alice")

	sess, err := s.sessionStore.Get(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if sess.Principal != "alice" {
		t.Fatalf("session principal: got %q want %q", sess.Principal, "alice")
	}

	body, err := json.Marshal(Request{JSONRPC: "2.0", ID: 2, Method: methodPing})
	if err != nil {
		t.Fatalf("marshal ping: %v", err)
	}
	postResp := invokeHandlerAsIdentity(t, s, "POST", body, sessionHeaders(sessionID), "alice")
	if postResp.Status != 200 {
		t.Fatalf("same-principal POST status: got %d (body: %s)", postResp.Status, postResp.Body)
	}

	getHeaders := sseSessionHeaders(sessionID)
	getResp := invokeHandlerAsIdentity(t, s, "GET", nil, getHeaders, "alice")
	if getResp.Status != 200 {
		t.Fatalf("same-principal GET status: got %d (body: %s)", getResp.Status, getResp.Body)
	}

	deleteResp := invokeHandlerAsIdentity(t, s, "DELETE", nil, sessionHeaders(sessionID), "alice")
	if deleteResp.Status != 202 {
		t.Fatalf("same-principal DELETE status: got %d (body: %s)", deleteResp.Status, deleteResp.Body)
	}
}

func TestSessionPrincipal_SecondPrincipalIsRejected(t *testing.T) {
	s := NewServer("test", "dev")
	sessionID := initializeSessionAsIdentity(t, s, "alice")

	body, err := json.Marshal(Request{JSONRPC: "2.0", ID: 2, Method: methodPing})
	if err != nil {
		t.Fatalf("marshal ping: %v", err)
	}

	postResp := invokeHandlerAsIdentity(t, s, "POST", body, sessionHeaders(sessionID), "mallory")
	if postResp.Status != 404 || string(postResp.Body) != `{"error":"session not found"}` {
		t.Fatalf("second-principal POST: got status %d body %s", postResp.Status, postResp.Body)
	}

	getResp := invokeHandlerAsIdentity(t, s, "GET", nil, sseSessionHeaders(sessionID), "mallory")
	if getResp.Status != 404 || string(getResp.Body) != `{"error":"session not found"}` {
		t.Fatalf("second-principal GET: got status %d body %s", getResp.Status, getResp.Body)
	}

	deleteResp := invokeHandlerAsIdentity(t, s, "DELETE", nil, sessionHeaders(sessionID), "mallory")
	if deleteResp.Status != 404 || string(deleteResp.Body) != `{"error":"session not found"}` {
		t.Fatalf("second-principal DELETE: got status %d body %s", deleteResp.Status, deleteResp.Body)
	}

	if _, err := s.sessionStore.Get(context.Background(), sessionID); err != nil {
		t.Fatalf("rejected principal must not delete the session: %v", err)
	}
}

func TestSessionPrincipal_AnonymousSessionsContinueToWork(t *testing.T) {
	s := NewServer("test", "dev")
	sessionID := initializeSessionAsIdentity(t, s, "")

	sess, err := s.sessionStore.Get(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if sess.Principal != "" {
		t.Fatalf("anonymous session principal: got %q want empty", sess.Principal)
	}

	body, err := json.Marshal(Request{JSONRPC: "2.0", ID: 2, Method: methodPing})
	if err != nil {
		t.Fatalf("marshal ping: %v", err)
	}
	if resp := invokeHandlerAsIdentity(t, s, "POST", body, sessionHeaders(sessionID), ""); resp.Status != 200 {
		t.Fatalf("anonymous POST status: got %d (body: %s)", resp.Status, resp.Body)
	}

	// Anonymous sessions keep their historical behavior, including access by a
	// caller that now has an identity.
	if resp := invokeHandlerAsIdentity(t, s, "POST", body, sessionHeaders(sessionID), "alice"); resp.Status != 200 {
		t.Fatalf("identified POST on anonymous session status: got %d (body: %s)", resp.Status, resp.Body)
	}

	if resp := invokeHandlerAsIdentity(t, s, "GET", nil, sseSessionHeaders(sessionID), ""); resp.Status != 200 {
		t.Fatalf("anonymous GET status: got %d (body: %s)", resp.Status, resp.Body)
	}
	if resp := invokeHandlerAsIdentity(t, s, "DELETE", nil, sessionHeaders(sessionID), ""); resp.Status != 202 {
		t.Fatalf("anonymous DELETE status: got %d (body: %s)", resp.Status, resp.Body)
	}
}

func TestCallerIdentity_Precedence(t *testing.T) {
	if got := callerIdentity(&apptheory.Context{AuthIdentity: " auth ", TenantID: "tenant", TenantBound: true}); got != "auth" {
		t.Fatalf("auth identity precedence: got %q", got)
	}

	c := &apptheory.Context{TenantID: "tenant", TenantBound: true}
	if got := callerIdentity(c); got != "tenant" {
		t.Fatalf("tenant-bound fallback: got %q", got)
	}

	c = &apptheory.Context{TenantID: "tenant"}
	if got := callerIdentity(c); got != "" {
		t.Fatalf("unbound tenant must not be used: got %q", got)
	}

	c.Set(oauth.ContextKeyBearerClaims, oauth.BearerTokenClaims{Subject: " subject "})
	if got := callerIdentity(c); got != "subject" {
		t.Fatalf("bearer subject fallback: got %q", got)
	}
}

func TestSessionRecord_PrincipalRoundTrip(t *testing.T) {
	sess := &Session{ID: "sess-1", Principal: "alice"}
	record := sessionToRecord(sess)
	if record.Principal != "alice" {
		t.Fatalf("sessionToRecord principal: got %q", record.Principal)
	}
	if got := recordToSession(record).Principal; got != "alice" {
		t.Fatalf("recordToSession principal: got %q", got)
	}
}
