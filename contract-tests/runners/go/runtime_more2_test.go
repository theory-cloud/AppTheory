package main

import (
	"strings"
	"testing"
)

func TestStatusForError_CoversKnownCodes(t *testing.T) {
	if statusForError(appErrorUnauthorized) != 401 {
		t.Fatal("expected unauthorized to map to 401")
	}
	if statusForError(appErrorForbidden) != 403 {
		t.Fatal("expected forbidden to map to 403")
	}
	if statusForError(appErrorConflict) != 409 {
		t.Fatal("expected conflict to map to 409")
	}
	if statusForError(appErrorTooLarge) != 413 {
		t.Fatal("expected too_large to map to 413")
	}
	if statusForError(appErrorRateLimited) != 429 {
		t.Fatal("expected rate_limited to map to 429")
	}
	if statusForError(appErrorOverloaded) != 503 {
		t.Fatal("expected overloaded to map to 503")
	}
}

func TestFixtureApp_Match_ReportsAllowedMethodsWhenMethodDoesNotMatch(t *testing.T) {
	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "GET", Path: "/ping", Handler: "static_pong"},
			{Method: "POST", Path: "/ping", Handler: "static_pong"},
		},
	}, "p0")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	match, allowed := app.match("PUT", "/ping")
	if match != nil {
		t.Fatalf("expected no match for PUT, got %#v", match)
	}
	if got := strings.Join(allowed, ","); got != "GET,POST" && got != "POST,GET" {
		t.Fatalf("unexpected allowed list: %v", allowed)
	}
}

func TestFixtureApp_HandleP0_UnknownHandlerAndHandlerErrorPaths(t *testing.T) {
	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "GET", Path: "/unknown", Handler: "nope"},
			{Method: "GET", Path: "/unauth", Handler: "unauthorized"},
		},
	}, "p0")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	resp := app.handle(CanonicalRequest{Method: "GET", Path: "/unknown"})
	if resp.Status != 500 {
		t.Fatalf("expected 500 for unknown handler, got %d", resp.Status)
	}

	resp = app.handle(CanonicalRequest{Method: "GET", Path: "/unauth"})
	if resp.Status != 401 {
		t.Fatalf("expected 401 for unauthorized handler error, got %d", resp.Status)
	}
}

func TestParseCookies_LastValueWinsForDuplicateNames(t *testing.T) {
	out := parseCookies([]string{"a=b", "a=c"})
	if out["a"] != "c" {
		t.Fatalf("expected later cookie to win, got %#v", out)
	}
}

func TestEqualHeaders_LenMismatchIsFalse(t *testing.T) {
	if equalHeaders(map[string][]string{"a": {"1"}, "b": {"2"}}, map[string][]string{"a": {"1"}}) {
		t.Fatal("expected len mismatch to be false")
	}
}
