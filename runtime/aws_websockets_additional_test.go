package apptheory

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory/pkg/streamer"
)

func TestWebSocketOptionsAndRegistration(t *testing.T) {
	t.Parallel()

	app := New()
	if app.webSocketEnabled {
		t.Fatal("expected websockets disabled by default")
	}

	WithWebSocketSupport()(app)
	if !app.webSocketEnabled {
		t.Fatal("expected WithWebSocketSupport to enable websockets")
	}

	app.WebSocket("  ", func(*Context) (*Response, error) { return Text(200, "ok"), nil })
	if len(app.webSocketRoutes) != 0 {
		t.Fatal("expected empty route key to be ignored")
	}

	app.WebSocket("$default", nil)
	if len(app.webSocketRoutes) != 0 {
		t.Fatal("expected nil handler to be ignored")
	}

	app.WebSocket("$default", func(*Context) (*Response, error) { return Text(200, "ok"), nil })
	if app.webSocketHandlerForRoute(" $default ") == nil {
		t.Fatal("expected handler lookup by trimmed route key")
	}
	if app.webSocketHandlerForRoute("") != nil {
		t.Fatal("expected empty route key to return nil handler")
	}
}

func TestWebSocketContext_TimeIDsAndClientCaching(t *testing.T) {
	t.Parallel()

	fixedNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	client := &fakeStreamerClient{}
	var calls int

	ws := &WebSocketContext{
		ctx:                context.Background(),
		clock:              testFixedClock{now: fixedNow},
		ids:                fixedIDGenerator("id_1"),
		ConnectionID:       "c1",
		ManagementEndpoint: "https://example.com/dev",
		clientFactory: func(_ context.Context, _ string) (streamer.Client, error) {
			calls++
			return client, nil
		},
	}

	if got := ws.Now(); !got.Equal(fixedNow) {
		t.Fatalf("expected fixed Now, got %v", got)
	}
	if got := ws.NewID(); got != "id_1" {
		t.Fatalf("expected fixed NewID, got %q", got)
	}

	c1, err := ws.managementClient()
	if err != nil || c1 == nil {
		t.Fatalf("managementClient: client=%v err=%v", c1, err)
	}
	c2, err := ws.managementClient()
	if err != nil || c2 != c1 {
		t.Fatalf("expected cached client, got client=%v err=%v", c2, err)
	}
	if calls != 1 {
		t.Fatalf("expected client factory to be called once, got %d", calls)
	}

	if err := ws.SendJSONMessage(make(chan int)); err == nil {
		t.Fatal("expected SendJSONMessage marshal error")
	}
}

func TestWebSocketContext_ManagementClient_CachesErrorFromFactory(t *testing.T) {
	t.Parallel()

	var calls int
	ws := &WebSocketContext{
		ctx:                context.Background(),
		ConnectionID:       "c1",
		ManagementEndpoint: "https://example.com/dev",
		clientFactory: func(_ context.Context, _ string) (streamer.Client, error) {
			calls++
			return nil, errors.New("boom")
		},
	}

	if _, err := ws.managementClient(); err == nil {
		t.Fatal("expected error")
	}
	if _, err := ws.managementClient(); err == nil {
		t.Fatal("expected cached error")
	}
	if calls != 1 {
		t.Fatalf("expected factory called once, got %d", calls)
	}
}

func TestWebSocketProxyResponseFromResponse_Base64AndCookies(t *testing.T) {
	resp := apigatewayProxyResponseFromResponse(Response{
		Status:   200,
		Headers:  map[string][]string{"x": {"1", "2"}},
		Cookies:  []string{"a=b", "c=d"},
		Body:     []byte("hi"),
		IsBase64: true,
	})

	if !resp.IsBase64Encoded || resp.Body != base64.StdEncoding.EncodeToString([]byte("hi")) {
		t.Fatalf("unexpected base64 body encoding: %#v", resp)
	}
	if resp.Headers["set-cookie"] != "a=b" || len(resp.MultiValueHeaders["set-cookie"]) != 2 {
		t.Fatalf("expected cookies mapped to set-cookie, got %#v", resp)
	}
	if resp.Headers["x"] != "1" || len(resp.MultiValueHeaders["x"]) != 2 {
		t.Fatalf("expected headers to be copied into multi headers, got %#v", resp)
	}
}

func TestProxyEventMerging_PrefersMultiValue(t *testing.T) {
	headers := headersFromProxyEvent(map[string]string{"x": "1", "y": "2"}, map[string][]string{"x": {"m1"}})
	if headers["x"][0] != "m1" || headers["y"][0] != "2" {
		t.Fatalf("unexpected merged headers: %#v", headers)
	}

	query := queryFromProxyEvent(map[string]string{"x": "1", "y": "2"}, map[string][]string{"x": {"m1"}})
	if query["x"][0] != "m1" || query["y"][0] != "2" {
		t.Fatalf("unexpected merged query: %#v", query)
	}
}

func TestServeWebSocket_ErrorBranchesAndRequestIDFallback(t *testing.T) {
	t.Parallel()

	app := New(WithTier(TierP2), WithIDGenerator(fixedIDGenerator("req_fallback")))
	app.WebSocket("$default", func(*Context) (*Response, error) {
		return nil, nil
	})

	// RequestID missing -> fallback to eventContext request id.
	event := events.APIGatewayWebsocketProxyRequest{
		HTTPMethod: "GET",
		Path:       "/",
		RequestContext: events.APIGatewayWebsocketProxyRequestContext{
			RouteKey:     "$default",
			RequestID:    "",
			ConnectionID: "c1",
			DomainName:   "example.com",
			Stage:        "dev",
		},
	}

	out := app.ServeWebSocket(context.Background(), event)
	if out.StatusCode != 500 {
		t.Fatalf("expected 500 for nil handler output, got %d (%s)", out.StatusCode, out.Body)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(out.Body), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	errObj, ok := body["error"].(map[string]any)
	if !ok || errObj["request_id"] != "req_fallback" {
		t.Fatalf("expected request_id fallback in error body, got %#v", body)
	}

	// TierP0 normalizeRequest error path omits request_id.
	appP0 := New(WithTier(TierP0))
	appP0.WebSocket("$default", func(*Context) (*Response, error) { return Text(200, "ok"), nil })
	out = appP0.ServeWebSocket(context.Background(), events.APIGatewayWebsocketProxyRequest{
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
	if err := json.Unmarshal([]byte(out.Body), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if errObj, ok := body["error"].(map[string]any); ok {
		if _, hasRequestID := errObj["request_id"]; hasRequestID {
			t.Fatalf("expected p0 normalize error to omit request_id, got %#v", errObj)
		}
	}

	// Handler error branch.
	appErr := New(WithTier(TierP2))
	appErr.WebSocket("$default", func(*Context) (*Response, error) { return nil, errors.New("boom") })
	out = appErr.ServeWebSocket(context.Background(), event)
	if out.StatusCode != 500 {
		t.Fatalf("expected 500, got %d", out.StatusCode)
	}

	// Panic recovery branch.
	appPanic := New(WithTier(TierP2))
	appPanic.WebSocket("$default", func(*Context) (*Response, error) { panic("boom") })
	out = appPanic.ServeWebSocket(context.Background(), event)
	if out.StatusCode != 500 {
		t.Fatalf("expected 500, got %d", out.StatusCode)
	}
}

func TestDefaultWebSocketClientFactory_EmptyEndpointErrors(t *testing.T) {
	t.Parallel()

	if _, err := defaultWebSocketClientFactory(context.Background(), ""); err == nil {
		t.Fatal("expected error for empty endpoint")
	}
}
