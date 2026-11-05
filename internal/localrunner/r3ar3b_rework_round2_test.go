package localrunner

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Round-2 rework tests for F-R3b-R1-1: the standalone Function URL listener
// decodes a buffered response with the same rule as every other local Function
// URL surface.

func TestTransportFunctionURLListenerInfersAJSONReturnValue(t *testing.T) {
	body := []byte(`{"message":"Hello, world!"}`)
	api := APISpec{
		Class:     APIFunctionURL,
		LogicalID: "Url",
		Routes:    []Route{{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn"}},
	}
	invoker := &fakeInvoker{response: body}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, nil, nil))
	defer server.Close()
	withGET(t, server.URL+"/", func(response *http.Response) {
		received, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("a JSON return value is a 200: %d", response.StatusCode)
		}
		if got := response.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("inferred content type: %q", got)
		}
		if string(received) != string(body) {
			t.Fatalf("inferred body: %q", received)
		}
	})
}

func TestTransportStreamingFunctionURLListenerInfersABufferedJSONReturnValue(t *testing.T) {
	body := []byte(`{"message":"Hello, world!"}`)
	invoker := &fakeStreamInvoker{contentType: "application/json", streamed: false, chunks: [][]byte{body}}
	api := APISpec{
		Class:     APIFunctionURL,
		LogicalID: "Url",
		Routes:    []Route{{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn", Streaming: true}},
	}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf))
	defer server.Close()
	withGET(t, server.URL+"/", func(response *http.Response) {
		received, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("a buffered JSON return value on a streaming URL is a 200: %d", response.StatusCode)
		}
		if got := response.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("inferred content type: %q", got)
		}
		if string(received) != string(body) {
			t.Fatalf("inferred body: %q", received)
		}
	})
}

func TestTransportStreamingFunctionURLListenerInfersAFrameWithoutAStatusCode(t *testing.T) {
	invoker := &fakeStreamInvoker{
		contentType: streamIntegrationContentType,
		streamed:    false,
		chunks:      framedChunks(`{"headers":{"x-case":"framed"}}`, "framed body"),
	}
	api := APISpec{
		Class:     APIFunctionURL,
		LogicalID: "Url",
		Routes:    []Route{{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn", Streaming: true}},
	}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf))
	defer server.Close()
	withGET(t, server.URL+"/", func(response *http.Response) {
		received, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("a frame without a statusCode is the pipe sink's 200: %d", response.StatusCode)
		}
		if got := response.Header.Get("x-case"); got != "framed" {
			t.Fatalf("prelude headers: %q", got)
		}
		if string(received) != "framed body" {
			t.Fatalf("framed payload: %q", received)
		}
	})
}

func TestTransportFunctionURLListenerKeepsAnErrorPayloadA502(t *testing.T) {
	invoker := &fakeInvoker{response: []byte(`{"errorMessage":"kaboom","errorType":"ValueError"}`)}
	api := APISpec{
		Class:     APIFunctionURL,
		LogicalID: "Url",
		Routes:    []Route{{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn"}},
	}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, nil, nil))
	defer server.Close()
	withGET(t, server.URL+"/", func(response *http.Response) {
		if response.StatusCode != http.StatusBadGateway {
			t.Fatalf("an error payload stays the documented 502: %d", response.StatusCode)
		}
	})
}

func TestTransportHTTPAPIDoesNotInferAReturnValue(t *testing.T) {
	invoker := &fakeInvoker{response: []byte(`{"message":"Hello, world!"}`)}
	api := APISpec{
		Class:     APIHTTPV2,
		LogicalID: "Api",
		Stage:     "$default",
		Routes: []Route{
			{Class: APIHTTPV2, Method: "GET", Path: "/hello", RouteKey: "GET /hello", Function: "Fn"},
		},
	}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, nil, nil))
	defer server.Close()
	withGET(t, server.URL+"/hello", func(response *http.Response) {
		if response.StatusCode != http.StatusBadGateway {
			t.Fatalf("only a Function URL infers a return value: %d", response.StatusCode)
		}
	})
}
