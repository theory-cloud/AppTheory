package main

import (
	"context"
	"encoding/json"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/testkit"
)

func TestHelloWorldRoutes(t *testing.T) {
	t.Setenv("APPTHEORY_HELLO_LANG", "go")
	t.Setenv("APPTHEORY_TIER", "p0")

	env := testkit.New()
	app := buildApp()

	resp := env.Invoke(context.Background(), app, apptheory.Request{Method: "GET", Path: "/hello/AppTheory"})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if body["message"] != "hello AppTheory" || body["runtime"] != "go" {
		t.Fatalf("unexpected body: %#v", body)
	}

	root := env.Invoke(context.Background(), app, apptheory.Request{Method: "GET", Path: "/"})
	if root.Status != 200 {
		t.Fatalf("expected root status 200, got %d", root.Status)
	}
}
