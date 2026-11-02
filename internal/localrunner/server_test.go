package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeInvoker struct {
	payloads [][]byte
	response []byte
	err      error
}

func (f *fakeInvoker) Invoke(_ context.Context, payload []byte) ([]byte, error) {
	f.payloads = append(f.payloads, payload)
	return f.response, f.err
}

func testTransport(invoker Invoker) *Transport {
	api := APISpec{
		Class:     APIHTTPV2,
		LogicalID: "Api",
		Stage:     "$default",
		Routes: []Route{
			{Class: APIHTTPV2, Method: "GET", Path: "/hello/{name}", RouteKey: "GET /hello/{name}", Function: "Fn"},
		},
	}
	return NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 2), nil)
}

// withGET issues a GET and closes the response body after check runs.
func withGET(t *testing.T, url string, check func(*http.Response)) {
	t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("get %s: %v", url, err)
	}
	defer func() {
		if closeErr := response.Body.Close(); closeErr != nil {
			t.Errorf("close response body: %v", closeErr)
		}
	}()
	check(response)
}

func TestTransportServesDecodedResponse(t *testing.T) {
	invoker := &fakeInvoker{response: []byte(`{
		"statusCode": 200,
		"headers": {"content-type": "application/json"},
		"multiValueHeaders": {"x-values": ["a", "b"]},
		"cookies": ["session=1"],
		"body": "{\"ok\":true}"
	}`)}
	server := httptest.NewServer(testTransport(invoker))
	defer server.Close()

	withGET(t, server.URL+"/hello/AppTheory", func(response *http.Response) {
		if response.StatusCode != 200 {
			t.Fatalf("unexpected status %d", response.StatusCode)
		}
		if response.Header.Get("x-values") != "a" {
			t.Fatalf("multi-value header lost: %+v", response.Header)
		}
		if len(response.Header.Values("Set-Cookie")) != 1 {
			t.Fatalf("cookie lost: %+v", response.Header)
		}
		if response.Header.Get("x-amzn-RequestId") == "" {
			t.Fatalf("request id header missing: %+v", response.Header)
		}
	})
	if len(invoker.payloads) != 1 {
		t.Fatalf("expected one invocation, got %d", len(invoker.payloads))
	}
	var event map[string]any
	if err := json.Unmarshal(invoker.payloads[0], &event); err != nil {
		t.Fatalf("event is not JSON: %v", err)
	}
	if event["rawPath"] != "/hello/AppTheory" {
		t.Fatalf("unexpected event: %v", event["rawPath"])
	}
	params, ok := event["pathParameters"].(map[string]any)
	if !ok || params["name"] != "AppTheory" {
		t.Fatalf("path parameters missing: %v", event["pathParameters"])
	}
}

func TestTransportBuffersStreamingFrame(t *testing.T) {
	frame := append([]byte(`{"statusCode":200,"headers":{"content-type":"text/event-stream"}}`), streamingFrameSeparator...)
	frame = append(frame, []byte("data: one\n\n")...)
	server := httptest.NewServer(testTransport(&fakeInvoker{response: frame}))
	defer server.Close()

	withGET(t, server.URL+"/hello/AppTheory", func(response *http.Response) {
		if response.StatusCode != 200 || response.Header.Get("content-type") != "text/event-stream" {
			t.Fatalf("unexpected framed response: %d %+v", response.StatusCode, response.Header)
		}
		if response.ContentLength != int64(len("data: one\n\n")) {
			t.Fatalf("the buffered body must be complete, got content-length %d", response.ContentLength)
		}
	})
}

func TestTransportNotFoundAndHandlerError(t *testing.T) {
	server := httptest.NewServer(testTransport(&fakeInvoker{response: []byte(`{"errorMessage":"boom"}`)}))
	defer server.Close()

	withGET(t, server.URL+"/nope", func(missing *http.Response) {
		if missing.StatusCode != http.StatusNotFound {
			t.Fatalf("unmatched route must be 404, got %d", missing.StatusCode)
		}
	})
	withGET(t, server.URL+"/hello/AppTheory", func(failed *http.Response) {
		if failed.StatusCode != http.StatusBadGateway {
			t.Fatalf("handler errors must be 502, got %d", failed.StatusCode)
		}
	})
}

func TestTransportReportsInvokerFailure(t *testing.T) {
	server := httptest.NewServer(testTransport(&fakeInvoker{err: fmt.Errorf("container is gone")}))
	defer server.Close()
	withGET(t, server.URL+"/hello/AppTheory", func(response *http.Response) {
		if response.StatusCode != http.StatusBadGateway {
			t.Fatalf("invoker failure must be 502, got %d", response.StatusCode)
		}
	})
}

func TestTransportServesDeclaredMockWithoutInvoking(t *testing.T) {
	api := APISpec{
		Class:     APIRESTV1,
		LogicalID: "Rest",
		Stage:     "prod",
		Routes: []Route{
			{
				Class:  APIRESTV1,
				Method: "OPTIONS",
				Path:   "/sse",
				Mock: &MockResponse{StatusCode: 200, Headers: map[string]string{
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Max-Age":      "600",
				}},
			},
		},
	}
	invoker := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"unexpected"}`)}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, nil, nil))
	defer server.Close()

	request, err := http.NewRequestWithContext(context.Background(), http.MethodOptions, server.URL+"/sse", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("options request: %v", err)
	}
	defer func() {
		if closeErr := response.Body.Close(); closeErr != nil {
			t.Errorf("close response body: %v", closeErr)
		}
	}()
	if response.StatusCode != 200 {
		t.Fatalf("unexpected status %d", response.StatusCode)
	}
	if response.Header.Get("Access-Control-Allow-Origin") != "*" ||
		response.Header.Get("Access-Control-Max-Age") != "600" {
		t.Fatalf("declared mock headers missing: %+v", response.Header)
	}
	if len(invoker.payloads) != 0 {
		t.Fatalf("a mock route must not invoke a function: %d invocation(s)", len(invoker.payloads))
	}
}

func TestTransportFunctionURLMatchesEveryPath(t *testing.T) {
	api := APISpec{
		Class:     APIFunctionURL,
		LogicalID: "Url",
		Routes: []Route{{
			Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn",
		}},
	}
	invoker := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, nil, nil))
	defer server.Close()
	withGET(t, server.URL+"/any/path/at/all", func(response *http.Response) {
		if response.StatusCode != 200 {
			t.Fatalf("unexpected status %d", response.StatusCode)
		}
	})
	if len(invoker.payloads) != 1 || !strings.Contains(string(invoker.payloads[0]), `"routeKey":"$default"`) {
		t.Fatalf("Function URL event missing its route key: %s", invoker.payloads[0])
	}
}
