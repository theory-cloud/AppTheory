package main

import (
	"encoding/json"
	"testing"
)

func TestFixtureApp_HandleP1_EnforcesMaxRequestBytes(t *testing.T) {
	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "POST", Path: "/ping", Handler: "static_pong"},
		},
		Limits: FixtureLimits{MaxRequestBytes: 1},
	}, "p1")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	resp := app.handle(CanonicalRequest{
		Method: "POST",
		Path:   "/ping",
		Body:   []byte("hi"),
	})
	if resp.Status != 413 {
		t.Fatalf("expected 413, got %d", resp.Status)
	}

	var parsed map[string]any
	if err := json.Unmarshal(resp.Body, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	errObj, ok := parsed["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected error object, got %#v", parsed["error"])
	}
	if errObj["code"] != appErrorTooLarge || errObj["message"] != msgRequestTooLarge {
		t.Fatalf("unexpected error body: %#v", parsed)
	}
}

func TestFixtureApp_HandleP1_EnforcesMaxResponseBytes(t *testing.T) {
	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "GET", Path: "/large", Handler: "large_response"},
		},
		Limits: FixtureLimits{MaxResponseBytes: 1},
	}, "p1")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	resp := app.handle(CanonicalRequest{
		Method: "GET",
		Path:   "/large",
	})
	if resp.Status != 413 {
		t.Fatalf("expected 413, got %d", resp.Status)
	}

	var parsed map[string]any
	if err := json.Unmarshal(resp.Body, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	errObj, ok := parsed["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected error object, got %#v", parsed["error"])
	}
	if errObj["code"] != appErrorTooLarge || errObj["message"] != msgResponseTooLarge {
		t.Fatalf("unexpected error body: %#v", parsed)
	}
}

func TestFixtureApp_HandleP1_UnknownHandler_ReturnsInternal(t *testing.T) {
	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "GET", Path: "/x", Handler: "nope"},
		},
	}, "p1")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	resp := app.handle(CanonicalRequest{
		Method: "GET",
		Path:   "/x",
	})
	if resp.Status != 500 {
		t.Fatalf("expected 500, got %d", resp.Status)
	}
}

func TestCanonicalizeHeaders_SkipsBlankKeysAndMergesCaseVariants(t *testing.T) {
	out := canonicalizeHeaders(map[string][]string{
		" X-Test ": {"1"},
		"x-test":   {"2"},
		"":         {"ignored"},
		"  ":       {"ignored"},
	})

	if _, ok := out[""]; ok {
		t.Fatalf("expected blank keys to be dropped, got %#v", out)
	}
	if got := out["x-test"]; len(got) != 2 || got[0] != "1" || got[1] != "2" {
		t.Fatalf("expected merged x-test values, got %#v", out["x-test"])
	}
}

func TestCloneHeadersAndCloneQuery_AreDeepCopies(t *testing.T) {
	headers := map[string][]string{"x": {"1"}}
	cloneH := cloneHeaders(headers)
	headers["x"][0] = "2"
	if cloneH["x"][0] != "1" {
		t.Fatalf("expected cloneHeaders to deep copy slices, got %#v", cloneH)
	}

	query := map[string][]string{"q": {"a"}}
	cloneQ := cloneQuery(query)
	query["q"][0] = "b"
	if cloneQ["q"][0] != "a" {
		t.Fatalf("expected cloneQuery to deep copy slices, got %#v", cloneQ)
	}
}

func TestExtractTenantID_HeaderPrecedenceAndQueryNil(t *testing.T) {
	if got := extractTenantID(map[string][]string{"x-tenant-id": {"t1"}}, map[string][]string{"tenant": {"t2"}}); got != "t1" {
		t.Fatalf("expected header tenant to win, got %q", got)
	}
	if got := extractTenantID(map[string][]string{}, nil); got != "" {
		t.Fatalf("expected empty tenant when query is nil, got %q", got)
	}
}

func TestFixtureApp_RecordP2_InfoLevel_OnSuccess(t *testing.T) {
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
		Query:  map[string][]string{"tenant": {"t1"}},
	})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}
	if len(app.logs) != 1 || app.logs[0].Level != "info" {
		t.Fatalf("expected info log entry, got %#v", app.logs)
	}
}

func TestBuiltInHandler_ParseJsonEcho_BadContentType_InvalidJSON_AndEmptyBody(t *testing.T) {
	handler := builtInHandler("parse_json_echo")
	if handler == nil {
		t.Fatal("expected parse_json_echo handler to exist")
	}

	_, err := handler(CanonicalRequest{
		Headers: map[string][]string{"content-type": {"text/plain"}},
		Body:    []byte(`{"ok":true}`),
	})
	if err == nil {
		t.Fatal("expected error for non-json content type")
	}

	_, err = handler(CanonicalRequest{
		Headers: map[string][]string{"content-type": {"application/json"}},
		Body:    []byte(`{`),
	})
	if err == nil {
		t.Fatal("expected error for invalid json")
	}

	resp, err := handler(CanonicalRequest{
		Headers: map[string][]string{"content-type": {"application/json"}},
		Body:    nil,
	})
	if err != nil {
		t.Fatalf("expected empty body to succeed, got %v", err)
	}
	if string(resp.Body) != "null" {
		t.Fatalf("expected empty body to marshal to null, got %s", string(resp.Body))
	}
}

func TestEqualHeadersAndSlices_MismatchCases(t *testing.T) {
	if equalStringSlices([]string{"a"}, []string{"a", "b"}) {
		t.Fatal("expected mismatched slice lengths to be false")
	}
	if equalHeaders(map[string][]string{"x": {"1"}}, map[string][]string{"y": {"1"}}) {
		t.Fatal("expected mismatched header keys to be false")
	}
	if equalHeaders(map[string][]string{"x": {"1"}}, map[string][]string{"x": {"2"}}) {
		t.Fatal("expected mismatched header values to be false")
	}
}
