package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStagePrefixFor(t *testing.T) {
	cases := []struct {
		name    string
		api     APISpec
		path    string
		prefix  string
		rest    string
		matched bool
	}{
		{"rest exact stage", APISpec{Class: APIRESTV1, Stage: "prod"}, "/prod", "/prod", "/", true},
		{"rest route", APISpec{Class: APIRESTV1, Stage: "prod"}, "/prod/hello", "/prod", "/hello", true},
		{"http route", APISpec{Class: APIHTTPV2, Stage: "dev"}, "/dev/hello/x", "/dev", "/hello/x", true},
		{"default stage", APISpec{Class: APIHTTPV2, Stage: LocalStageName}, "/hello", "", "", false},
		{"other prefix", APISpec{Class: APIRESTV1, Stage: "prod"}, "/production", "", "", false},
		{"no stage", APISpec{Class: APIRESTV1}, "/prod/hello", "", "", false},
		{"function url", APISpec{Class: APIFunctionURL, Stage: "prod"}, "/prod/hello", "", "", false},
	}
	for _, testCase := range cases {
		prefix, rest, ok := stagePrefixFor(testCase.api, testCase.path)
		if ok != testCase.matched || prefix != testCase.prefix || rest != testCase.rest {
			t.Fatalf("%s: (%q,%q,%v), want (%q,%q,%v)",
				testCase.name, prefix, rest, ok, testCase.prefix, testCase.rest, testCase.matched)
		}
	}
}

func TestTransportServesRootAndNamedStageWithTheDocumentedEventShape(t *testing.T) {
	invoker := &recordingInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	api := APISpec{Class: APIRESTV1, LogicalID: "Rest", Stage: "prod", Routes: []Route{{
		Class: APIRESTV1, Method: "GET", Path: "/hello", Function: "Fn",
	}}}
	transport := NewTransport(api, map[string]Invoker{"Fn": invoker}, nil, nil)
	server := httptest.NewServer(transport)
	defer server.Close()

	for _, requestPath := range []string{"/hello", "/prod/hello"} {
		invoker.payload = nil
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+requestPath, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close() //nolint:errcheck // test cleanup
		var event map[string]any
		if err := json.Unmarshal(invoker.payload, &event); err != nil {
			t.Fatalf("%s: event is not JSON: %v", requestPath, err)
		}
		context, contextOK := event["requestContext"].(map[string]any)
		if !contextOK {
			t.Fatalf("%s: event has no requestContext", requestPath)
		}
		if event["path"] != "/hello" || event["resource"] != "/hello" {
			t.Fatalf("%s: path/resource = %v/%v, want /hello", requestPath, event["path"], event["resource"])
		}
		if context["stage"] != "prod" {
			t.Fatalf("%s: stage = %v", requestPath, context["stage"])
		}
		wantContextPath := "/hello"
		if requestPath == "/prod/hello" {
			wantContextPath = "/prod/hello"
		}
		if context["path"] != wantContextPath {
			t.Fatalf("%s: requestContext.path = %v, want %v", requestPath, context["path"], wantContextPath)
		}
	}
}

func TestTransportServesHTTPAPINamedStageRawPath(t *testing.T) {
	invoker := &recordingInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	api := APISpec{Class: APIHTTPV2, LogicalID: "Http", Stage: "dev", Routes: []Route{{
		Class: APIHTTPV2, Method: "GET", Path: catchAllPath, Function: "Fn", RouteKey: "$default",
	}}}
	transport := NewTransport(api, map[string]Invoker{"Fn": invoker}, nil, nil)
	server := httptest.NewServer(transport)
	defer server.Close()

	for _, requestPath := range []string{"/hello", "/dev/hello"} {
		invoker.payload = nil
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+requestPath, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close() //nolint:errcheck // test cleanup
		var event map[string]any
		if err := json.Unmarshal(invoker.payload, &event); err != nil {
			t.Fatalf("%s: event is not JSON: %v", requestPath, err)
		}
		context, contextOK := event["requestContext"].(map[string]any)
		if !contextOK {
			t.Fatalf("%s: event has no requestContext", requestPath)
		}
		httpContext, httpOK := context["http"].(map[string]any)
		if !httpOK {
			t.Fatalf("%s: requestContext has no http object", requestPath)
		}
		if context["stage"] != "dev" {
			t.Fatalf("%s: stage = %v", requestPath, context["stage"])
		}
		if event["rawPath"] != requestPath || httpContext["path"] != requestPath {
			t.Fatalf("%s: rawPath/http.path = %v/%v", requestPath, event["rawPath"], httpContext["path"])
		}
	}
}

func TestTransportDefaultStageKeepsTheRootByteForByte(t *testing.T) {
	invoker := &recordingInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	api := APISpec{Class: APIHTTPV2, LogicalID: "Http", Stage: LocalStageName, Routes: []Route{{
		Class: APIHTTPV2, Method: "GET", Path: "/hello", Function: "Fn",
	}}}
	transport := NewTransport(api, map[string]Invoker{"Fn": invoker}, nil, nil)
	server := httptest.NewServer(transport)
	defer server.Close()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/hello", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close() //nolint:errcheck // test cleanup
	var event map[string]any
	if err := json.Unmarshal(invoker.payload, &event); err != nil {
		t.Fatal(err)
	}
	context, contextOK := event["requestContext"].(map[string]any)
	if !contextOK {
		t.Fatal("default stage event has no requestContext")
	}
	if context["stage"] != LocalStageName || event["rawPath"] != "/hello" {
		t.Fatalf("default stage event = %v", event)
	}
}
