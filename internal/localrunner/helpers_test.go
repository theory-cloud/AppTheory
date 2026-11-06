package localrunner

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHandlerErrorMessageAndTruncation(t *testing.T) {
	handlerErr := &HandlerError{Message: "boom"}
	if got := handlerErr.Error(); !strings.Contains(got, "boom") || !strings.Contains(got, "Unhandled") {
		t.Fatalf("unexpected error text: %q", got)
	}
	raw := &HandlerError{Type: "Runtime.Error", Raw: "raw text"}
	if got := raw.Error(); !strings.Contains(got, "Runtime.Error") || !strings.Contains(got, "raw text") {
		t.Fatalf("unexpected raw error text: %q", got)
	}
	if truncateForMessage("short") != "short" {
		t.Fatal("short values must pass through")
	}
	if got := truncateForMessage(strings.Repeat("x", 600)); len(got) != 515 {
		t.Fatalf("unexpected truncation length %d", len(got))
	}
}

func TestEventHelpers(t *testing.T) {
	if body, encoded := eventBody(nil); body != "" || encoded {
		t.Fatal("an empty body must stay empty")
	}
	header := http.Header{"X-Empty": {}, "X-One": {"a"}}
	if single := singleHeaders(header); len(single) != 1 || single["x-one"] != "a" {
		t.Fatalf("unexpected single headers: %+v", single)
	}
	if multi := multiValueHeaderFlat(header); len(multi) != 1 {
		t.Fatalf("unexpected flat headers: %+v", multi)
	}
	if cookies := requestCookies(http.Header{"Cookie": {}}); len(cookies) != 0 {
		t.Fatalf("unexpected cookies: %+v", cookies)
	}
	if query := singleQuery("%zz"); query != nil {
		t.Fatalf("an invalid query must be ignored: %+v", query)
	}
	if single, multi := queryValues("%zz"); single != nil || multi != nil {
		t.Fatalf("invalid query values must be ignored: %+v %+v", single, multi)
	}
	for input, expected := range map[string]string{
		"":              "127.0.0.1",
		"127.0.0.1:123": "127.0.0.1",
		"10.0.0.5":      "10.0.0.5",
	} {
		if actual := sourceIP(input); actual != expected {
			t.Fatalf("sourceIP(%q) = %q, want %q", input, actual, expected)
		}
	}
	if len(NewRequestID()) != 32 {
		t.Fatal("unexpected request id")
	}
	if eventTime(time.Unix(1700000000, 0)) != "14/Nov/2023:22:13:20 +0000" {
		t.Fatalf("unexpected event time: %s", eventTime(time.Unix(1700000000, 0)))
	}
	if localPhysicalID("api", "A") == localPhysicalID("api", "B") {
		t.Fatal("physical ids must differ")
	}
}

func TestDecodeResponseFramedBase64(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte("streamed bytes"))
	frame := append([]byte(`{"statusCode":200,"isBase64Encoded":true}`), streamingFrameSeparator...)
	frame = append(frame, []byte(payload)...)
	response, err := DecodeResponse(frame)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(response.Body) != "streamed bytes" || !response.Streamed {
		t.Fatalf("unexpected framed base64 response: %+v", response)
	}
	bad := append([]byte(`{"statusCode":200,"isBase64Encoded":true}`), streamingFrameSeparator...)
	bad = append(bad, []byte("!!!")...)
	if _, err := DecodeResponse(bad); err == nil {
		t.Fatal("invalid framed base64 must fail")
	}
}

func TestRouteTableAndEndpointSummary(t *testing.T) {
	spec := &Spec{
		APIs: []APISpec{
			{Class: APIHTTPV2, LogicalID: "Api", Stage: "$default", Routes: []Route{
				{Method: "ANY", Path: "/", Function: "Fn"},
				{Method: "GET", Path: "/sse", Function: "Fn", Streaming: true},
			}},
			{Class: APIRESTV1, LogicalID: "Rest", Stage: "prod", Routes: []Route{{Method: "GET", Path: "/x", Function: "Fn"}}},
		},
		FunctionURLs: []FunctionURLSpec{{LogicalID: "Url", Function: "Fn", Streaming: true}},
	}
	lines := strings.Join(RouteTable(spec), "\n")
	for _, fragment := range []string{"api httpv2", "api restv1", "api fnurl", "buffered under --rie"} {
		if !strings.Contains(lines, fragment) {
			t.Fatalf("route table missing %q:\n%s", fragment, lines)
		}
	}
	if got := SummarizeEndpoints([]Endpoint{{Service: "DynamoDB", URL: "http://a:1"}}); got != "dynamodb=http://a:1" {
		t.Fatalf("unexpected endpoint summary: %q", got)
	}
}

func TestServerHeaderHelpers(t *testing.T) {
	for _, name := range []string{"Content-Length", "Transfer-Encoding", "Connection"} {
		if !isHopByHopHeader(name) {
			t.Fatalf("%s must be treated as hop-by-hop", name)
		}
	}
	if isHopByHopHeader("Content-Type") {
		t.Fatal("content-type must be forwarded")
	}
	if streamedNote(false) != "" || !strings.Contains(streamedNote(true), "delivered as one body") {
		t.Fatal("unexpected streamed note")
	}
}

func TestTransportRequestTooLargeAndMissingFunction(t *testing.T) {
	api := APISpec{Class: APIHTTPV2, LogicalID: "Api", Routes: []Route{{Method: "POST", Path: "/", Function: "Fn"}}}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{}, make(chan struct{}, 1), nil))
	defer server.Close()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, server.URL+"/", strings.NewReader(strings.Repeat("x", maxRequestBody+1)))
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeBody(t, response.Body) })
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body must be 413, got %d", response.StatusCode)
	}

	empty := NewTransport(api, map[string]Invoker{}, nil, nil)
	server2 := httptest.NewServer(empty)
	defer server2.Close()
	request2, err := http.NewRequestWithContext(context.Background(), http.MethodPost, server2.URL+"/", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	response2, err := http.DefaultClient.Do(request2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeBody(t, response2.Body) })
	if response2.StatusCode != http.StatusBadGateway {
		t.Fatalf("a missing function container must be 502, got %d", response2.StatusCode)
	}
}

func TestTransportUnknownAPIClass(t *testing.T) {
	api := APISpec{Class: APIClass("other"), LogicalID: "Api", Routes: []Route{{Method: "GET", Path: "/", Function: "Fn"}}}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": &fakeInvoker{}}, nil, nil))
	defer server.Close()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeBody(t, response.Body) })
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("an unknown API class must be 502, got %d", response.StatusCode)
	}
}

func TestProfileHelpers(t *testing.T) {
	var missing *Profile
	if missing.Path() != "" {
		t.Fatal("a nil profile has no path")
	}
	if _, err := missing.DynamoDBImage(); err == nil {
		t.Fatal("a nil profile must not resolve an image")
	}
	if _, err := missing.ImageForClass(imageClassGo); err == nil {
		t.Fatal("a nil profile must not resolve a class image")
	}
	profile := &Profile{path: "profile.json"}
	profile.Lambda.Images = map[string]ImagePin{}
	profile.DynamoDBLocal.Image = "amazon/dynamodb-local:3.1.0"
	if profile.Path() != "profile.json" {
		t.Fatalf("unexpected path: %s", profile.Path())
	}
	if _, err := profile.DynamoDBImage(); err == nil {
		t.Fatal("a tag-only DynamoDB image must fail")
	}
	if _, err := profile.ImageForClass(imageClassNode); err == nil {
		t.Fatal("an absent class pin must fail")
	}
	profile.DynamoDBLocal.Image = "amazon/dynamodb-local@" + testDigest
	if image, err := profile.DynamoDBImage(); err != nil || !strings.Contains(image, "@sha256:") {
		t.Fatalf("unexpected DynamoDB image: %q %v", image, err)
	}
	if names := missing.EndpointEnvNames("sqs"); len(names) != 1 || names[0] != "AWS_ENDPOINT_URL_SQS" {
		t.Fatalf("unexpected default endpoint names: %v", names)
	}
}

func TestHandlerArgument(t *testing.T) {
	cases := map[string]struct {
		function FunctionSpec
		want     string
		fail     bool
	}{
		"go bootstrap":    {function: FunctionSpec{Runtime: "provided.al2023", Handler: "bootstrap"}, want: "bootstrap"},
		"go no handler":   {function: FunctionSpec{Runtime: "provided.al2023"}, want: "bootstrap"},
		"node":            {function: FunctionSpec{Runtime: "nodejs24.x", Handler: "handler.handler"}, want: "handler.handler"},
		"node no handler": {function: FunctionSpec{Runtime: "nodejs24.x"}, fail: true},
		"unsupported":     {function: FunctionSpec{Runtime: "java21", Handler: "h"}, fail: true},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			argument, err := handlerArgument(testCase.function)
			if testCase.fail {
				if err == nil {
					t.Fatal("expected a failure")
				}
				return
			}
			if err != nil || argument != testCase.want {
				t.Fatalf("handlerArgument = %q, %v; want %q", argument, err, testCase.want)
			}
		})
	}
}

func TestLoadProfileErrors(t *testing.T) {
	if _, err := LoadProfile(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("a missing profile must fail")
	}
	dir := t.TempDir()
	invalid := filepath.Join(dir, "invalid.json")
	if err := writeJSONFileRaw(invalid, "not json"); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadProfile(invalid); err == nil {
		t.Fatal("an invalid profile must fail")
	}
}

func TestRunnerRejectsUnsharedScratch(t *testing.T) {
	base := testBase(t)
	_, err := NewRunner(Options{
		AppDir:     base,
		ScratchDir: filepath.Join(t.TempDir(), "scratch"),
		Stdout:     &syncBuffer{},
	})
	if err == nil || !strings.Contains(err.Error(), "does not share") {
		t.Fatalf("an unshared scratch directory must fail: %v", err)
	}
}

func TestRunnerPlanFailureAndDockerFailure(t *testing.T) {
	base := testBase(t)
	runner, err := NewRunner(Options{
		AppDir:         base,
		AssemblyDir:    filepath.Join(base, "missing-assembly"),
		ScratchDir:     filepath.Join(base, "scratch"),
		ProfilePath:    writeTestProfile(t, base),
		NamePrefix:     "test-fail",
		MaxConcurrency: 1,
		Stdout:         &syncBuffer{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Plan(t.Context()); err == nil {
		t.Fatal("a missing assembly must fail the plan")
	}
	withAssembly := newTestRunner(t, base)
	withAssembly.docker = &Docker{exec: func(_ context.Context, _ []string) (string, string, error) {
		return "", "docker daemon is not running", errors.New("exit status 1")
	}}
	if err := withAssembly.Run(t.Context()); err == nil || !strings.Contains(err.Error(), "docker daemon") {
		t.Fatalf("an unavailable daemon must fail the run: %v", err)
	}
}

func TestStartServersRejectsOccupiedPort(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	spec, err := runner.Plan(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	port := listenerPort(t, listenLoopback(t))
	runner.options.PortBase = port
	if err := runner.startServers(t.Context(), spec); err == nil {
		t.Fatal("an occupied port must fail")
	}
}

func TestPreflightWithoutProfileOrDocker(t *testing.T) {
	base := testBase(t)
	runner, err := NewRunner(Options{AppDir: base, ScratchDir: filepath.Join(base, "scratch"), Stdout: &syncBuffer{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Preflight(context.Background(), "net", nil); err == nil ||
		!strings.Contains(err.Error(), "Python image") {
		t.Fatalf("a preflight without a profile must fail: %v", err)
	}
	profiled := newTestRunner(t, base)
	profiled.docker = &Docker{exec: func(_ context.Context, _ []string) (string, string, error) {
		return "", "probe exploded", errors.New("exit status 1")
	}}
	if _, err := profiled.Preflight(context.Background(), "net", nil); err == nil ||
		!strings.Contains(err.Error(), "probe exploded") {
		t.Fatalf("a failing probe must report its output: %v", err)
	}
}

func writeJSONFileRaw(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o600)
}
