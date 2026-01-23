package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestStatusForError_UnknownDefaultsTo500(t *testing.T) {
	if got := statusForError("nope"); got != 500 {
		t.Fatalf("expected unknown status to map to 500, got %d", got)
	}
}

func TestMatchPath_CoversMismatchAndParamCases(t *testing.T) {
	if _, ok := matchPath([]string{"a"}, []string{"a", "b"}); ok {
		t.Fatal("expected mismatch lengths to not match")
	}
	if _, ok := matchPath([]string{"a", "{id}"}, []string{"a", ""}); ok {
		t.Fatal("expected empty path segment to not match")
	}
	params, ok := matchPath([]string{"a", "{id}"}, []string{"a", "123"})
	if !ok || params["id"] != "123" {
		t.Fatalf("expected param match, got ok=%v params=%#v", ok, params)
	}
	if _, ok := matchPath([]string{"a", "b"}, []string{"a", "c"}); ok {
		t.Fatal("expected literal mismatch to not match")
	}
}

func TestParseCookies_SkipsInvalidPartsAndTrims(t *testing.T) {
	out := parseCookies([]string{
		"a=b; c = d ",
		"noequals",
		"=ignored",
		" empty =  ",
	})
	if out["a"] != "b" || out["c"] != "d" {
		t.Fatalf("unexpected cookies: %#v", out)
	}
	if _, ok := out["noequals"]; ok {
		t.Fatalf("expected invalid cookie to be skipped: %#v", out)
	}
	if _, ok := out[""]; ok {
		t.Fatalf("expected empty cookie name to be skipped: %#v", out)
	}
}

func TestCanonicalizeRequest_Base64BodyAndCookiesAndInvalidBase64(t *testing.T) {
	bodyB64 := base64.StdEncoding.EncodeToString([]byte("hi"))

	req, err := canonicalizeRequest(FixtureRequest{
		Method: "GET",
		Path:   "",
		Headers: map[string][]string{
			"Cookie": {"a=b; c=d"},
		},
		Body: FixtureBody{
			Encoding: "base64",
			Value:    bodyB64,
		},
		IsBase64: false,
	})
	if err != nil {
		t.Fatalf("canonicalizeRequest: %v", err)
	}
	if req.Path != "/" {
		t.Fatalf("expected empty path to normalize to /, got %q", req.Path)
	}
	if string(req.Body) != "hi" {
		t.Fatalf("expected decoded body, got %q", string(req.Body))
	}
	if req.Cookies["a"] != "b" || req.Cookies["c"] != "d" {
		t.Fatalf("expected cookies to be parsed, got %#v", req.Cookies)
	}

	_, err = canonicalizeRequest(FixtureRequest{
		Method:   "GET",
		Path:     "/",
		Headers:  map[string][]string{},
		Body:     FixtureBody{Encoding: "utf8", Value: "not base64"},
		IsBase64: true,
	})
	if err == nil {
		t.Fatal("expected IsBase64 body decode to fail")
	}

	_, err = decodeFixtureBody(FixtureBody{Encoding: "base64", Value: "!!!"})
	if err == nil {
		t.Fatal("expected base64 body decode to fail")
	}
}

func TestFixtureApp_HandleP1_AuthRequired_Authorized(t *testing.T) {
	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "GET", Path: "/auth", Handler: "echo_middleware_trace", AuthRequired: true},
		},
	}, "p1")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	resp := app.handle(CanonicalRequest{
		Method: "GET",
		Path:   "/auth",
		Headers: map[string][]string{
			"authorization": {"Bearer ok"},
		},
	})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d (%s)", resp.Status, string(resp.Body))
	}

	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	trace, ok := body["trace"].([]any)
	if !ok {
		t.Fatalf("expected trace to be []any, got %T", body["trace"])
	}

	var sawAuth bool
	for _, v := range trace {
		if v == "auth" {
			sawAuth = true
			break
		}
	}
	if !sawAuth {
		t.Fatalf("expected auth middleware trace entry, got %#v", trace)
	}
}

func TestFixtureApp_HandleP2_PanicRecovery_RecordsInternalErrorSideEffects(t *testing.T) {
	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "GET", Path: "/panic", Handler: "panic"},
		},
	}, "p2")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	resp := app.handle(CanonicalRequest{
		Method: "GET",
		Path:   "/panic",
		Query:  map[string][]string{"tenant": {"t1"}},
		Headers: map[string][]string{
			"origin": {"https://example.com"},
		},
	})
	if resp.Status != 500 {
		t.Fatalf("expected 500, got %d (%s)", resp.Status, string(resp.Body))
	}
	if len(app.logs) != 1 || app.logs[0].ErrorCode != appErrorInternal || app.logs[0].Level != "error" {
		t.Fatalf("expected internal error log, got %#v", app.logs)
	}
	if len(app.metrics) != 1 || app.metrics[0].Tags["error_code"] != appErrorInternal {
		t.Fatalf("expected internal error metric, got %#v", app.metrics)
	}
	if len(app.spans) != 1 || app.spans[0].Attributes["error.code"] != appErrorInternal {
		t.Fatalf("expected internal error span, got %#v", app.spans)
	}
}

func TestFixtureApp_HandleP2_ForcedShed(t *testing.T) {
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
			"x-force-shed": {"1"},
		},
	})
	if resp.Status != 503 {
		t.Fatalf("expected 503, got %d", resp.Status)
	}
	if got := firstHeaderValue(resp.Headers, "retry-after"); got != "1" {
		t.Fatalf("expected retry-after=1, got %q", got)
	}
	if len(app.logs) != 1 || app.logs[0].ErrorCode != appErrorOverloaded {
		t.Fatalf("expected overloaded side effects, got %#v", app.logs)
	}
}

func TestAppErrorResponse_IncludesRequestIDWhenProvided(t *testing.T) {
	resp := appErrorResponse(appErrorBadRequest, msgInvalidJSON, nil, "")
	if resp.Status != 400 {
		t.Fatalf("expected 400, got %d", resp.Status)
	}
	if strings.Contains(string(resp.Body), "request_id") {
		t.Fatalf("did not expect request_id in body when requestID empty: %s", string(resp.Body))
	}

	resp = appErrorResponse(appErrorBadRequest, msgInvalidJSON, nil, "req_1")
	if !strings.Contains(string(resp.Body), "request_id") {
		t.Fatalf("expected request_id in body when requestID provided: %s", string(resp.Body))
	}
}
