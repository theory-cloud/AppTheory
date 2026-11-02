package main

import "testing"

func TestResolveRegion_PrefersAWSRegionThenDefaultThenFallback(t *testing.T) {
	if got := resolveRegion(nil); got != "us-east-1" {
		t.Fatalf("expected default region, got %q", got)
	}

	env := map[string]string{
		"AWS_REGION":         "us-west-2",
		"AWS_DEFAULT_REGION": "eu-west-1",
	}
	getenv := func(key string) string { return env[key] }
	if got := resolveRegion(getenv); got != "us-west-2" {
		t.Fatalf("expected AWS_REGION to win, got %q", got)
	}

	env["AWS_REGION"] = ""
	if got := resolveRegion(getenv); got != "eu-west-1" {
		t.Fatalf("expected AWS_DEFAULT_REGION fallback, got %q", got)
	}

	env["AWS_DEFAULT_REGION"] = ""
	if got := resolveRegion(getenv); got != "us-east-1" {
		t.Fatalf("expected us-east-1 fallback, got %q", got)
	}
}

func TestResolveListenAddr_PrefersHarnessValueThenDefault(t *testing.T) {
	if got := resolveListenAddr(nil); got != ":8080" {
		t.Fatalf("expected the documented default, got %q", got)
	}

	empty := func(string) string { return "" }
	if got := resolveListenAddr(empty); got != ":8080" {
		t.Fatalf("expected the documented default for an unset override, got %q", got)
	}

	env := map[string]string{"LISTEN_ADDR": "127.0.0.1:8131"}
	getenv := func(key string) string { return env[key] }
	if got := resolveListenAddr(getenv); got != "127.0.0.1:8131" {
		t.Fatalf("expected the harness listen address to win, got %q", got)
	}
}
