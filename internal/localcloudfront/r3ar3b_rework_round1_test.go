package localcloudfront

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Round-1 rework tests for the LOCAL-W2-R3b delta.

// fetchOnlyStreamOrigin is a StreamOrigin that cannot stream this request, the
// shape a Function URL origin has under --rie.
type fetchOnlyStreamOrigin struct {
	fetches int
}

func (o *fetchOnlyStreamOrigin) Fetch(context.Context, OriginRequest) (OriginResponse, error) {
	o.fetches++
	return OriginResponse{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/plain"}},
		Body:       []byte("buffered"),
	}, nil
}

func (o *fetchOnlyStreamOrigin) FetchStream(context.Context, OriginRequest) (StreamResponse, error) {
	return StreamResponse{}, ErrStreamUnavailable
}

func TestGatewayFallsBackToFetchWhenTheOriginCannotStream(t *testing.T) {
	origin := &fetchOnlyStreamOrigin{}
	gateway := NewGateway(
		testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "buffered" {
		t.Fatalf("an origin that cannot stream must be served through Fetch: %d %q", recorder.Code, recorder.Body.String())
	}
	if origin.fetches != 1 {
		t.Fatalf("the buffered path must run once: %d", origin.fetches)
	}
}

// bufferedStreamOrigin has the shape of a BUFFERED Function URL origin: it
// implements StreamOrigin but returns the complete body without chunked
// encoding.
type bufferedStreamOrigin struct {
	fetches int
	streams int
	status  int
	header  http.Header
	body    []byte
}

func (o *bufferedStreamOrigin) Fetch(context.Context, OriginRequest) (OriginResponse, error) {
	o.fetches++
	return OriginResponse{StatusCode: o.status, Header: o.header.Clone(), Body: o.body}, nil
}

func (o *bufferedStreamOrigin) FetchStream(context.Context, OriginRequest) (StreamResponse, error) {
	o.streams++
	return StreamResponse{
		StatusCode: o.status,
		Header:     o.header.Clone(),
		Body:       io.NopCloser(bytes.NewReader(o.body)),
		Chunked:    false,
	}, nil
}

func edgeEventType(t *testing.T, payload []byte) string {
	t.Helper()
	var event struct {
		Records []struct {
			CF struct {
				Config struct {
					EventType string `json:"eventType"`
				} `json:"config"`
			} `json:"cf"`
		} `json:"Records"`
	}
	if err := json.Unmarshal(payload, &event); err != nil || len(event.Records) == 0 {
		t.Fatalf("edge event: %v %s", err, payload)
	}
	return event.Records[0].CF.Config.EventType
}

func TestBufferedStreamOriginTakesTheBufferedFinishPath(t *testing.T) {
	origin := &bufferedStreamOrigin{
		status: http.StatusOK,
		header: http.Header{"Content-Type": []string{"text/html"}},
		body:   []byte("<h1>buffered</h1>"),
	}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	distribution.DefaultBehavior.EdgeLambdas = map[string]*EdgeFunction{
		edgeOriginResponse: {EventType: edgeOriginResponse, Version: "1", Function: "OriginFn"},
		edgeViewerResponse: {EventType: edgeViewerResponse, Version: "1", Function: "ViewerFn"},
	}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	gateway.EdgeInvoker = fakeEdgeInvoker(func(_ context.Context, _ string, _ time.Duration, payload []byte) ([]byte, error) {
		// Echo the response headers the function received, as a real
		// viewer-response function does, and add its own marker.
		var event struct {
			Records []struct {
				CF struct {
					Response struct {
						Headers map[string][]struct {
							Key   string `json:"key"`
							Value string `json:"value"`
						} `json:"headers"`
					} `json:"response"`
				} `json:"cf"`
			} `json:"Records"`
		}
		if err := json.Unmarshal(payload, &event); err != nil || len(event.Records) == 0 {
			t.Fatalf("edge event: %v %s", err, payload)
		}
		headers := map[string]any{}
		for name, entries := range event.Records[0].CF.Response.Headers {
			values := make([]any, 0, len(entries))
			for _, entry := range entries {
				values = append(values, map[string]any{"key": entry.Key, "value": entry.Value})
			}
			headers[name] = values
		}
		name := "x-" + edgeEventType(t, payload)
		headers[name] = []any{map[string]any{"key": name, "value": "ran"}}
		return json.Marshal(map[string]any{"status": "200", "statusDescription": "OK", "headers": headers})
	})
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "<h1>buffered</h1>" {
		t.Fatalf("buffered stream origin: %d %q", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("x-origin-response") != "ran" {
		t.Fatalf("the origin-response function did not run: %v", recorder.Header())
	}
	if recorder.Header().Get("x-viewer-response") != "ran" {
		t.Fatalf("the viewer-response function did not run: %v", recorder.Header())
	}
	second := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if second.Code != http.StatusOK || origin.streams != 1 || origin.fetches != 0 {
		t.Fatalf("the complete response must be cached by the buffered path: status=%d streams=%d fetches=%d",
			second.Code, origin.streams, origin.fetches)
	}
}

func TestGatewayDoesNotCacheAStreamThatEndsWithAnError(t *testing.T) {
	origin := &fakeStreamOrigin{
		chunks:   []string{"partial"},
		failWith: errors.New("stream ended with the Error error trailer"),
	}
	gateway := NewGateway(testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	first := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if first.Code != http.StatusOK || first.Body.String() != "partial" {
		t.Fatalf("first response: %d %q", first.Code, first.Body.String())
	}
	second := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if second.Code != http.StatusOK || origin.fetchCount() != 2 {
		t.Fatalf("a trailer-errored stream must not be cached: status=%d fetches=%d", second.Code, origin.fetchCount())
	}
}

func TestStreamedOriginRunsTheViewerResponseAtThePrelude(t *testing.T) {
	hold := make(chan struct{})
	origin := &fakeStreamOrigin{
		header: http.Header{"Content-Type": []string{"text/event-stream"}},
		chunks: []string{"one\n"},
		hold:   hold,
	}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	distribution.DefaultBehavior.EdgeLambdas = map[string]*EdgeFunction{
		edgeViewerResponse: {EventType: edgeViewerResponse, Version: "1", Function: "ViewerFn"},
	}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	gateway.EdgeInvoker = fakeEdgeInvoker(func(_ context.Context, _ string, _ time.Duration, payload []byte) ([]byte, error) {
		if eventType := edgeEventType(t, payload); eventType != edgeViewerResponse {
			t.Errorf("unexpected edge event: %s", eventType)
		}
		return json.Marshal(map[string]any{
			"status":            "200",
			"statusDescription": "OK",
			"headers": map[string]any{
				"x-viewer-response": []any{map[string]any{"key": "x-viewer-response", "value": "ran"}},
			},
		})
	})
	server := httptest.NewServer(gateway)
	defer server.Close()
	response, err := http.Get(server.URL + "/x") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", response.StatusCode)
	}
	if response.Header.Get("x-viewer-response") != "ran" {
		t.Fatalf("the viewer-response function must run at the prelude: %v", response.Header)
	}
	buffer := make([]byte, 64)
	n, readErr := response.Body.Read(buffer)
	if readErr != nil || string(buffer[:n]) != "one\n" {
		t.Fatalf("first chunk: %q err=%v", buffer[:n], readErr)
	}
	close(hold)
}

func TestGatewayStreamingUsesTheOriginReadTimeoutFromTheTemplate(t *testing.T) {
	distribution := parseDistributionConfig(t, map[string]any{
		"Enabled": true,
		"Origins": []any{map[string]any{
			"Id":         "origin",
			"DomainName": "origin.example",
			"CustomOriginConfig": map[string]any{
				"OriginProtocolPolicy": "http-only",
				"OriginReadTimeout":    float64(1),
			},
		}},
		"DefaultCacheBehavior": map[string]any{
			"TargetOriginId": "origin",
			"AllowedMethods": []any{"GET", "HEAD"},
			"CachePolicyId":  "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
		},
	})
	if distribution.DefaultBehavior == nil || len(distribution.Origins) != 1 {
		t.Fatalf("distribution: %+v", distribution)
	}
	if distribution.DefaultBehavior.OriginResponseTimeout != 0 {
		t.Fatal("the behavior must not carry a value; the template sets the origin's")
	}
	if got := originResponseTimeout(distribution.DefaultBehavior, distribution.Origins[0]); got != time.Second {
		t.Fatalf("origin read timeout from the template: %s", got)
	}

	hold := make(chan struct{})
	defer close(hold)
	origin := &fakeStreamOrigin{chunks: []string{"one"}, hold: hold}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	started := time.Now()
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	elapsed := time.Since(started)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "one" {
		t.Fatalf("response: %d %q", recorder.Code, recorder.Body.String())
	}
	if elapsed > 5*time.Second {
		t.Fatalf("the streaming branch used the 30s default instead of the template's 1s: %s", elapsed)
	}
}
