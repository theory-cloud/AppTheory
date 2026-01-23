package apptheory

import (
	"encoding/json"
	"testing"
)

func TestText(t *testing.T) {
	resp := Text(200, "hello")
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	if ct := resp.Headers["content-type"]; len(ct) != 1 || ct[0] != "text/plain; charset=utf-8" {
		t.Fatalf("unexpected content-type: %v", ct)
	}
	if string(resp.Body) != "hello" {
		t.Fatalf("unexpected body: %q", string(resp.Body))
	}
	if resp.IsBase64 {
		t.Fatal("expected IsBase64=false")
	}
}

func TestJSONAndMustJSON(t *testing.T) {
	resp, err := JSON(201, map[string]any{"ok": true})
	if err != nil {
		t.Fatalf("JSON returned error: %v", err)
	}
	if resp.Status != 201 {
		t.Fatalf("expected status 201, got %d", resp.Status)
	}

	var parsed map[string]any
	if err := json.Unmarshal(resp.Body, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if parsed["ok"] != true {
		t.Fatalf("expected ok=true, got %v", parsed["ok"])
	}

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected MustJSON to panic for non-marshalable value")
		}
	}()
	_ = MustJSON(200, func() {})
}

func TestBinaryCopiesBody(t *testing.T) {
	body := []byte{0x01, 0x02, 0x03}
	resp := Binary(200, body, "application/octet-stream")
	body[0] = 0xff
	if resp.Body[0] == 0xff {
		t.Fatal("expected Binary to copy body bytes")
	}
	if !resp.IsBase64 {
		t.Fatal("expected IsBase64=true")
	}
	if ct := resp.Headers["content-type"]; len(ct) != 1 || ct[0] != "application/octet-stream" {
		t.Fatalf("unexpected content-type: %v", ct)
	}
}

func TestNormalizeResponse(t *testing.T) {
	out := normalizeResponse(nil)
	if out.Status != 500 {
		t.Fatalf("expected status 500 for nil response, got %d", out.Status)
	}

	in := &Response{
		Status: 0,
		Headers: map[string][]string{
			"X-Test":     {"a"},
			"set-cookie": {"a=b; Path=/", "c=d; Path=/"},
		},
		Cookies: []string{"e=f; Path=/"},
		Body:    []byte("hi"),
	}
	n := normalizeResponse(in)
	if n.Status != 200 {
		t.Fatalf("expected default status 200, got %d", n.Status)
	}
	if _, ok := n.Headers["set-cookie"]; ok {
		t.Fatal("expected set-cookie to be removed from headers")
	}
	if got := n.Headers["x-test"]; len(got) != 1 || got[0] != "a" {
		t.Fatalf("unexpected x-test header: %v", got)
	}
	if len(n.Cookies) != 3 {
		t.Fatalf("expected 3 cookies, got %v", n.Cookies)
	}
	// Ensure slices are copied.
	in.Body[0] = 'X'
	if string(n.Body) == string(in.Body) {
		t.Fatal("expected normalizeResponse to copy body bytes")
	}
	in.Cookies[0] = "mutated"
	if n.Cookies[0] == "mutated" {
		t.Fatal("expected normalizeResponse to copy cookies slice")
	}
}
