package apptheory

import (
	"bytes"
	"context"
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
