package testkit_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory"
	"github.com/theory-cloud/apptheory/testkit"
)

func TestEnvDeterministicTime(t *testing.T) {
	now := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	env := testkit.NewWithTime(now)

	app := env.App()
	app.Get("/now", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.MustJSON(200, map[string]any{
			"unix": ctx.Now().Unix(),
		}), nil
	})

	resp := env.Invoke(context.Background(), app, apptheory.Request{
		Method: "GET",
		Path:   "/now",
	})

	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}

	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("parse response json: %v", err)
	}
	if body["unix"] != float64(now.Unix()) {
		t.Fatalf("expected unix %d, got %#v", now.Unix(), body["unix"])
	}
}

func TestEnvDeterministicIDs(t *testing.T) {
	env := testkit.New()

	app := env.App()
	app.Get("/ids", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.MustJSON(200, map[string]any{
			"a": ctx.NewID(),
			"b": ctx.NewID(),
		}), nil
	})

	resp := env.Invoke(context.Background(), app, apptheory.Request{
		Method: "GET",
		Path:   "/ids",
		Headers: map[string][]string{
			"x-request-id": {"req-1"},
		},
	})

	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	if got := resp.Headers["x-request-id"]; len(got) != 1 || got[0] != "req-1" {
		t.Fatalf("expected x-request-id req-1, got %#v", got)
	}

	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("parse response json: %v", err)
	}

	if body["a"] != "test-id-1" {
		t.Fatalf("expected a test-id-1, got %#v", body["a"])
	}
	if body["b"] != "test-id-2" {
		t.Fatalf("expected b test-id-2, got %#v", body["b"])
	}
}
