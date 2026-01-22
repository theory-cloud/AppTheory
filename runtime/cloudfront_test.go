package apptheory

import "testing"

func TestOriginURL(t *testing.T) {
	if got := OriginURL(nil); got != "" {
		t.Fatalf("expected empty origin url, got %q", got)
	}

	got := OriginURL(map[string][]string{
		"Host":            {"example.com"},
		"X-Forwarded-For": {"1.2.3.4"},
	})
	if got != "https://example.com" {
		t.Fatalf("unexpected origin url: %q", got)
	}

	got = OriginURL(map[string][]string{
		"X-Forwarded-Host":  {"a.example, b.example"},
		"X-Forwarded-Proto": {"http"},
	})
	if got != "http://a.example" {
		t.Fatalf("unexpected origin url: %q", got)
	}

	got = OriginURL(map[string][]string{
		"Forwarded": {`for=203.0.113.1;proto=https;host="f.example"`},
	})
	if got != "https://f.example" {
		t.Fatalf("unexpected origin url from forwarded: %q", got)
	}
}

func TestClientIP(t *testing.T) {
	got := ClientIP(map[string][]string{
		"CloudFront-Viewer-Address": {`203.0.113.9:1234`},
	})
	if got != "203.0.113.9" {
		t.Fatalf("unexpected client ip: %q", got)
	}

	got = ClientIP(map[string][]string{
		"CloudFront-Viewer-Address": {`[2001:db8::1]:443`},
	})
	if got != "2001:db8::1" {
		t.Fatalf("unexpected ipv6 client ip: %q", got)
	}

	got = ClientIP(map[string][]string{
		"X-Forwarded-For": {"1.2.3.4, 5.6.7.8"},
	})
	if got != "1.2.3.4" {
		t.Fatalf("unexpected forwarded-for client ip: %q", got)
	}
}

func TestParseForwardedHeader(t *testing.T) {
	proto, host := parseForwardedHeader(`for=1.1.1.1; proto=https; host="example.com"`)
	if proto != "https" || host != "example.com" {
		t.Fatalf("unexpected parsed forwarded header: proto=%q host=%q", proto, host)
	}
}
