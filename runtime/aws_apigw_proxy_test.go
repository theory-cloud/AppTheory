package apptheory

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func TestRequestFromAPIGatewayProxy_UsesFallbacks(t *testing.T) {
	req, err := requestFromAPIGatewayProxy(events.APIGatewayProxyRequest{
		Path:       "",
		HTTPMethod: "",
		RequestContext: events.APIGatewayProxyRequestContext{
			Path:       "/fallback",
			HTTPMethod: "GET",
		},
		Headers: map[string]string{
			"x-test": "v",
		},
		Body: "ok",
	})
	if err != nil {
		t.Fatalf("requestFromAPIGatewayProxy returned error: %v", err)
	}
	if req.Path != "/fallback" || req.Method != "GET" || string(req.Body) != "ok" {
		t.Fatalf("unexpected request: %#v", req)
	}
}

func TestIsTextEventStream(t *testing.T) {
	if !isTextEventStream(map[string][]string{"content-type": {"text/event-stream; charset=utf-8"}}) {
		t.Fatal("expected text/event-stream content type to be detected")
	}
	if isTextEventStream(map[string][]string{"content-type": {"application/json"}}) {
		t.Fatal("expected non-event-stream content type to be false")
	}
}

func TestIsAPIGatewayProxyStreamingRoute(t *testing.T) {
	stageVariables := map[string]string{
		apigatewayProxyStreamingRouteStageVariableName("GET", "/mcp"):      "1",
		apigatewayProxyStreamingRouteStageVariableName("ANY", "/{proxy+}"): "1",
	}

	if !isAPIGatewayProxyStreamingRoute(events.APIGatewayProxyRequest{
		Resource:       "/mcp",
		HTTPMethod:     "GET",
		StageVariables: stageVariables,
	}) {
		t.Fatal("expected exact streaming route to match")
	}

	if !isAPIGatewayProxyStreamingRoute(events.APIGatewayProxyRequest{
		Resource:       "/{proxy+}",
		HTTPMethod:     "POST",
		StageVariables: stageVariables,
	}) {
		t.Fatal("expected ANY streaming route to match")
	}

	if isAPIGatewayProxyStreamingRoute(events.APIGatewayProxyRequest{
		Resource:       "/mcp",
		HTTPMethod:     "POST",
		StageVariables: stageVariables,
	}) {
		t.Fatal("expected non-streaming method to be false")
	}
}

func TestAPIGatewayProxyStreamingResponseFromResponse_UsesBodyReader(t *testing.T) {
	resp := Response{
		Status: 200,
		Headers: map[string][]string{
			"content-type": {"text/event-stream; charset=utf-8"},
			"x-test":       {"a", "b"},
		},
		Cookies:    []string{"a=b"},
		Body:       []byte("head:"),
		BodyReader: bytes.NewReader([]byte("tail")),
	}
	out := apigatewayProxyStreamingResponseFromResponse(resp)

	b, err := io.ReadAll(out.Body)
	if err != nil {
		t.Fatalf("read streaming body: %v", err)
	}
	if string(b) != "head:tail" {
		t.Fatalf("unexpected streaming body: %q", string(b))
	}
	if out.Headers["x-test"] != "a" || len(out.MultiValueHeaders["x-test"]) != 2 {
		t.Fatalf("unexpected headers: %#v", out)
	}
	if len(out.Cookies) != 1 || out.Cookies[0] != "a=b" {
		t.Fatalf("unexpected cookies: %#v", out)
	}
}

func TestServeAPIGatewayProxyLambda_UsesStreamingEnvelopeForFlaggedBufferedRoute(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Get("/mcp", func(_ *Context) (*Response, error) {
		return MustJSON(401, map[string]string{"error": "unauthorized"}).
			SetHeader("www-authenticate", "Bearer realm=apptheory"), nil
	})

	out := app.serveAPIGatewayProxyLambda(context.Background(), events.APIGatewayProxyRequest{
		Resource:   "/mcp",
		Path:       "/mcp",
		HTTPMethod: "GET",
		StageVariables: map[string]string{
			apigatewayProxyStreamingRouteStageVariableName("GET", "/mcp"): "1",
		},
	})

	streaming, ok := out.(*events.APIGatewayProxyStreamingResponse)
	if !ok {
		t.Fatalf("expected streaming response, got %T", out)
	}
	if streaming.StatusCode != 401 {
		t.Fatalf("status: got %d want %d", streaming.StatusCode, 401)
	}
	if streaming.Headers["content-type"] != "application/json; charset=utf-8" {
		t.Fatalf("content-type: got %q", streaming.Headers["content-type"])
	}
	if streaming.Headers["www-authenticate"] != "Bearer realm=apptheory" {
		t.Fatalf("www-authenticate: got %q", streaming.Headers["www-authenticate"])
	}

	body, err := io.ReadAll(streaming.Body)
	if err != nil {
		t.Fatalf("read streaming body: %v", err)
	}

	var payload map[string]string
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	if payload["error"] != "unauthorized" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
}

func TestServeAPIGatewayProxyLambda_UsesBufferedEnvelopeForUnflaggedBufferedRoute(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Get("/mcp", func(_ *Context) (*Response, error) {
		return MustJSON(401, map[string]string{"error": "unauthorized"}), nil
	})

	out := app.serveAPIGatewayProxyLambda(context.Background(), events.APIGatewayProxyRequest{
		Resource:   "/mcp",
		Path:       "/mcp",
		HTTPMethod: "GET",
	})

	buffered, ok := out.(events.APIGatewayProxyResponse)
	if !ok {
		t.Fatalf("expected buffered response, got %T", out)
	}
	if buffered.StatusCode != 401 {
		t.Fatalf("status: got %d want %d", buffered.StatusCode, 401)
	}
	if buffered.Headers["content-type"] != "application/json; charset=utf-8" {
		t.Fatalf("content-type: got %q", buffered.Headers["content-type"])
	}
}

func TestServeAPIGatewayProxy(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Get("/", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })

	out := app.ServeAPIGatewayProxy(context.Background(), events.APIGatewayProxyRequest{
		Path:       "/",
		HTTPMethod: "GET",
	})
	if out.StatusCode != 200 || out.Body != "ok" {
		t.Fatalf("unexpected response: %#v", out)
	}
}
