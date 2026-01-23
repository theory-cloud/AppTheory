package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func TestBuiltInAppTheoryHandler_TrimsAndRejectsEmpty(t *testing.T) {
	if got := builtInAppTheoryHandler("  "); got != nil {
		t.Fatal("expected empty handler name to return nil")
	}
	if got := builtInAppTheoryHandler("static_pong"); got == nil {
		t.Fatal("expected static_pong handler to exist")
	}
}

func TestCompareFixtureResponse_FailsWhenExpectedResponseMissing(t *testing.T) {
	err := compareFixtureResponse(Fixture{Expect: FixtureExpect{Response: nil}}, apptheory.Response{}, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "fixture missing expect.response") {
		t.Fatalf("expected missing expect.response error, got %v", err)
	}
}

func TestCompareFixtureResponseMeta_ReportsMismatches(t *testing.T) {
	exp := FixtureResponse{Status: 200, IsBase64: false, Cookies: []string{"a=b"}, Headers: map[string][]string{"x": {"1"}}}
	act := apptheory.Response{Status: 201, IsBase64: false, Cookies: []string{"a=b"}, Headers: map[string][]string{"x": {"1"}}}

	expH := canonicalizeHeaders(exp.Headers)
	actH := canonicalizeHeaders(act.Headers)
	if err := compareFixtureResponseMeta(exp, act, expH, actH); err == nil || !strings.Contains(err.Error(), "status:") {
		t.Fatalf("expected status mismatch error, got %v", err)
	}

	act.Status = 200
	act.IsBase64 = true
	actH = canonicalizeHeaders(act.Headers)
	if err := compareFixtureResponseMeta(exp, act, expH, actH); err == nil || !strings.Contains(err.Error(), "is_base64:") {
		t.Fatalf("expected is_base64 mismatch error, got %v", err)
	}

	act.IsBase64 = false
	act.Cookies = []string{"c=d"}
	if err := compareFixtureResponseMeta(exp, act, expH, actH); err == nil || !strings.Contains(err.Error(), "cookies mismatch") {
		t.Fatalf("expected cookies mismatch error, got %v", err)
	}

	act.Cookies = []string{"a=b"}
	act.Headers = map[string][]string{"x": {"2"}}
	actH = canonicalizeHeaders(act.Headers)
	if err := compareFixtureResponseMeta(exp, act, expH, actH); err == nil || !strings.Contains(err.Error(), "headers mismatch") {
		t.Fatalf("expected headers mismatch error, got %v", err)
	}
}

func TestCompareFixtureResponseBody_JSONAndRawBranches(t *testing.T) {
	// expected body_json parse error.
	err := compareFixtureResponseBody(FixtureResponse{BodyJSON: []byte(`{`)}, apptheory.Response{Body: []byte(`{}`)})
	if err == nil || !strings.Contains(err.Error(), "parse expected body_json") {
		t.Fatalf("expected parse expected body_json error, got %v", err)
	}

	// actual body json parse error.
	err = compareFixtureResponseBody(FixtureResponse{BodyJSON: []byte(`{"ok":true}`)}, apptheory.Response{Body: []byte(`{`)})
	if err == nil || !strings.Contains(err.Error(), "parse actual response body") {
		t.Fatalf("expected parse actual response body error, got %v", err)
	}

	// json mismatch.
	err = compareFixtureResponseBody(FixtureResponse{BodyJSON: []byte(`{"ok":true}`)}, apptheory.Response{Body: []byte(`{"ok":false}`)})
	if err == nil || !strings.Contains(err.Error(), "body_json mismatch") {
		t.Fatalf("expected body_json mismatch error, got %v", err)
	}

	// json match.
	err = compareFixtureResponseBody(FixtureResponse{BodyJSON: []byte(`{"ok":true}`)}, apptheory.Response{Body: []byte(`{"ok":true}`)})
	if err != nil {
		t.Fatalf("expected json match, got %v", err)
	}

	// raw body: decode expected body error.
	err = compareFixtureResponseBody(FixtureResponse{Body: &FixtureBody{Encoding: "base64", Value: "!!!"}}, apptheory.Response{Body: nil})
	if err == nil || !strings.Contains(err.Error(), "decode expected body") {
		t.Fatalf("expected decode expected body error, got %v", err)
	}

	// raw body mismatch.
	encoded := base64.StdEncoding.EncodeToString([]byte("a"))
	err = compareFixtureResponseBody(FixtureResponse{Body: &FixtureBody{Encoding: "base64", Value: encoded}}, apptheory.Response{Body: []byte("b")})
	if err == nil || !strings.Contains(err.Error(), "body mismatch") {
		t.Fatalf("expected body mismatch error, got %v", err)
	}

	// raw body match.
	err = compareFixtureResponseBody(FixtureResponse{Body: &FixtureBody{Encoding: "base64", Value: encoded}}, apptheory.Response{Body: []byte("a")})
	if err != nil {
		t.Fatalf("expected body match, got %v", err)
	}
}

func TestCompareFixtureSideEffects_ReportsMismatches(t *testing.T) {
	err := compareFixtureSideEffects(FixtureExpect{Logs: []FixtureLogRecord{{Level: "info"}}}, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "logs mismatch") {
		t.Fatalf("expected logs mismatch error, got %v", err)
	}

	err = compareFixtureSideEffects(FixtureExpect{Metrics: []FixtureMetricRecord{{Name: "m"}}}, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "metrics mismatch") {
		t.Fatalf("expected metrics mismatch error, got %v", err)
	}

	err = compareFixtureSideEffects(FixtureExpect{Spans: []FixtureSpanRecord{{Name: "s"}}}, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "spans mismatch") {
		t.Fatalf("expected spans mismatch error, got %v", err)
	}
}

func TestResponseFromAWSAdapters_Base64AndHeaders(t *testing.T) {
	// API Gateway v2: base64 decode success + multivalue headers.
	b64Body := base64.StdEncoding.EncodeToString([]byte("hi"))
	out, err := responseFromAPIGatewayV2(events.APIGatewayV2HTTPResponse{
		StatusCode:        200,
		IsBase64Encoded:   true,
		Body:              b64Body,
		MultiValueHeaders: map[string][]string{"x": {"1", "2"}},
		Cookies:           []string{"a=b"},
	})
	if err != nil {
		t.Fatalf("responseFromAPIGatewayV2: %v", err)
	}
	if string(out.Body) != "hi" || out.Headers["x"][0] != "1" || out.Cookies[0] != "a=b" {
		t.Fatalf("unexpected adapted response: %#v", out)
	}

	// API Gateway v2: base64 decode error.
	_, decodeErr := responseFromAPIGatewayV2(events.APIGatewayV2HTTPResponse{IsBase64Encoded: true, Body: "!!!"})
	if decodeErr == nil {
		t.Fatal("expected base64 decode error")
	}

	// Lambda Function URL: base64 decode error.
	_, decodeErr = responseFromLambdaFunctionURL(events.LambdaFunctionURLResponse{IsBase64Encoded: true, Body: "!!!"})
	if decodeErr == nil {
		t.Fatal("expected base64 decode error")
	}

	// ALB: set-cookie moved to cookies and canonicalized.
	alb, err := responseFromALBTargetGroup(events.ALBTargetGroupResponse{
		StatusCode: 200,
		MultiValueHeaders: map[string][]string{
			"Set-Cookie": {"a=b", "c=d"},
			"X-Test":     {"1"},
		},
		Body: "ok",
	})
	if err != nil {
		t.Fatalf("responseFromALBTargetGroup: %v", err)
	}
	if len(alb.Cookies) != 2 || alb.Headers["set-cookie"] != nil || alb.Headers["x-test"][0] != "1" {
		t.Fatalf("unexpected alb adaptation: %#v", alb)
	}

	// ALB: base64 decode error.
	_, decodeErr = responseFromALBTargetGroup(events.ALBTargetGroupResponse{IsBase64Encoded: true, Body: "!!!"})
	if decodeErr == nil {
		t.Fatal("expected base64 decode error")
	}
}

func TestPrintFailureP0_UnknownHandler_PrintsUnavailable(t *testing.T) {
	out := captureStderr(t, func() {
		printFailureP0(Fixture{
			ID:   "fixture_1",
			Name: "unknown handler",
			Tier: "p0",
			Setup: FixtureSetup{
				Routes: []FixtureRoute{
					{Method: "GET", Path: "/ping", Handler: "nope"},
				},
			},
			Input: FixtureInput{
				Request: &FixtureRequest{
					Method:  "GET",
					Path:    "/ping",
					Headers: map[string][]string{},
					Query:   map[string][]string{},
					Body:    FixtureBody{Encoding: "utf8", Value: ""},
				},
			},
			Expect: FixtureExpect{
				Response: &FixtureResponse{
					Status: 200,
					Body:   &FixtureBody{Encoding: "utf8", Value: "pong"},
				},
			},
		})
	})

	if !strings.Contains(out, "got: <unavailable>") {
		t.Fatalf("expected got unavailable output, got:\n%s", out)
	}
	if !strings.Contains(out, "expected:") {
		t.Fatalf("expected expected output, got:\n%s", out)
	}
}

func TestResponseFromAWSAdapters_SerializeJSONOutputFromFixtureApp(t *testing.T) {
	// Regression coverage for response conversion + compareFixtureResponseBody JSON path.
	resp := events.APIGatewayV2HTTPResponse{
		StatusCode:      200,
		IsBase64Encoded: false,
		Headers:         map[string]string{"content-type": "application/json; charset=utf-8"},
		Body:            `{"ok":true}`,
	}
	out, err := responseFromAPIGatewayV2(resp)
	if err != nil {
		t.Fatalf("responseFromAPIGatewayV2: %v", err)
	}
	if err := compareFixtureResponseBody(FixtureResponse{BodyJSON: []byte(`{"ok":true}`)}, out); err != nil {
		t.Fatalf("expected compareFixtureResponseBody to succeed: %v", err)
	}

	var parsed any
	if err := json.Unmarshal(out.Body, &parsed); err != nil {
		t.Fatalf("expected adapted response body to be json, got error: %v", err)
	}
}
