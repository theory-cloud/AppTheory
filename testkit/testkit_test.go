package testkit_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
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

func TestEnvInvoke_ContextTODO(t *testing.T) {
	env := testkit.New()
	app := env.App()

	app.Get("/ping", func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(200, "pong"), nil
	})

	resp := env.Invoke(context.TODO(), app, apptheory.Request{
		Method: "GET",
		Path:   "/ping",
	})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
}

func TestManualClock_SetAndAdvance(t *testing.T) {
	now := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := testkit.NewManualClock(now)

	clock.Set(now.Add(time.Second))
	if got := clock.Now(); !got.Equal(now.Add(time.Second)) {
		t.Fatalf("expected %v, got %v", now.Add(time.Second), got)
	}

	advanced := clock.Advance(2 * time.Second)
	if !advanced.Equal(now.Add(3 * time.Second)) {
		t.Fatalf("expected %v, got %v", now.Add(3*time.Second), advanced)
	}
}

func TestManualIDGenerator_QueueResetAndNewID(t *testing.T) {
	ids := testkit.NewManualIDGenerator()

	ids.Queue("queued-1", "queued-2")
	if got := ids.NewID(); got != "queued-1" {
		t.Fatalf("expected queued-1, got %q", got)
	}
	if got := ids.NewID(); got != "queued-2" {
		t.Fatalf("expected queued-2, got %q", got)
	}

	if got := ids.NewID(); got != "test-id-1" {
		t.Fatalf("expected test-id-1, got %q", got)
	}

	ids.Reset()
	if got := ids.NewID(); got != "test-id-1" {
		t.Fatalf("expected reset to start at test-id-1, got %q", got)
	}
}
