package localrunner

// Factory round-0 probes for PR #1232 (R3a + R3b). They run on a git-archive of
// the PR head, never on the registered checkout.

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestFactoryProbeFetchStreamReturnsWhenTheRuntimeReportsAHandlerError drives
// the real Runtime API: the runtime takes /next and posts /error (the documented
// handler-error path). The buffered Fetch path maps that to a 502; the streaming
// FetchStream path must answer the gateway promptly, not wait for the viewer to
// disconnect.
func TestFactoryProbeFetchStreamReturnsWhenTheRuntimeReportsAHandlerError(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	process := &FunctionProcess{Function: FunctionSpec{LogicalID: "Fn", Timeout: 30}, Container: "fn", api: api, logf: t.Logf}
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization, invoker: process}
	go func() {
		next := nextInvocation(t, api)
		requestID := next.header.Get(runtimeRequestIDHeader)
		postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/error",
			[]byte(`{"errorMessage":"kaboom","errorType":"ValueError"}`), http.Header{runtimeErrorTypeHeader: {"ValueError"}})
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	started := time.Now()
	stream, err := origin.FetchStream(ctx, localcloudfrontOriginRequest())
	elapsed := time.Since(started)
	if errors.Is(err, context.DeadlineExceeded) || elapsed > 3*time.Second {
		t.Fatalf("FetchStream waited for the viewer context (%s) instead of answering the handler error: err=%v", elapsed, err)
	}
	if err != nil {
		// An error is an acceptable answer (the gateway maps it to 502).
		return
	}
	if stream.Body != nil {
		_ = stream.Body.Close() //nolint:errcheck // probe
	}
	if stream.StatusCode != http.StatusBadGateway {
		t.Fatalf("a handler error behind a Function URL origin is a 502 on the buffered path; FetchStream answered %d", stream.StatusCode)
	}
}

// TestFactoryProbeFetchStreamReturnsOnATimeout: the runtime takes /next and
// never answers; the function timeout (1 s) ends the invocation with the
// documented Sandbox.Timedout error. FetchStream must return then.
func TestFactoryProbeFetchStreamReturnsOnATimeout(t *testing.T) {
	api := testRuntimeAPI(t, 1)
	process := &FunctionProcess{Function: FunctionSpec{LogicalID: "Fn", Timeout: 1}, Container: "fn", api: api, logf: t.Logf}
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization, invoker: process}
	go func() { _ = nextInvocation(t, api) }()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	started := time.Now()
	stream, err := origin.FetchStream(ctx, localcloudfrontOriginRequest())
	elapsed := time.Since(started)
	if errors.Is(err, context.DeadlineExceeded) || elapsed > 5*time.Second {
		t.Fatalf("FetchStream waited for the viewer context (%s) instead of answering the timeout: err=%v", elapsed, err)
	}
	if err == nil && stream.Body != nil {
		_ = stream.Body.Close() //nolint:errcheck // probe
	}
	if err == nil && stream.StatusCode != http.StatusBadGateway {
		t.Fatalf("a timeout behind a Function URL origin is a 502 on the buffered path; FetchStream answered %d", stream.StatusCode)
	}
}

// TestFactoryProbeFunctionURLOriginServesANonStreamingInvoker: in --rie mode
// the process cannot stream; the origin must still serve the buffered response
// (either FetchStream wraps Fetch, or the gateway falls back to Fetch).
func TestFactoryProbeFunctionURLOriginServesANonStreamingInvoker(t *testing.T) {
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization,
		invoker: &recordingInvoker{response: []byte(`{"statusCode":200,"headers":{"content-type":"text/plain"},"body":"buffered"}`)}}
	stream, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest())
	if err != nil {
		t.Fatalf("FetchStream refuses a non-streaming invoker: %v (the gateway turns this into a 502 unless it falls back to Fetch)", err)
	}
	body, _ := io.ReadAll(stream.Body) //nolint:errcheck // probe
	if stream.StatusCode != 200 || string(body) != "buffered" {
		t.Fatalf("buffered response through FetchStream: %d %q", stream.StatusCode, body)
	}
}

// TestFactoryProbeRuntimeAPIListenerIsNotBoundToEveryInterface records the
// listener's bind address. The previous posture published the RIE port on
// loopback only; an unauthenticated Runtime API on 0.0.0.0 is reachable from
// the local network.
func TestFactoryProbeRuntimeAPIListenerIsNotBoundToEveryInterface(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	address, ok := api.listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatal("not a TCP listener")
	}
	if address.IP.IsUnspecified() {
		t.Fatalf("the Runtime API listener binds every interface: %s", address)
	}
}

// TestFactoryProbeBufferedHandlerErrorThroughFetchStreamIsNot200: the runtime
// posts a buffered /response whose body is a handler-error JSON (no statusCode);
// the Response decoding rule serves 502 on the buffered path.
func TestFactoryProbeBufferedUndecodableBodyThroughFetchStreamIsNot200(t *testing.T) {
	invoker := &fakeStreamInvoker{contentType: "application/json", streamed: false, chunks: [][]byte{[]byte(`{"errorMessage":"kaboom","errorType":"ValueError"}`)}}
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization, invoker: invoker}
	stream, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest())
	if err != nil {
		return
	}
	body, _ := io.ReadAll(stream.Body) //nolint:errcheck // probe
	if stream.StatusCode == http.StatusOK && strings.Contains(string(body), "errorType") {
		t.Fatalf("a handler-error payload is served as 200 with the error JSON as the body: %q", body)
	}
}
