package testkit_test

import (
	"encoding/base64"
	"testing"

	"github.com/theory-cloud/apptheory/testkit"
)

func TestAPIGatewayV2Request_Base64AndQuery(t *testing.T) {
	body := []byte("hello")
	event := testkit.APIGatewayV2Request("post", "ping", testkit.HTTPEventOptions{
		Query: map[string][]string{
			"a": {"b"},
			"c": {"d", "e"},
		},
		Headers: map[string]string{
			"x-test": "ok",
		},
		Cookies:  []string{"a=b"},
		Body:     body,
		IsBase64: true,
	})

	if event.RawPath != "/ping" {
		t.Fatalf("expected rawPath /ping, got %q", event.RawPath)
	}
	if event.RawQueryString == "" {
		t.Fatalf("expected rawQueryString to be set")
	}
	if event.IsBase64Encoded != true {
		t.Fatalf("expected isBase64Encoded")
	}
	if event.Body != base64.StdEncoding.EncodeToString(body) {
		t.Fatalf("expected base64 body, got %q", event.Body)
	}
	if event.Headers["x-test"] != "ok" {
		t.Fatalf("expected header")
	}
	if len(event.Cookies) != 1 || event.Cookies[0] != "a=b" {
		t.Fatalf("expected cookies")
	}
}

func TestLambdaFunctionURLRequest_PathNormalization(t *testing.T) {
	event := testkit.LambdaFunctionURLRequest("GET", "ping", testkit.HTTPEventOptions{})
	if event.RawPath != "/ping" {
		t.Fatalf("expected rawPath /ping, got %q", event.RawPath)
	}
	if event.RequestContext.HTTP.Method != "GET" {
		t.Fatalf("expected method GET, got %q", event.RequestContext.HTTP.Method)
	}
}

func TestALBTargetGroupRequest_ParsesQueryAndMergesCookies(t *testing.T) {
	event := testkit.ALBTargetGroupRequest("GET", "/x?a=b&c=d", testkit.HTTPEventOptions{
		Headers: map[string]string{
			"x": "single",
		},
		MultiHeaders: map[string][]string{
			"x": {"multi1", "multi2"},
		},
		Cookies: []string{"cookie_a=1", "cookie_b=2"},
		Body:    []byte("ok"),
	})

	if event.Path != "/x" {
		t.Fatalf("expected path /x, got %q", event.Path)
	}
	if event.QueryStringParameters["a"] != "b" {
		t.Fatalf("expected parsed query param a=b, got %#v", event.QueryStringParameters)
	}
	if event.MultiValueQueryStringParameters["c"][0] != "d" {
		t.Fatalf("expected parsed query param c=d, got %#v", event.MultiValueQueryStringParameters)
	}

	if event.Headers["cookie"] != "cookie_a=1" {
		t.Fatalf("expected cookie header, got %#v", event.Headers)
	}
	if event.MultiValueHeaders["cookie"][1] != "cookie_b=2" {
		t.Fatalf("expected multi cookies, got %#v", event.MultiValueHeaders)
	}

	// MultiHeaders win for multi-value, Headers win for single-value.
	if event.Headers["x"] != "single" {
		t.Fatalf("expected single header x=single, got %#v", event.Headers)
	}
	if got := event.MultiValueHeaders["x"]; len(got) != 2 || got[0] != "multi1" || got[1] != "multi2" {
		t.Fatalf("expected multi header x, got %#v", got)
	}
}
