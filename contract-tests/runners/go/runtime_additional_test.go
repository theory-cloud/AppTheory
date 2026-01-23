package main

import (
	"encoding/base64"
	"testing"
)

func TestNewFixtureApp_RejectsInvalidRoutes(t *testing.T) {
	_, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "", Path: "/", Handler: "static_pong"},
		},
	}, "p0")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestFixtureApp_HandleP1_CORSPreflight(t *testing.T) {
	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "GET", Path: "/ping", Handler: "static_pong"},
		},
	}, "p1")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	resp := app.handle(CanonicalRequest{
		Method: "OPTIONS",
		Path:   "/ping",
		Headers: map[string][]string{
			"origin":                        {"https://example.com"},
			"access-control-request-method": {"GET"},
		},
	})

	if resp.Status != 204 {
		t.Fatalf("expected 204, got %d", resp.Status)
	}
	if got := firstHeaderValue(resp.Headers, "access-control-allow-methods"); got != "GET" {
		t.Fatalf("expected access-control-allow-methods=GET, got %q", got)
	}
	if got := firstHeaderValue(resp.Headers, "access-control-allow-origin"); got != "https://example.com" {
		t.Fatalf("expected access-control-allow-origin to be set, got %q", got)
	}
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got == "" {
		t.Fatalf("expected x-request-id to be set")
	}
}

func TestFixtureApp_HandleP2_AuthRequired_Unauthorized_RecordsSideEffects(t *testing.T) {
	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "GET", Path: "/auth", Handler: "static_pong", AuthRequired: true},
		},
	}, "p2")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	resp := app.handle(CanonicalRequest{
		Method: "GET",
		Path:   "/auth",
		Query:  map[string][]string{"tenant": {"tenant_1"}},
		Headers: map[string][]string{
			"origin": {"https://example.com"},
		},
	})

	if resp.Status != 401 {
		t.Fatalf("expected 401, got %d", resp.Status)
	}
	if len(app.logs) != 1 || app.logs[0].ErrorCode != appErrorUnauthorized || app.logs[0].TenantID != "tenant_1" {
		t.Fatalf("expected p2 logs to be recorded; got %#v", app.logs)
	}
	if len(app.metrics) != 1 || app.metrics[0].Tags["error_code"] != appErrorUnauthorized {
		t.Fatalf("expected p2 metrics to be recorded; got %#v", app.metrics)
	}
	if len(app.spans) != 1 || app.spans[0].Attributes["error.code"] != appErrorUnauthorized {
		t.Fatalf("expected p2 spans to be recorded; got %#v", app.spans)
	}
}

func TestFixtureApp_HandleP2_ForcedRateLimit(t *testing.T) {
	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "GET", Path: "/ping", Handler: "static_pong"},
		},
	}, "p2")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	resp := app.handle(CanonicalRequest{
		Method: "GET",
		Path:   "/ping",
		Headers: map[string][]string{
			"x-force-rate-limit": {"1"},
		},
	})

	if resp.Status != 429 {
		t.Fatalf("expected 429, got %d", resp.Status)
	}
	if got := firstHeaderValue(resp.Headers, "retry-after"); got != "1" {
		t.Fatalf("expected retry-after=1, got %q", got)
	}
	if len(app.logs) != 1 || app.logs[0].ErrorCode != appErrorRateLimited {
		t.Fatalf("expected p2 side effects with rate limit; got %#v", app.logs)
	}
}

func TestCanonicalizeRequest_DecodesIsBase64Body(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString([]byte("hi"))
	req, err := canonicalizeRequest(FixtureRequest{
		Method:   "GET",
		Path:     "ping",
		Headers:  map[string][]string{},
		Query:    map[string][]string{},
		Body:     FixtureBody{Encoding: "utf8", Value: b64},
		IsBase64: true,
	})
	if err != nil {
		t.Fatalf("canonicalizeRequest: %v", err)
	}
	if string(req.Body) != "hi" {
		t.Fatalf("expected decoded body, got %q", string(req.Body))
	}
	if req.Path != "/ping" {
		t.Fatalf("expected normalized path, got %q", req.Path)
	}
}

func TestDecodeFixtureBody_UnknownEncoding(t *testing.T) {
	_, err := decodeFixtureBody(FixtureBody{Encoding: "nope", Value: ""})
	if err == nil {
		t.Fatal("expected error")
	}
}
