package apptheory

import (
	"strings"
	"testing"
)

func TestHTML(t *testing.T) {
	resp := HTML(200, "<h1>Hello</h1>")
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	if ct := resp.Headers["content-type"]; len(ct) != 1 || ct[0] != "text/html; charset=utf-8" {
		t.Fatalf("unexpected content-type: %v", ct)
	}
	if string(resp.Body) != "<h1>Hello</h1>" {
		t.Fatalf("unexpected body: %q", string(resp.Body))
	}

	b := []byte("abc")
	resp = HTML(200, b)
	b[0] = 'X'
	if string(resp.Body) != "abc" {
		t.Fatalf("expected HTML to copy byte slice, got %q", string(resp.Body))
	}

	resp = HTML(200, nil)
	if resp.Body != nil {
		t.Fatalf("expected nil body, got %v", resp.Body)
	}

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected HTML to panic on unsupported body type")
		}
	}()
	_ = HTML(200, 123)
}

func TestHTMLStream(t *testing.T) {
	stream := StreamBytes([]byte("a"), []byte("b"))
	resp := HTMLStream(200, stream)
	if resp.BodyStream == nil {
		t.Fatal("expected BodyStream to be set")
	}
	if resp.IsBase64 {
		t.Fatal("expected IsBase64=false")
	}
}

func TestSafeJSONForHTML_EscapesSensitiveSequences(t *testing.T) {
	out, err := SafeJSONForHTML(map[string]any{
		"html": "</script><div>&</div><",
		"ls":   "line\u2028sep",
		"ps":   "para\u2029sep",
	})
	if err != nil {
		t.Fatalf("SafeJSONForHTML returned error: %v", err)
	}
	if strings.Contains(out, "<") || strings.Contains(out, ">") || strings.Contains(out, "&") {
		t.Fatalf("expected output to not contain raw <, >, &: %q", out)
	}
	for _, token := range []string{"\\u003c", "\\u003e", "\\u0026", "\\u2028", "\\u2029"} {
		if !strings.Contains(out, token) {
			t.Fatalf("expected output to contain %q, got %q", token, out)
		}
	}
}
