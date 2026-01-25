package apptheory

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory/pkg/streamer"
)

type fakeStreamerClient struct {
	postCalls []struct {
		connectionID string
		data         []byte
	}
}

func (f *fakeStreamerClient) PostToConnection(_ context.Context, connectionID string, data []byte) error {
	f.postCalls = append(f.postCalls, struct {
		connectionID string
		data         []byte
	}{connectionID: connectionID, data: append([]byte(nil), data...)})
	return nil
}
func (f *fakeStreamerClient) GetConnection(_ context.Context, _ string) (streamer.Connection, error) {
	return streamer.Connection{}, nil
}
func (f *fakeStreamerClient) DeleteConnection(_ context.Context, _ string) error { return nil }

func TestWebSocketManagementEndpoint(t *testing.T) {
	if got := webSocketManagementEndpoint("", "dev", "/"); got != "" {
		t.Fatalf("expected empty endpoint, got %q", got)
	}

	if got := webSocketManagementEndpoint("example.execute-api.us-east-1.amazonaws.com", "/dev/", "/"); got != "https://example.execute-api.us-east-1.amazonaws.com/dev" {
		t.Fatalf("unexpected endpoint: %q", got)
	}

	if got := webSocketManagementEndpoint("ws.example.com", "production", "/"); got != "https://ws.example.com" {
		t.Fatalf("unexpected endpoint: %q", got)
	}

	if got := webSocketManagementEndpoint("ws.example.com", "production", "/socket"); got != "https://ws.example.com/socket" {
		t.Fatalf("unexpected endpoint: %q", got)
	}
}

func TestWebSocketContext_SendMessage(t *testing.T) {
	client := &fakeStreamerClient{}
	ws := &WebSocketContext{
		ctx:                context.Background(),
		ConnectionID:       "c1",
		ManagementEndpoint: "https://example.com/dev",
		clientFactory: func(_ context.Context, _ string) (streamer.Client, error) {
			return client, nil
		},
	}

	if err := ws.SendMessage([]byte("hi")); err != nil {
		t.Fatalf("SendMessage returned error: %v", err)
	}
	if len(client.postCalls) != 1 || client.postCalls[0].connectionID != "c1" || string(client.postCalls[0].data) != "hi" {
		t.Fatalf("unexpected post calls: %#v", client.postCalls)
	}
}

func TestWebSocketContext_SendMessage_Errors(t *testing.T) {
	ws := &WebSocketContext{}
	if err := ws.SendMessage([]byte("hi")); err == nil {
		t.Fatal("expected error for empty connection id")
	}

	ws = &WebSocketContext{ConnectionID: "c1"}
	if err := ws.SendMessage([]byte("hi")); err == nil {
		t.Fatal("expected error for missing client factory")
	}

	ws = &WebSocketContext{
		ConnectionID: "c1",
		clientFactory: func(_ context.Context, _ string) (streamer.Client, error) {
			return nil, nil
		},
	}
	if err := ws.SendMessage([]byte("hi")); err == nil {
		t.Fatal("expected error for nil client from factory")
	}
}

func TestServeWebSocket_NotFoundByTier(t *testing.T) {
	event := events.APIGatewayWebsocketProxyRequest{
		HTTPMethod: "GET",
		Path:       "/",
		RequestContext: events.APIGatewayWebsocketProxyRequestContext{
			RouteKey:   "$default",
			RequestID:  "",
			DomainName: "example.com",
			Stage:      "dev",
		},
	}

	appP0 := New(WithTier(TierP0))
	out := appP0.ServeWebSocket(context.Background(), event)
	if out.StatusCode != 404 {
		t.Fatalf("expected 404, got %d", out.StatusCode)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(out.Body), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	errObj, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected error object, got %T", body["error"])
	}
	if _, hasRequestID := errObj["request_id"]; hasRequestID {
		t.Fatal("expected p0 websocket not-found to omit request_id")
	}

	appP2 := New(WithTier(TierP2))
	out = appP2.ServeWebSocket(context.Background(), event)
	if out.StatusCode != 404 {
		t.Fatalf("expected 404, got %d", out.StatusCode)
	}
	if err := json.Unmarshal([]byte(out.Body), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	errObj, ok = body["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected error object, got %T", body["error"])
	}
	if _, hasRequestID := errObj["request_id"]; !hasRequestID {
		t.Fatal("expected non-p0 websocket not-found to include request_id")
	}
}

func TestServeWebSocket_HandlerHappyPathAndSendJSON(t *testing.T) {
	client := &fakeStreamerClient{}

	app := New(
		WithTier(TierP2),
		WithWebSocketClientFactory(func(_ context.Context, _ string) (streamer.Client, error) {
			return client, nil
		}),
	)
	app.WebSocket("$default", func(ctx *Context) (*Response, error) {
		ws := ctx.AsWebSocket()
		if ws == nil {
			return nil, errors.New("expected websocket context")
		}
		if err := ws.SendJSONMessage(map[string]any{"ok": true}); err != nil {
			return nil, err
		}
		return MustJSON(200, map[string]any{
			"route_key":     ws.RouteKey,
			"connection_id": ws.ConnectionID,
			"endpoint":      ws.ManagementEndpoint,
		}), nil
	})

	event := events.APIGatewayWebsocketProxyRequest{
		HTTPMethod: "GET",
		Path:       "/",
		Headers:    map[string]string{"x-tenant-id": "t1"},
		RequestContext: events.APIGatewayWebsocketProxyRequestContext{
			RouteKey:         "$default",
			RequestID:        "",
			ConnectionID:     "c1",
			DomainName:       "example.com",
			Stage:            "dev",
			EventType:        "MESSAGE",
			ConnectedAt:      0,
			MessageDirection: "",
		},
		Body:            "hi",
		IsBase64Encoded: false,
	}

	out := app.ServeWebSocket(context.Background(), event)
	if out.StatusCode != 200 {
		t.Fatalf("expected 200, got %d (%s)", out.StatusCode, out.Body)
	}
	if len(client.postCalls) != 1 {
		t.Fatalf("expected one websocket post call, got %d", len(client.postCalls))
	}
}

func TestServeWebSocket_InvalidBase64Body(t *testing.T) {
	app := New(WithTier(TierP2))
	app.WebSocket("$default", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })

	out := app.ServeWebSocket(context.Background(), events.APIGatewayWebsocketProxyRequest{
		HTTPMethod:      "GET",
		Path:            "/",
		Body:            "not base64",
		IsBase64Encoded: true,
		RequestContext: events.APIGatewayWebsocketProxyRequestContext{
			RouteKey:  "$default",
			RequestID: "req_1",
		},
	})

	if out.StatusCode != 400 {
		t.Fatalf("expected 400, got %d", out.StatusCode)
	}
}
