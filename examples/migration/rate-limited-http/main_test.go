package main

import "testing"

func TestResolveRegion(t *testing.T) {
	env := map[string]string{
		"AWS_REGION": "us-west-2",
	}
	get := func(key string) string { return env[key] }
	if got := resolveRegion(get); got != "us-west-2" {
		t.Fatalf("expected us-west-2, got %q", got)
	}

	env = map[string]string{
		"AWS_DEFAULT_REGION": "eu-north-1",
	}
	get = func(key string) string { return env[key] }
	if got := resolveRegion(get); got != "eu-north-1" {
		t.Fatalf("expected eu-north-1, got %q", got)
	}

	env = map[string]string{}
	get = func(key string) string { return env[key] }
	if got := resolveRegion(get); got != "us-east-1" {
		t.Fatalf("expected us-east-1, got %q", got)
	}

	if got := resolveRegion(nil); got != "us-east-1" {
		t.Fatalf("expected us-east-1 for nil getenv, got %q", got)
	}
}
