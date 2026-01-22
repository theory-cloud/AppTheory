package main

import (
	"context"
	"encoding/json"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func TestBuildApp_Routes(t *testing.T) {
	t.Setenv("APPTHEORY_TIER", "p0")
	t.Setenv("APPTHEORY_DEMO_NAME", "demo")
	t.Setenv("APPTHEORY_LANG", "go")

	app := buildApp()
	if app == nil {
		t.Fatal("expected app")
	}

	resp := app.Serve(context.Background(), apptheory.Request{Method: "GET", Path: "/"})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["ok"] != true || body["lang"] != "go" || body["name"] != "demo" || body["tier"] != "p0" {
		t.Fatalf("unexpected body: %v", body)
	}

	resp = app.Serve(context.Background(), apptheory.Request{Method: "GET", Path: "/hello/world"})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	body = map[string]any{}
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["message"] != "hello world" {
		t.Fatalf("unexpected message: %v", body["message"])
	}
}
