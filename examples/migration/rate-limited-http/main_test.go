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
