package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory/pkg/streamer"
	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/testkit"
)

func TestCanonicalizeAPIGatewayProxyResponse_Base64DecodeError(t *testing.T) {
	t.Parallel()

	_, err := canonicalizeAPIGatewayProxyResponse(events.APIGatewayProxyResponse{
		StatusCode:      200,
		IsBase64Encoded: true,
		Body:            "!!!",
	})
	if err == nil || !strings.Contains(err.Error(), "decode websocket response body base64") {
		t.Fatalf("expected base64 decode error, got %v", err)
	}
}

func TestCanonicalizeAPIGatewayProxyResponse_CookiesAndHeaderMerging(t *testing.T) {
	t.Parallel()

	out, err := canonicalizeAPIGatewayProxyResponse(events.APIGatewayProxyResponse{
		StatusCode: 200,
		MultiValueHeaders: map[string][]string{
			"Set-Cookie": {"a=b; Path=/"},
			"X":          {"1", "2"},
		},
		Headers: map[string]string{
			"X": "ignored",
			"Y": "z",
		},
		Body: "ok",
	})
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	if len(out.Cookies) != 1 || out.Cookies[0] != "a=b; Path=/" {
		t.Fatalf("unexpected cookies: %#v", out.Cookies)
	}
	if out.Headers["set-cookie"] != nil {
		t.Fatalf("expected set-cookie to be removed from headers, got %#v", out.Headers)
	}
	if got := out.Headers["x"]; len(got) != 2 || got[0] != "1" || got[1] != "2" {
		t.Fatalf("unexpected merged headers: %#v", out.Headers)
	}
	if got := out.Headers["y"]; len(got) != 1 || got[0] != "z" {
		t.Fatalf("unexpected y header: %#v", out.Headers)
	}
	if string(out.Body) != "ok" {
		t.Fatalf("unexpected body: %q", string(out.Body))
	}
}

func TestCompareWebSocketCalls_CoversMismatchBranches(t *testing.T) {
	t.Parallel()

	fake := testkit.NewFakeStreamerClient("https://example.com")
	if err := fake.PostToConnection(context.Background(), "c1", []byte("x")); err != nil {
		t.Fatalf("PostToConnection: %v", err)
	}

	if err := compareWebSocketCalls(nil, fake); err == nil || !strings.Contains(err.Error(), "unexpected ws_calls") {
		t.Fatalf("expected unexpected ws_calls error, got %v", err)
	}
	if err := compareWebSocketCalls([]FixtureWebSocketCall{{Op: "post_to_connection", ConnectionID: "c1"}}, nil); err == nil {
		t.Fatal("expected missing client error")
	}

	fake = testkit.NewFakeStreamerClient("https://example.com")
	fake.Calls = []testkit.StreamerCall{
		{Op: "post_to_connection", ConnectionID: "c1", Data: []byte("a")},
		{Op: "post_to_connection", ConnectionID: "c2", Data: []byte("b")},
	}
	if err := compareWebSocketCalls([]FixtureWebSocketCall{{Op: "post_to_connection", ConnectionID: "c1"}}, fake); err == nil || !strings.Contains(err.Error(), "ws_calls length mismatch") {
		t.Fatalf("expected length mismatch error, got %v", err)
	}

	fake.Calls = []testkit.StreamerCall{{Op: "post_to_connection", ConnectionID: "c1", Data: []byte("a")}}
	if err := compareWebSocketCalls([]FixtureWebSocketCall{{Op: "get_connection", ConnectionID: "c1"}}, fake); err == nil || !strings.Contains(err.Error(), "ws_calls[0].op") {
		t.Fatalf("expected op mismatch error, got %v", err)
	}

	if err := compareWebSocketCalls([]FixtureWebSocketCall{{Op: "post_to_connection", ConnectionID: "c1", Endpoint: "https://other"}}, fake); err == nil || !strings.Contains(err.Error(), "endpoint") {
		t.Fatalf("expected endpoint mismatch error, got %v", err)
	}

	if err := compareWebSocketCalls([]FixtureWebSocketCall{{Op: "post_to_connection", ConnectionID: "nope"}}, fake); err == nil || !strings.Contains(err.Error(), "connection_id") {
		t.Fatalf("expected connection_id mismatch error, got %v", err)
	}

	// data=nil but got non-empty.
	if err := compareWebSocketCalls([]FixtureWebSocketCall{{Op: "post_to_connection", ConnectionID: "c1", Data: nil}}, fake); err == nil || !strings.Contains(err.Error(), ".data: expected empty") {
		t.Fatalf("expected data empty mismatch error, got %v", err)
	}

	// expected data decode error.
	if err := compareWebSocketCalls([]FixtureWebSocketCall{{
		Op:           "post_to_connection",
		ConnectionID: "c1",
		Data:         &FixtureBody{Encoding: "base64", Value: "!!!"},
	}}, fake); err == nil || !strings.Contains(err.Error(), "decode expected ws_calls") {
		t.Fatalf("expected decode error, got %v", err)
	}

	// expected data mismatch.
	want := base64.StdEncoding.EncodeToString([]byte("nope"))
	if err := compareWebSocketCalls([]FixtureWebSocketCall{{
		Op:           "post_to_connection",
		ConnectionID: "c1",
		Data:         &FixtureBody{Encoding: "base64", Value: want},
	}}, fake); err == nil || !strings.Contains(err.Error(), "data mismatch") {
		t.Fatalf("expected data mismatch, got %v", err)
	}

	// success.
	want = base64.StdEncoding.EncodeToString([]byte("a"))
	fake.Calls = []testkit.StreamerCall{{Op: "post_to_connection", ConnectionID: "c1", Data: []byte("a")}}
	if err := compareWebSocketCalls([]FixtureWebSocketCall{{
		Op:           "post_to_connection",
		ConnectionID: "c1",
		Endpoint:     "https://example.com",
		Data:         &FixtureBody{Encoding: "base64", Value: want},
	}}, fake); err != nil {
		t.Fatalf("expected calls to match, got %v", err)
	}
}

func TestBuiltInWebSocketHandler_NilContextAndSendError(t *testing.T) {
	t.Parallel()

	if builtInWebSocketHandler("nope") != nil {
		t.Fatal("expected unknown handler to be nil")
	}

	connect := builtInWebSocketHandler("ws_connect_ok")
	if connect == nil {
		t.Fatal("expected ws_connect_ok handler")
	}
	if _, err := connect(nil); err == nil || !strings.Contains(err.Error(), "missing websocket context") {
		t.Fatalf("expected missing websocket context error, got %v", err)
	}

	appErr := builtInWebSocketHandler("ws_bad_request")
	if appErr == nil {
		t.Fatal("expected ws_bad_request handler")
	}
	if _, err := appErr(&apptheory.Context{}); err == nil {
		t.Fatal("expected app error")
	}

	// Exercise SendJSONMessage error propagation.
	var fake *testkit.FakeStreamerClient
	factory := func(_ context.Context, endpoint string) (streamer.Client, error) {
		fake = testkit.NewFakeStreamerClient(endpoint)
		fake.PostErr = errors.New("post failed")
		return fake, nil
	}

	wsApp := apptheory.New(apptheory.WithTier(apptheory.TierP0), apptheory.WithWebSocketClientFactory(factory))
	wsApp.WebSocket("$default", builtInWebSocketHandler("ws_default_send_json_ok"))

	event := testkit.WebSocketEvent(testkit.WebSocketEventOptions{Body: "hi"})
	out := wsApp.ServeWebSocket(context.Background(), event)
	if out.StatusCode == 0 {
		t.Fatal("expected a websocket proxy response")
	}
	if fake == nil {
		t.Fatal("expected streamer client to be created")
	}
}

func TestRunFixtureM2_ValidationErrors(t *testing.T) {
	t.Parallel()

	if err := runFixtureM2(Fixture{Setup: FixtureSetup{WebSockets: []FixtureWebSocketRoute{{RouteKey: "$default", Handler: "nope"}}}}); err == nil {
		t.Fatal("expected unknown websocket handler error")
	}

	if err := runFixtureM2(Fixture{Setup: FixtureSetup{WebSockets: []FixtureWebSocketRoute{{RouteKey: "$default", Handler: "ws_connect_ok"}}}}); err == nil || !strings.Contains(err.Error(), "fixture missing input.aws_event") {
		t.Fatalf("expected missing aws_event error, got %v", err)
	}

	wsBytes, err := json.Marshal(testkit.WebSocketEvent(testkit.WebSocketEventOptions{}))
	if err != nil {
		t.Fatalf("marshal ws: %v", err)
	}
	if err := runFixtureM2(Fixture{
		Setup: FixtureSetup{
			WebSockets: []FixtureWebSocketRoute{{RouteKey: "$default", Handler: "ws_connect_ok"}},
		},
		Input: FixtureInput{
			AWSEvent: &FixtureAWSEvent{Event: wsBytes},
		},
		Expect: FixtureExpect{Response: nil},
	}); err == nil || !strings.Contains(err.Error(), "fixture missing expect.response") {
		t.Fatalf("expected missing expect.response error, got %v", err)
	}
}
