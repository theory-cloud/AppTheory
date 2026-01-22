package apptheory

import (
	"encoding/base64"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func TestParseEventRawQuery(t *testing.T) {
	out, err := parseEventRawQuery("a=1&a=2&b=x", nil)
	if err != nil {
		t.Fatalf("parseEventRawQuery returned error: %v", err)
	}
	if len(out["a"]) != 2 || out["a"][0] != "1" || out["a"][1] != "2" {
		t.Fatalf("unexpected parsed query: %v", out)
	}
	if out["b"][0] != "x" {
		t.Fatalf("unexpected parsed query: %v", out)
	}

	_, err = parseEventRawQuery("%zz", nil)
	if err == nil {
		t.Fatal("expected error for invalid raw query")
	}
}

func TestHeadersFromSingle_IgnoreCookieHeader(t *testing.T) {
	out := headersFromSingle(map[string]string{
		"cookie": "a=b",
		"x-test": "v",
	}, true)
	if _, ok := out["cookie"]; ok {
		t.Fatal("expected cookie header to be ignored")
	}
	if out["x-test"][0] != "v" {
		t.Fatalf("unexpected headers: %v", out)
	}
}

func TestRequestFromHTTPEvent_IncludesCookiesAndRawQuery(t *testing.T) {
	req, err := requestFromHTTPEvent(
		"?a=1&a=2",
		map[string]string{"ignored": "x"},
		map[string]string{"cookie": "ignored", "x-test": "v"},
		[]string{"a=b", "c=d"},
		"/path",
		"GET",
		"",
		"body",
		false,
	)
	if err != nil {
		t.Fatalf("requestFromHTTPEvent returned error: %v", err)
	}
	if req.Path != "/path" || req.Method != "GET" {
		t.Fatalf("unexpected request: %#v", req)
	}
	if len(req.Query["a"]) != 2 {
		t.Fatalf("unexpected query: %v", req.Query)
	}
	if len(req.Headers["cookie"]) != 2 || req.Headers["cookie"][0] != "a=b" {
		t.Fatalf("unexpected cookie headers: %v", req.Headers["cookie"])
	}
}

func TestAPIGatewayV2ResponseFromResponse_Base64(t *testing.T) {
	resp := Response{
		Status:   200,
		Headers:  map[string][]string{"x-test": {"a", "b"}},
		Cookies:  []string{"a=b"},
		Body:     []byte{0x01, 0x02},
		IsBase64: true,
	}
	out := apigatewayV2ResponseFromResponse(resp)
	if out.StatusCode != 200 || !out.IsBase64Encoded {
		t.Fatalf("unexpected apigw v2 response: %#v", out)
	}
	if out.Headers["x-test"] != "a" || len(out.MultiValueHeaders["x-test"]) != 2 {
		t.Fatalf("unexpected headers: %#v", out)
	}
	if out.Body != base64.StdEncoding.EncodeToString(resp.Body) {
		t.Fatalf("unexpected body: %q", out.Body)
	}
}

func TestLambdaFunctionURLResponseFromResponse_JoinsMultiHeaders(t *testing.T) {
	resp := Response{
		Status:  201,
		Headers: map[string][]string{"x-test": {"a", "b"}},
		Body:    []byte("ok"),
	}
	out := lambdaFunctionURLResponseFromResponse(resp)
	if out.StatusCode != 201 {
		t.Fatalf("unexpected status: %d", out.StatusCode)
	}
	if out.Headers["x-test"] != "a,b" {
		t.Fatalf("unexpected joined header: %q", out.Headers["x-test"])
	}
}

func TestRequestFromAPIGatewayV2AndLambdaURL(t *testing.T) {
	v2 := events.APIGatewayV2HTTPRequest{
		RawPath:        "/v2",
		RawQueryString: "a=1",
		Headers:        map[string]string{"x-test": "v"},
		Cookies:        []string{"a=b"},
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method: "GET",
				Path:   "/ignored",
			},
		},
	}
	req, err := requestFromAPIGatewayV2(v2)
	if err != nil {
		t.Fatalf("requestFromAPIGatewayV2 returned error: %v", err)
	}
	if req.Path != "/v2" || req.Method != "GET" {
		t.Fatalf("unexpected request: %#v", req)
	}

	url := events.LambdaFunctionURLRequest{
		RawPath:        "/url",
		RawQueryString: "",
		QueryStringParameters: map[string]string{
			"a": "1",
		},
		Headers: map[string]string{"x-test": "v"},
		RequestContext: events.LambdaFunctionURLRequestContext{
			HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{
				Method: "POST",
				Path:   "/ignored",
			},
		},
	}
	req, err = requestFromLambdaFunctionURL(url)
	if err != nil {
		t.Fatalf("requestFromLambdaFunctionURL returned error: %v", err)
	}
	if req.Path != "/url" || req.Method != "POST" || req.Query["a"][0] != "1" {
		t.Fatalf("unexpected request: %#v", req)
	}
}
