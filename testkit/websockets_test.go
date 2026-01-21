package testkit

import (
	"context"
	"testing"

	"github.com/theory-cloud/apptheory/pkg/streamer"
	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func TestWebSocketEvent_DefaultsAndCloning(t *testing.T) {
	headers := map[string]string{"x-test": "v"}
	multi := map[string][]string{"x-multi": {"a", "b"}}
	event := WebSocketEvent(WebSocketEventOptions{
		Headers:           headers,
		MultiValueHeaders: multi,
		Body:              "hi",
	})

	if event.RequestContext.RouteKey != "$default" {
		t.Fatalf("expected default route key, got %q", event.RequestContext.RouteKey)
	}
	if event.RequestContext.EventType != "MESSAGE" {
		t.Fatalf("expected default event type MESSAGE, got %q", event.RequestContext.EventType)
	}
	if event.RequestContext.ConnectionID != "conn-1" {
		t.Fatalf("expected default connection id conn-1, got %q", event.RequestContext.ConnectionID)
	}
	if event.RequestContext.DomainName == "" || event.RequestContext.Stage == "" || event.RequestContext.RequestID == "" {
		t.Fatalf("expected defaults for domain/stage/request id, got %#v", event.RequestContext)
	}

	headers["x-test"] = "mutated"
	if event.Headers["x-test"] != "v" {
		t.Fatalf("expected headers to be cloned, got %v", event.Headers)
	}
	multi["x-multi"][0] = "mutated"
	if event.MultiValueHeaders["x-multi"][0] != "a" {
		t.Fatalf("expected multivalue headers to be cloned, got %v", event.MultiValueHeaders)
	}
}

func TestFakeStreamerClient(t *testing.T) {
	client := NewFakeStreamerClient("  https://example.com  ")
	if client.Endpoint != "https://example.com" {
		t.Fatalf("unexpected endpoint: %q", client.Endpoint)
	}

	if err := client.PostToConnection(context.Background(), "", []byte("x")); err == nil {
		t.Fatal("expected error for empty connection id")
	}
	if _, err := client.GetConnection(context.Background(), ""); err == nil {
		t.Fatal("expected error for empty connection id")
	}
	if err := client.DeleteConnection(context.Background(), ""); err == nil {
		t.Fatal("expected error for empty connection id")
	}

	client.Connections["c1"] = streamer.Connection{IdentityIP: "1.2.3.4"}
	if _, err := client.GetConnection(context.Background(), "missing"); err == nil {
		t.Fatal("expected connection not found error")
	}
	conn, err := client.GetConnection(context.Background(), "c1")
	if err != nil || conn.IdentityIP != "1.2.3.4" {
		t.Fatalf("unexpected conn: %#v err=%v", conn, err)
	}

	if err := client.PostToConnection(context.Background(), "c1", []byte("hi")); err != nil {
		t.Fatalf("PostToConnection returned error: %v", err)
	}
	if err := client.DeleteConnection(context.Background(), "c1"); err != nil {
		t.Fatalf("DeleteConnection returned error: %v", err)
	}
	if len(client.Calls) != 4 {
		t.Fatalf("expected 4 calls, got %d", len(client.Calls))
	}
}

func TestEnv_InvokeWebSocket(t *testing.T) {
	env := New()
	app := env.App(apptheory.WithTier(apptheory.TierP0))
	app.WebSocket("$default", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		ws := ctx.AsWebSocket()
		return apptheory.MustJSON(200, map[string]any{"route_key": ws.RouteKey}), nil
	})

	out := env.InvokeWebSocket(context.Background(), app, WebSocketEvent(WebSocketEventOptions{Body: "hi"}))
	if out.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", out.StatusCode)
	}
}
