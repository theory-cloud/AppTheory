package apptheory

import "testing"

func TestOriginURL(t *testing.T) {
	if got := OriginURL(nil); got != "" {
		t.Fatalf("expected empty origin url, got %q", got)
	}

	got := OriginURL(map[string][]string{
		"X-AppTheory-Original-Host":  {"edge.example.com"},
		"CloudFront-Forwarded-Proto": {"https"},
	})
	if got != "https://edge.example.com" {
		t.Fatalf("unexpected origin url from AppTheory edge host: %q", got)
	}

	got = OriginURL(map[string][]string{
		"X-FaceTheory-Original-Host": {"tenant.example.com"},
		"CloudFront-Forwarded-Proto": {"https"},
	})
	if got != "https://tenant.example.com" {
		t.Fatalf("unexpected origin url from FaceTheory edge host: %q", got)
	}

	got = OriginURL(map[string][]string{
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

func TestAuthoritativeOriginURL(t *testing.T) {
	// Without forwarded-host trust, only the platform-set host header is used.
	got := AuthoritativeOriginURL(map[string][]string{
		"Host":                       {"real.example.com"},
		"X-AppTheory-Original-Host":  {"evil.example.com"},
		"X-FaceTheory-Original-Host": {"evil.example.com"},
		"X-Forwarded-Host":           {"evil.example.com"},
		"Forwarded":                  {`host="evil.example.com"`},
		"X-Forwarded-Proto":          {"https"},
	}, false)
	if got != "https://real.example.com" {
		t.Fatalf("authoritative origin ignored the host header: %q", got)
	}

	// A forwarded host with no host header has no authoritative source.
	if routed := AuthoritativeOriginURL(map[string][]string{
		"X-Forwarded-Host": {"evil.example.com"},
	}, false); routed != "" {
		t.Fatalf("expected empty authoritative origin without host, got %q", routed)
	}

	// With forwarded-host trust the edge forward chain is honored, matching
	// OriginURL's priority.
	got = AuthoritativeOriginURL(map[string][]string{
		"Host":              {"internal.example.com"},
		"X-Forwarded-Host":  {"edge.example.com"},
		"X-Forwarded-Proto": {"https"},
	}, true)
	if got != "https://edge.example.com" {
		t.Fatalf("expected the forwarded host to be honored when trusted, got %q", got)
	}

	// A comma suffix is trimmed in both modes.
	got = AuthoritativeOriginURL(map[string][]string{
		"Host": {"real.example.com, internal.example.com"},
	}, false)
	if got != "https://real.example.com" {
		t.Fatalf("expected comma suffix to be trimmed, got %q", got)
	}
}

func TestOriginalHostAndURI(t *testing.T) {
	headers := map[string][]string{
		"X-AppTheory-Original-Host": {"app.example.com"},
		"X-AppTheory-Original-Uri":  {"/from-app"},
	}

	if got := OriginalHost(headers); got != "app.example.com" {
		t.Fatalf("unexpected original host: %q", got)
	}
	if got := OriginalURI(headers); got != "/from-app" {
		t.Fatalf("unexpected original uri: %q", got)
	}

	headers = map[string][]string{
		"X-FaceTheory-Original-Host": {"face.example.com"},
		"X-FaceTheory-Original-Uri":  {"/from-face"},
	}

	if got := OriginalHost(headers); got != "face.example.com" {
		t.Fatalf("unexpected FaceTheory original host: %q", got)
	}
	if got := OriginalURI(headers); got != "/from-face" {
		t.Fatalf("unexpected FaceTheory original uri: %q", got)
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
