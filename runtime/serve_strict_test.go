package apptheory

import (
	"context"
	"testing"
)

func TestHandleStrict_ReturnsErrorOnInvalidPattern(t *testing.T) {
	app := New()
	_, err := app.HandleStrict("GET", "/{proxy+}/x", func(*Context) (*Response, error) {
		return Text(200, "ok"), nil
	})
	if err == nil {
		t.Fatal("expected HandleStrict to return an error for invalid pattern")
	}
}

func TestHandleStrict_NilAppReturnsError(t *testing.T) {
	var app *App
	_, err := app.HandleStrict("GET", "/", func(*Context) (*Response, error) {
		return Text(200, "ok"), nil
	})
	if err == nil {
		t.Fatal("expected nil app to return an error")
	}
}

func TestGetStrict_RegistersRouteAndServes(t *testing.T) {
	app := New()
	if _, err := app.GetStrict("/ping", func(*Context) (*Response, error) {
		return Text(200, "pong"), nil
	}); err != nil {
		t.Fatalf("expected GetStrict to succeed, got err: %v", err)
	}

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/ping"})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
}
