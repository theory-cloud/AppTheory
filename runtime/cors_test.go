package apptheory

import "testing"

func TestNormalizeCORSConfig(t *testing.T) {
	cfg := normalizeCORSConfig(CORSConfig{
		AllowedOrigins:   []string{"  ", "https://a.example", "*", "https://b.example"},
		AllowCredentials: true,
		AllowHeaders:     []string{"  Content-Type ", "", "X-Test"},
	})
	if len(cfg.AllowedOrigins) != 1 || cfg.AllowedOrigins[0] != "*" {
		t.Fatalf("expected wildcard allowed origins, got %v", cfg.AllowedOrigins)
	}
	if !cfg.AllowCredentials {
		t.Fatal("expected AllowCredentials=true")
	}
	if len(cfg.AllowHeaders) != 2 || cfg.AllowHeaders[0] != "Content-Type" || cfg.AllowHeaders[1] != "X-Test" {
		t.Fatalf("unexpected allow headers: %v", cfg.AllowHeaders)
	}
}

func TestCORSOriginAllowed(t *testing.T) {
	if corsOriginAllowed("", CORSConfig{}) {
		t.Fatal("expected empty origin to be rejected")
	}
	if !corsOriginAllowed("https://x.example", CORSConfig{AllowedOrigins: nil}) {
		t.Fatal("expected nil AllowedOrigins to allow all")
	}
	if corsOriginAllowed("https://x.example", CORSConfig{AllowedOrigins: []string{}}) {
		t.Fatal("expected empty AllowedOrigins slice to deny all")
	}
	if !corsOriginAllowed("https://x.example", CORSConfig{AllowedOrigins: []string{"*"}}) {
		t.Fatal("expected wildcard to allow origin")
	}
	if !corsOriginAllowed("https://x.example", CORSConfig{AllowedOrigins: []string{"https://x.example"}}) {
		t.Fatal("expected exact match to allow origin")
	}
	if corsOriginAllowed("https://x.example", CORSConfig{AllowedOrigins: []string{"https://y.example"}}) {
		t.Fatal("expected non-match to be denied")
	}
}

func TestCORSAllowHeadersValue(t *testing.T) {
	if got := corsAllowHeadersValue(CORSConfig{AllowHeaders: []string{"A", "B"}}); got != "A, B" {
		t.Fatalf("unexpected allow headers: %q", got)
	}
	if got := corsAllowHeadersValue(CORSConfig{AllowCredentials: true}); got != "Content-Type, Authorization" {
		t.Fatalf("unexpected allow headers for credentials: %q", got)
	}
	if got := corsAllowHeadersValue(CORSConfig{}); got != "" {
		t.Fatalf("expected empty allow headers, got %q", got)
	}
}

func TestWithCORS_Normalizes(t *testing.T) {
	app := New(WithCORS(CORSConfig{AllowedOrigins: []string{" ", "*"}}))
	if app == nil {
		t.Fatal("expected app")
	}
	if len(app.cors.AllowedOrigins) != 1 || app.cors.AllowedOrigins[0] != "*" {
		t.Fatalf("unexpected stored cors config: %v", app.cors.AllowedOrigins)
	}
}
