package localcloudfront

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeEdgeInvoker adapts a function to EdgeInvoker.
type fakeEdgeInvoker func(ctx context.Context, version string, timeout time.Duration, payload []byte) ([]byte, error)

func (f fakeEdgeInvoker) InvokeEdge(ctx context.Context, version string, timeout time.Duration, payload []byte) ([]byte, error) {
	return f(ctx, version, timeout, payload)
}

// fakeStreamOrigin is a streaming origin whose chunks are produced on a pipe.
type fakeStreamOrigin struct {
	mu       sync.Mutex
	fetches  int
	status   int
	header   http.Header
	chunks   []string
	delays   []time.Duration
	failWith error
	// hold, when set, keeps the pipe open after the last chunk until the test
	// closes it, so the gateway's between-packet timeout can be observed.
	hold chan struct{}
}

func (o *fakeStreamOrigin) Fetch(context.Context, OriginRequest) (OriginResponse, error) {
	return OriginResponse{}, errors.New("the fake origin streams only")
}

func (o *fakeStreamOrigin) FetchStream(context.Context, OriginRequest) (StreamResponse, error) {
	o.mu.Lock()
	o.fetches++
	status := o.status
	if status == 0 {
		status = http.StatusOK
	}
	header := o.header.Clone()
	if header == nil {
		header = http.Header{}
	}
	chunks := append([]string(nil), o.chunks...)
	delays := append([]time.Duration(nil), o.delays...)
	failWith := o.failWith
	hold := o.hold
	o.mu.Unlock()

	reader, writer := io.Pipe()
	go func() {
		for index, chunk := range chunks {
			if index < len(delays) && delays[index] > 0 {
				time.Sleep(delays[index])
			}
			if _, err := writer.Write([]byte(chunk)); err != nil {
				return
			}
		}
		if hold != nil {
			<-hold
		}
		if failWith != nil {
			_ = writer.CloseWithError(failWith) //nolint:errcheck // the test asserts the truncation
			return
		}
		_ = writer.Close() //nolint:errcheck // end of stream
	}()
	return StreamResponse{StatusCode: status, Header: header, Body: reader, Chunked: true}, nil
}

func (o *fakeStreamOrigin) fetchCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.fetches
}

func streamingBehavior() *Behavior {
	behavior := cachedBehavior(cachePolicy(60, 3600, 0))
	behavior.OriginResponseTimeout = 2 * time.Second
	return behavior
}

func TestGatewayStreamsAChunkedOriginResponse(t *testing.T) {
	origin := &fakeStreamOrigin{
		header: http.Header{"Content-Type": []string{"text/event-stream"}},
		chunks: []string{"one\n", "two\n", "three\n"},
		delays: []time.Duration{0, 150 * time.Millisecond, 150 * time.Millisecond},
	}
	gateway := NewGateway(testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	server := httptest.NewServer(gateway)
	defer server.Close()

	start := time.Now()
	response, err := http.Get(server.URL + "/x") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", response.StatusCode)
	}
	buffer := make([]byte, 64)
	first := ""
	for len(first) == 0 {
		n, readErr := response.Body.Read(buffer)
		if readErr != nil {
			t.Fatalf("read first chunk: %v", readErr)
		}
		first = string(buffer[:n])
	}
	firstAt := time.Since(start)
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	total := first + string(body)
	if total != "one\ntwo\nthree\n" {
		t.Fatalf("body: %q", total)
	}
	if firstAt > 250*time.Millisecond {
		t.Fatalf("the first chunk arrived after %s, not as the origin wrote it", firstAt)
	}
	if elapsed := time.Since(start); elapsed < 250*time.Millisecond {
		t.Fatalf("the handler did not stream: %s", elapsed)
	}
	if response.Header.Get("x-cache") != cacheMissHeader {
		t.Fatalf("x-cache: %q", response.Header.Get("x-cache"))
	}

	// After the stream completes the object is cached in full.
	second, err := http.Get(server.URL + "/x") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = second.Body.Close() }() //nolint:errcheck // test cleanup
	cached, readErr := io.ReadAll(second.Body)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if second.Header.Get("x-cache") != cacheHitHeader {
		t.Fatalf("second x-cache: %q", second.Header.Get("x-cache"))
	}
	if string(cached) != total {
		t.Fatalf("cached body: %q", cached)
	}
	if origin.fetchCount() != 1 {
		t.Fatalf("origin fetches: %d", origin.fetchCount())
	}
}

func TestGatewayDoesNotCacheAnIncompleteChunkedResponse(t *testing.T) {
	origin := &fakeStreamOrigin{
		header:   http.Header{"Content-Type": []string{"text/event-stream"}},
		chunks:   []string{"complete\n", "partial"},
		delays:   []time.Duration{0, 100 * time.Millisecond},
		failWith: errors.New("origin dropped the connection"),
	}
	gateway := NewGateway(testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)

	first := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if !strings.Contains(first.Body.String(), "complete") {
		t.Fatalf("first body: %q", first.Body.String())
	}
	if first.Body.String() != "complete\npartial" {
		t.Fatalf("the viewer keeps what it received: %q", first.Body.String())
	}
	second := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if second.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("an incomplete chunked response must not be cached: %q", second.Header().Get("x-cache"))
	}
	if origin.fetchCount() != 2 {
		t.Fatalf("origin fetches: %d", origin.fetchCount())
	}
}

func TestGatewayReturnsTheWholeObjectForARangeGET(t *testing.T) {
	origin := &fakeStreamOrigin{
		header: http.Header{"Content-Type": []string{"text/plain"}},
		chunks: []string{"0123456789"},
	}
	gateway := NewGateway(testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", map[string]string{"Range": "bytes=0-2"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status: %d", recorder.Code)
	}
	if recorder.Body.String() != "0123456789" {
		t.Fatalf("a chunked origin response returns the whole object: %q", recorder.Body.String())
	}
	if recorder.Header().Get("Content-Range") != "" {
		t.Fatalf("a chunked origin response must not be sliced: %q", recorder.Header().Get("Content-Range"))
	}
}

func TestGatewayOriginResponseTimeoutAppliesBetweenPackets(t *testing.T) {
	origin := &fakeStreamOrigin{
		header: http.Header{"Content-Type": []string{"text/event-stream"}},
		chunks: []string{"first\n"},
		hold:   make(chan struct{}),
	}
	behavior := streamingBehavior()
	behavior.OriginResponseTimeout = 100 * time.Millisecond
	gateway := NewGateway(testDistribution(behavior, nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)

	start := time.Now()
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	elapsed := time.Since(start)
	close(origin.hold)
	if recorder.Body.String() != "first\n" {
		t.Fatalf("body: %q", recorder.Body.String())
	}
	if elapsed > 2*time.Second {
		t.Fatalf("the origin response timeout did not apply between packets: %s", elapsed)
	}
	second := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if second.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("a timed-out stream must not be cached: %q", second.Header().Get("x-cache"))
	}
}

func TestGatewayBuffersAStreamedResponseForACustomErrorPage(t *testing.T) {
	origin := &fakeStreamOrigin{
		status: http.StatusNotFound,
		header: http.Header{"Content-Type": []string{"text/plain"}},
		chunks: []string{"missing"},
	}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 404, ResponseCode: 410, ErrorCachingMinTTL: intPointer(30)}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusGone {
		t.Fatalf("custom error status: %d", recorder.Code)
	}
	if recorder.Body.String() != "missing" {
		t.Fatalf("custom error body: %q", recorder.Body.String())
	}
}

func TestGatewayBuffersAStreamedResponseWhenAViewerFunctionReplacesTheBody(t *testing.T) {
	origin := &fakeStreamOrigin{
		header: http.Header{"Content-Type": []string{"text/html"}},
		chunks: []string{"origin body"},
	}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	behavior := distribution.DefaultBehavior
	topology, err := ParseTemplates([]Template{{Stack: "TestStack", Resources: map[string]Resource{
		"Viewer": {Type: typeCloudFrontFunction, Properties: mustJSON(t, map[string]any{
			"FunctionCode":   `function handler(event) { event.response.body = { data: "replaced" }; return event.response; }`,
			"FunctionConfig": map[string]any{"Runtime": runtimeJS20},
		})},
	}}})
	if err != nil {
		t.Fatalf("topology: %v", err)
	}
	behavior.ViewerResponseFunction = topology.Functions[0].LogicalID
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "replaced" {
		t.Fatalf("replaced body: %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestGatewayStreamsWithAnOriginResponseEdgeFunctionHeader(t *testing.T) {
	origin := &fakeStreamOrigin{
		header: http.Header{"Content-Type": []string{"text/plain"}},
		chunks: []string{"streamed"},
	}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	behavior := distribution.DefaultBehavior
	behavior.EdgeLambdas = map[string]*EdgeFunction{
		edgeOriginResponse: {Version: "1", Function: "EdgeFn"},
	}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	gateway.EdgeInvoker = fakeEdgeInvoker(func(context.Context, string, time.Duration, []byte) ([]byte, error) {
		response := map[string]any{
			"status":            200,
			"statusDescription": "OK",
			"headers": map[string]any{
				"x-edge": []any{map[string]any{"value": "seen"}},
			},
		}
		raw, err := json.Marshal(response)
		return raw, err
	})
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != 200 || recorder.Body.String() != "streamed" {
		t.Fatalf("streamed: %d %q", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("x-edge") != "seen" {
		t.Fatalf("origin-response header: %v", recorder.Header())
	}
}

func TestGatewayStreamingHeadWritesNoBody(t *testing.T) {
	origin := &fakeStreamOrigin{header: http.Header{"Content-Type": []string{"text/html"}}, chunks: []string{"body"}}
	gateway := NewGateway(testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodHead, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusOK || recorder.Body.Len() != 0 {
		t.Fatalf("HEAD: %d %q", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Type") != "text/html" {
		t.Fatalf("HEAD headers: %v", recorder.Header())
	}
}

func TestGatewayStreamingOriginResponseFailureIsABadGateway(t *testing.T) {
	origin := &fakeStreamOrigin{header: http.Header{}, chunks: []string{"body"}}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	behavior := distribution.DefaultBehavior
	behavior.EdgeLambdas = map[string]*EdgeFunction{edgeOriginResponse: {Version: "1", Function: "Edge"}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	gateway.EdgeInvoker = fakeEdgeInvoker(func(context.Context, string, time.Duration, []byte) ([]byte, error) {
		return nil, errors.New("edge exploded")
	})
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("edge failure: %d", recorder.Code)
	}
}

func TestGatewayStreamingRefusesAMissingViewerFunction(t *testing.T) {
	origin := &fakeStreamOrigin{header: http.Header{}, chunks: []string{"body"}}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	distribution.DefaultBehavior.ViewerResponseFunction = "Missing"
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing viewer function: %d", recorder.Code)
	}
}

func TestGatewayStreamsThroughACustomErrorPagePath(t *testing.T) {
	origin := &fakeStreamOrigin{status: http.StatusNotFound, header: http.Header{}, chunks: []string{"missing"}}
	page := &recordingOrigin{response: OriginResponse{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"text/html"}},
		Body:       []byte("<h1>not found</h1>"),
	}}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"), testOrigin("pages", "pages.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 404, ResponsePagePath: "/errors/404.html", ResponseCode: 404, ErrorCachingMinTTL: intPointer(0)}}
	distribution.CacheBehaviors = []*Behavior{testBehavior("errors/*", "pages", []string{"GET", "HEAD"})}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin, "pages": page}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != 404 || !strings.Contains(recorder.Body.String(), "not found") {
		t.Fatalf("custom page: %d %q", recorder.Code, recorder.Body.String())
	}
}

// brokenStreamOrigin returns a body that fails after the head.
type brokenStreamOrigin struct {
	status int
	header http.Header
}

func (o *brokenStreamOrigin) Fetch(context.Context, OriginRequest) (OriginResponse, error) {
	return OriginResponse{}, errors.New("stream only")
}

func (o *brokenStreamOrigin) FetchStream(context.Context, OriginRequest) (StreamResponse, error) {
	return StreamResponse{
		StatusCode: o.status,
		Header:     o.header,
		Body:       io.NopCloser(errorReader{err: errors.New("origin broke")}),
		Chunked:    true,
	}, nil
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

// failingGatewayWriter fails every body write but implements http.Flusher.
type failingGatewayWriter struct {
	header http.Header
	status int
}

func (w *failingGatewayWriter) Header() http.Header    { return w.header }
func (w *failingGatewayWriter) WriteHeader(status int) { w.status = status }
func (w *failingGatewayWriter) Write([]byte) (int, error) {
	return 0, errors.New("viewer gone")
}
func (w *failingGatewayWriter) Flush() {}

func TestGatewayStreamingEdgeValidationFailureIsABadGateway(t *testing.T) {
	origin := &fakeStreamOrigin{header: http.Header{}, chunks: []string{"body"}}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	distribution.DefaultBehavior.EdgeLambdas = map[string]*EdgeFunction{edgeOriginResponse: {Version: "1", Function: "Edge"}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	gateway.EdgeInvoker = fakeEdgeInvoker(func(context.Context, string, time.Duration, []byte) ([]byte, error) {
		response := map[string]any{"status": 999, "headers": map[string]any{}}
		raw, err := json.Marshal(response)
		return raw, err
	})
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("an invalid edge response must be 502: %d", recorder.Code)
	}
}

func TestGatewayStreamingViewerFunctionFailureIsAServiceUnavailable(t *testing.T) {
	origin := &fakeStreamOrigin{header: http.Header{}, chunks: []string{"body"}}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	topology, err := ParseTemplates([]Template{{Stack: "TestStack", Resources: map[string]Resource{
		"Viewer": {Type: typeCloudFrontFunction, Properties: mustJSON(t, map[string]any{
			"FunctionCode":   `function handler(event) { throw new Error("boom"); }`,
			"FunctionConfig": map[string]any{"Runtime": runtimeJS20},
		})},
	}}})
	if err != nil {
		t.Fatalf("topology: %v", err)
	}
	distribution.DefaultBehavior.ViewerResponseFunction = topology.Functions[0].LogicalID
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("a throwing viewer function must be 503: %d", recorder.Code)
	}
}

func TestGatewayStreamingViewerBodyReplacementTooLargeIsRefused(t *testing.T) {
	origin := &fakeStreamOrigin{header: http.Header{}, chunks: []string{"body"}}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	topology, err := ParseTemplates([]Template{{Stack: "TestStack", Resources: map[string]Resource{
		"Viewer": {Type: typeCloudFrontFunction, Properties: mustJSON(t, map[string]any{
			"FunctionCode":   `function handler(event) { event.response.body = { encoding: "base64", data: "%%%" }; return event.response; }`,
			"FunctionConfig": map[string]any{"Runtime": runtimeJS20},
		})},
	}}})
	if err != nil {
		t.Fatalf("topology: %v", err)
	}
	distribution.DefaultBehavior.ViewerResponseFunction = topology.Functions[0].LogicalID
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable && recorder.Code != http.StatusBadGateway {
		t.Fatalf("an invalid viewer body must fail closed: %d", recorder.Code)
	}
}

func TestGatewayStreamingWriterFailureEndsTheResponse(t *testing.T) {
	origin := &fakeStreamOrigin{header: http.Header{}, chunks: []string{"body"}}
	gateway := NewGateway(testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	writer := &failingGatewayWriter{header: http.Header{}}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://viewer.example/x", nil)
	gateway.ServeHTTP(writer, request)
	if writer.status != http.StatusOK {
		t.Fatalf("the head must be written before the body fails: %d", writer.status)
	}
}

func TestGatewayStreamingCustomErrorBufferFailureIsABadGateway(t *testing.T) {
	origin := &brokenStreamOrigin{status: http.StatusNotFound, header: http.Header{}}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 404, ResponseCode: 410, ErrorCachingMinTTL: intPointer(0)}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("a broken origin while buffering a custom error response: %d", recorder.Code)
	}
}

func TestGatewayStreamingBuffersAnEmptyChunkedBodyForACustomError(t *testing.T) {
	origin := &fakeStreamOrigin{status: http.StatusNotFound, header: http.Header{}, chunks: nil}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 404, ResponseCode: 410, ErrorCachingMinTTL: intPointer(0)}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusGone || recorder.Body.Len() != 0 {
		t.Fatalf("empty custom error: %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestReadWithOriginTimeoutReportsABodyError(t *testing.T) {
	body := io.NopCloser(errorReader{err: errors.New("origin broke")})
	if _, err := readWithOriginTimeout(body, make([]byte, 8), time.Second); err == nil {
		t.Fatal("a read error must be reported")
	}
}

func TestGatewayStreamingEdgeBodyReplacementBuffersTheOrigin(t *testing.T) {
	origin := &fakeStreamOrigin{header: http.Header{"Content-Type": []string{"text/plain"}}, chunks: []string{"origin"}}
	distribution := testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example"))
	distribution.DefaultBehavior.EdgeLambdas = map[string]*EdgeFunction{edgeOriginResponse: {Version: "1", Function: "Edge"}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	gateway.EdgeInvoker = fakeEdgeInvoker(func(context.Context, string, time.Duration, []byte) ([]byte, error) {
		response := map[string]any{
			"status": 200,
			"body":   map[string]any{"data": "replaced"},
		}
		raw, err := json.Marshal(response)
		return raw, err
	})
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "replaced" {
		t.Fatalf("edge body replacement: %d %q", recorder.Code, recorder.Body.String())
	}
}
