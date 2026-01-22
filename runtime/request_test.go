package apptheory

import (
	"encoding/base64"
	"errors"
	"testing"
)

func TestNormalizePath(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"", "/"},
		{"   ", "/"},
		{"foo", "/foo"},
		{"/foo", "/foo"},
		{" /foo ", "/foo"},
		{"/foo?bar=baz", "/foo"},
		{"?bar=baz", "/"},
	}
	for _, tt := range tests {
		if got := normalizePath(tt.in); got != tt.want {
			t.Fatalf("normalizePath(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestCanonicalizeHeaders_StableAndLowercased(t *testing.T) {
	in := map[string][]string{
		"X-Test": {"a"},
		"x-test": {"b"},
		"  ":     {"ignored"},
		"Cookie": {"a=b; c=d"},
	}

	out := canonicalizeHeaders(in)
	if _, ok := out["  "]; ok {
		t.Fatal("expected whitespace header key to be dropped")
	}
	if got := out["x-test"]; len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("unexpected x-test values: %v", got)
	}
	if got := out["cookie"]; len(got) != 1 || got[0] != "a=b; c=d" {
		t.Fatalf("unexpected cookie values: %v", got)
	}
}

func TestParseCookies(t *testing.T) {
	cookies := parseCookies([]string{
		"a=b; c=d",
		" e = f ; ;",
		"nope",
		"=missing",
	})
	if cookies["a"] != "b" || cookies["c"] != "d" || cookies["e"] != "f" {
		t.Fatalf("unexpected cookies map: %v", cookies)
	}
	if _, ok := cookies[""]; ok {
		t.Fatal("expected empty cookie name to be dropped")
	}
}

func TestCloneQuery_CopiesSlices(t *testing.T) {
	in := map[string][]string{
		"a": {"1", "2"},
	}
	out := cloneQuery(in)
	out["a"][0] = "mutated"
	if in["a"][0] == "mutated" {
		t.Fatal("expected cloneQuery to deep-copy slice values")
	}
}

func TestNormalizeRequest_DecodesBase64AndParsesCookies(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("hello"))
	inQuery := map[string][]string{"a": {"1"}}
	req, err := normalizeRequest(Request{
		Method:   " get ",
		Path:     "foo",
		Query:    inQuery,
		Headers:  map[string][]string{"Cookie": {"a=b; c=d"}, "X-Test": {"v"}},
		Body:     []byte(encoded),
		IsBase64: true,
	})
	if err != nil {
		t.Fatalf("normalizeRequest returned error: %v", err)
	}
	if req.Method != "GET" || req.Path != "/foo" {
		t.Fatalf("unexpected normalized request: method=%q path=%q", req.Method, req.Path)
	}
	if string(req.Body) != "hello" {
		t.Fatalf("expected decoded body 'hello', got %q", string(req.Body))
	}
	if req.Cookies["a"] != "b" || req.Cookies["c"] != "d" {
		t.Fatalf("unexpected cookies: %v", req.Cookies)
	}
	if req.Headers["x-test"][0] != "v" {
		t.Fatalf("expected canonicalized header x-test=v, got %v", req.Headers["x-test"])
	}
	req.Query["a"][0] = "mutated"
	if inQuery["a"][0] == "mutated" {
		t.Fatal("unexpected query aliasing")
	}
}

func TestNormalizeRequest_InvalidBase64ReturnsAppError(t *testing.T) {
	_, err := normalizeRequest(Request{
		Method:   "GET",
		Path:     "/",
		Body:     []byte("not-base64"),
		IsBase64: true,
	})
	if err == nil {
		t.Fatal("expected error")
	}
	var appErr *AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected AppError, got %T", err)
	}
	if appErr.Code != errorCodeBadRequest {
		t.Fatalf("expected code %q, got %q", errorCodeBadRequest, appErr.Code)
	}
}
