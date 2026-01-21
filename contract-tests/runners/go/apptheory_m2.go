package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory/pkg/streamer"
	"github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/testkit"
)

func runFixtureM2(f Fixture) error {
	var fake *testkit.FakeStreamerClient
	factory := func(_ context.Context, endpoint string) (streamer.Client, error) {
		fake = testkit.NewFakeStreamerClient(endpoint)
		return fake, nil
	}

	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP0),
		apptheory.WithWebSocketClientFactory(factory),
	)

	for _, r := range f.Setup.WebSockets {
		routeKey := strings.TrimSpace(r.RouteKey)
		handler := builtInWebSocketHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown websocket handler %q", r.Handler)
		}
		app.WebSocket(routeKey, handler)
	}

	if f.Input.AWSEvent == nil {
		return errors.New("fixture missing input.aws_event")
	}

	out, err := app.HandleLambda(context.Background(), f.Input.AWSEvent.Event)
	if err != nil {
		return err
	}

	proxy, ok := out.(events.APIGatewayProxyResponse)
	if !ok {
		if ptr, ptrOK := out.(*events.APIGatewayProxyResponse); ptrOK && ptr != nil {
			proxy = *ptr
		} else {
			return fmt.Errorf("expected websocket proxy response, got %T", out)
		}
	}

	actual, err := canonicalizeAPIGatewayProxyResponse(proxy)
	if err != nil {
		return err
	}
	actual.Headers = canonicalizeHeaders(actual.Headers)

	if f.Expect.Response == nil {
		return errors.New("fixture missing expect.response")
	}
	expected := *f.Expect.Response

	expectedHeaders := canonicalizeHeaders(expected.Headers)
	if err := compareLegacyResponseMeta(expected, actual, expectedHeaders); err != nil {
		return err
	}
	if err := compareLegacyResponseBody(expected, actual.Body); err != nil {
		return err
	}

	return compareWebSocketCalls(f.Expect.WebSocketCalls, fake)
}

func canonicalizeAPIGatewayProxyResponse(in events.APIGatewayProxyResponse) (CanonicalResponse, error) {
	headers := map[string][]string{}
	for k, vs := range in.MultiValueHeaders {
		headers[k] = append([]string(nil), vs...)
	}
	for k, v := range in.Headers {
		if _, ok := headers[k]; ok {
			continue
		}
		headers[k] = []string{v}
	}
	headers = canonicalizeHeaders(headers)

	cookies := append([]string(nil), headers["set-cookie"]...)
	delete(headers, "set-cookie")

	bodyBytes := []byte(in.Body)
	if in.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(in.Body)
		if err != nil {
			return CanonicalResponse{}, fmt.Errorf("decode websocket response body base64: %w", err)
		}
		bodyBytes = decoded
	}

	return CanonicalResponse{
		Status:   in.StatusCode,
		Headers:  headers,
		Cookies:  cookies,
		Body:     bodyBytes,
		IsBase64: in.IsBase64Encoded,
	}, nil
}

func compareWebSocketCalls(expected []FixtureWebSocketCall, fake *testkit.FakeStreamerClient) error {
	if len(expected) == 0 {
		if fake == nil || len(fake.Calls) == 0 {
			return nil
		}
		return fmt.Errorf("unexpected ws_calls (%d)", len(fake.Calls))
	}
	if fake == nil {
		return errors.New("expected ws_calls but client was not created")
	}

	if len(expected) != len(fake.Calls) {
		return fmt.Errorf("ws_calls length mismatch: expected %d, got %d", len(expected), len(fake.Calls))
	}

	for i, exp := range expected {
		got := fake.Calls[i]

		if strings.TrimSpace(exp.Op) != got.Op {
			return fmt.Errorf("ws_calls[%d].op: expected %q, got %q", i, exp.Op, got.Op)
		}
		if endpoint := strings.TrimSpace(exp.Endpoint); endpoint != "" && endpoint != fake.Endpoint {
			return fmt.Errorf("ws_calls[%d].endpoint: expected %q, got %q", i, endpoint, fake.Endpoint)
		}
		if strings.TrimSpace(exp.ConnectionID) != got.ConnectionID {
			return fmt.Errorf("ws_calls[%d].connection_id: expected %q, got %q", i, exp.ConnectionID, got.ConnectionID)
		}

		if exp.Data == nil {
			if len(got.Data) != 0 {
				return fmt.Errorf("ws_calls[%d].data: expected empty, got %d bytes", i, len(got.Data))
			}
			continue
		}

		want, err := decodeFixtureBody(*exp.Data)
		if err != nil {
			return fmt.Errorf("decode expected ws_calls[%d].data: %w", i, err)
		}

		if !equalBytes(want, got.Data) {
			gotB64 := base64.StdEncoding.EncodeToString(got.Data)
			return fmt.Errorf("ws_calls[%d].data mismatch (got base64 %s)", i, gotB64)
		}
	}

	return nil
}

func builtInWebSocketHandler(name string) apptheory.WebSocketHandler {
	switch strings.TrimSpace(name) {
	case "ws_connect_ok":
		return func(ctx *apptheory.Context) (*apptheory.Response, error) {
			ws := ctx.AsWebSocket()
			if ws == nil {
				return nil, errors.New("missing websocket context")
			}
			return apptheory.MustJSON(200, map[string]any{
				"handler":             "connect",
				"route_key":           ws.RouteKey,
				"event_type":          ws.EventType,
				"connection_id":       ws.ConnectionID,
				"management_endpoint": ws.ManagementEndpoint,
				"request_id":          ctx.RequestID,
			}), nil
		}
	case "ws_disconnect_ok":
		return func(ctx *apptheory.Context) (*apptheory.Response, error) {
			ws := ctx.AsWebSocket()
			if ws == nil {
				return nil, errors.New("missing websocket context")
			}
			return apptheory.MustJSON(200, map[string]any{
				"handler":             "disconnect",
				"route_key":           ws.RouteKey,
				"event_type":          ws.EventType,
				"connection_id":       ws.ConnectionID,
				"management_endpoint": ws.ManagementEndpoint,
				"request_id":          ctx.RequestID,
			}), nil
		}
	case "ws_default_send_json_ok":
		return func(ctx *apptheory.Context) (*apptheory.Response, error) {
			ws := ctx.AsWebSocket()
			if ws == nil {
				return nil, errors.New("missing websocket context")
			}
			if err := ws.SendJSONMessage(map[string]any{"ok": true}); err != nil {
				return nil, err
			}
			return apptheory.MustJSON(200, map[string]any{
				"handler":             "default",
				"sent":                true,
				"route_key":           ws.RouteKey,
				"event_type":          ws.EventType,
				"connection_id":       ws.ConnectionID,
				"management_endpoint": ws.ManagementEndpoint,
				"request_id":          ctx.RequestID,
			}), nil
		}
	case "ws_bad_request":
		return func(ctx *apptheory.Context) (*apptheory.Response, error) {
			_ = ctx
			return nil, &apptheory.AppError{Code: "app.bad_request", Message: "bad request"}
		}
	default:
		return nil
	}
}
