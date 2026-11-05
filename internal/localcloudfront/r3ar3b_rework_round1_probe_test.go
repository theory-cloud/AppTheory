package localcloudfront

// Factory round-0 probe for PR #1232 (R3b): the gateway must serve an origin
// that implements StreamOrigin but cannot stream this request (ErrStreamUnavailable,
// the --rie case) through the buffered Fetch path instead of answering 502.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

type bufferedOnlyStreamOrigin struct {
	fetches int
}

func (o *bufferedOnlyStreamOrigin) Fetch(context.Context, OriginRequest) (OriginResponse, error) {
	o.fetches++
	return OriginResponse{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/plain"}}, Body: []byte("buffered")}, nil
}

func (o *bufferedOnlyStreamOrigin) FetchStream(context.Context, OriginRequest) (StreamResponse, error) {
	return StreamResponse{}, ErrStreamUnavailable
}

func TestFactoryProbeGatewayFallsBackToFetchWhenTheOriginCannotStream(t *testing.T) {
	origin := &bufferedOnlyStreamOrigin{}
	gateway := NewGateway(testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "buffered" {
		t.Fatalf("an origin that cannot stream must be served through Fetch: %d %q (fetches=%d)", recorder.Code, recorder.Body.String(), origin.fetches)
	}
}

// bufferedViaStreamOrigin models a BUFFERED Function URL origin after R3b: the
// origin implements StreamOrigin and returns the complete body as one
// non-chunked StreamResponse (the shape fetchStreamMember and the pipe sink
// produce for a buffered function).
type bufferedViaStreamOrigin struct{}

func (o *bufferedViaStreamOrigin) Fetch(context.Context, OriginRequest) (OriginResponse, error) {
	return OriginResponse{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: []byte("<h1>buffered</h1>")}, nil
}

func (o *bufferedViaStreamOrigin) FetchStream(context.Context, OriginRequest) (StreamResponse, error) {
	return StreamResponse{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}},
		Body: io.NopCloser(bytes.NewReader([]byte("<h1>buffered</h1>"))), Chunked: false}, nil
}

// TestFactoryProbeBufferedStreamOriginStillRunsTheViewerResponseEdgeFunction:
// a Lambda@Edge viewer-response association (R5b) must still run for a
// buffered Function URL origin; the streaming branch skips it.
func TestFactoryProbeBufferedStreamOriginStillRunsTheViewerResponseEdgeFunction(t *testing.T) {
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	distribution.DefaultBehavior.EdgeLambdas = map[string]*EdgeFunction{
		edgeViewerResponse: {Version: "1", Function: "EdgeFn"},
	}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": &bufferedViaStreamOrigin{}}, nil, t.Logf)
	gateway.EdgeInvoker = fakeEdgeInvoker(func(_ context.Context, _ string, _ time.Duration, payload []byte) ([]byte, error) {
		var event map[string]any
		_ = json.Unmarshal(payload, &event) //nolint:errcheck // probe
		response := map[string]any{
			"status":            "200",
			"statusDescription": "OK",
			"headers": map[string]any{
				"x-viewer-response": []any{map[string]any{"key": "x-viewer-response", "value": "ran"}},
			},
		}
		return json.Marshal(response)
	})
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status: %d %q", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("x-viewer-response") != "ran" {
		t.Fatalf("the Lambda@Edge viewer-response function did not run for a buffered Function URL origin: %v", recorder.Header())
	}
}
