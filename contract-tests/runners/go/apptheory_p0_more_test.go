package main

import (
	"strings"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func TestServeFixtureP0_MissingRequestAndDecodeErrors(t *testing.T) {
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))

	_, err := serveFixtureP0(app, Fixture{
		Tier:  "p0",
		Input: FixtureInput{Request: nil, AWSEvent: nil},
	})
	if err == nil || !strings.Contains(err.Error(), "fixture missing input.request") {
		t.Fatalf("expected missing request error, got %v", err)
	}

	_, err = serveFixtureP0(app, Fixture{
		Tier: "p0",
		Input: FixtureInput{
			Request: &FixtureRequest{
				Method:  "GET",
				Path:    "/",
				Headers: map[string][]string{},
				Query:   map[string][]string{},
				Body:    FixtureBody{Encoding: "base64", Value: "!!!"},
			},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "decode request body") {
		t.Fatalf("expected decode request body error, got %v", err)
	}
}

func TestServeFixtureP0AWS_UnknownSourceAndParseErrors(t *testing.T) {
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))

	_, err := serveFixtureP0AWS(app, &FixtureAWSEvent{Source: "nope", Event: []byte(`{}`)})
	if err == nil || !strings.Contains(err.Error(), "unknown aws_event source") {
		t.Fatalf("expected unknown source error, got %v", err)
	}

	_, err = serveFixtureP0AWS(app, &FixtureAWSEvent{Source: "apigw_v2", Event: []byte(`{`)})
	if err == nil || !strings.Contains(err.Error(), "parse apigw_v2 event") {
		t.Fatalf("expected parse apigw_v2 event error, got %v", err)
	}

	_, err = serveFixtureP0AWS(app, &FixtureAWSEvent{Source: "lambda_function_url", Event: []byte(`{`)})
	if err == nil || !strings.Contains(err.Error(), "parse lambda_function_url event") {
		t.Fatalf("expected parse lambda_function_url event error, got %v", err)
	}

	_, err = serveFixtureP0AWS(app, &FixtureAWSEvent{Source: "alb", Event: []byte(`{`)})
	if err == nil || !strings.Contains(err.Error(), "parse alb event") {
		t.Fatalf("expected parse alb event error, got %v", err)
	}
}

func TestPrintFailureP0_PrintsUnavailableWhenServeFails(t *testing.T) {
	out := captureStderr(t, func() {
		printFailureP0(Fixture{
			ID:   "fixture_1",
			Name: "serve failure",
			Tier: "p0",
			Setup: FixtureSetup{
				Routes: []FixtureRoute{
					{Method: "GET", Path: "/ping", Handler: "static_pong"},
				},
			},
			Input: FixtureInput{
				Request: nil,
			},
			Expect: FixtureExpect{
				Response: &FixtureResponse{Status: 200},
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

func TestPrintFailureP0_BodyJSONFormattingBranches(t *testing.T) {
	// BodyJSON present, but actual response isn't JSON => prints base64 body.
	out := captureStderr(t, func() {
		printFailureP0(Fixture{
			ID:   "fixture_2",
			Name: "non-json actual",
			Tier: "p0",
			Setup: FixtureSetup{
				Routes: []FixtureRoute{
					{Method: "GET", Path: "/ping", Handler: "static_pong"},
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
					Status:   200,
					BodyJSON: []byte(`{"ok":true}`),
				},
			},
		})
	})
	if !strings.Contains(out, `"body":`) || !strings.Contains(out, `"encoding": "base64"`) {
		t.Fatalf("expected base64 body representation, got:\n%s", out)
	}

	// BodyJSON present, and actual response is JSON => prints body_json.
	out = captureStderr(t, func() {
		printFailureP0(Fixture{
			ID:   "fixture_3",
			Name: "json actual",
			Tier: "p0",
			Setup: FixtureSetup{
				Routes: []FixtureRoute{
					{Method: "GET", Path: "/echo", Handler: "echo_request"},
				},
			},
			Input: FixtureInput{
				Request: &FixtureRequest{
					Method:  "GET",
					Path:    "/echo",
					Headers: map[string][]string{},
					Query:   map[string][]string{},
					Body:    FixtureBody{Encoding: "utf8", Value: ""},
				},
			},
			Expect: FixtureExpect{
				Response: &FixtureResponse{
					Status:   200,
					BodyJSON: []byte(`{}`),
				},
			},
		})
	})
	if !strings.Contains(out, `"body_json":`) {
		t.Fatalf("expected body_json representation, got:\n%s", out)
	}
}
