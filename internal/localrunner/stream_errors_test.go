package localrunner

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// errorReader fails every read.
type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

// errorWriter fails every write.
type errorWriter struct {
	header http.Header
	status int
}

func (w *errorWriter) Header() http.Header    { return w.header }
func (w *errorWriter) WriteHeader(status int) { w.status = status }
func (w *errorWriter) Write([]byte) (int, error) {
	return 0, errors.New("client is gone")
}
func (w *errorWriter) Flush() {}

func TestStreamFrameDecoderRejectsInvalidMetadata(t *testing.T) {
	decoder := &streamFrameDecoder{}
	decoder.Feed([]byte("{not-json" + string(streamFrameDelimiter) + "body"))
	if _, err := decoder.Metadata(); err == nil {
		t.Fatal("invalid metadata JSON must be reported")
	}
}

func TestStreamFrameMetadataApplyRefusesAnInvalidStatus(t *testing.T) {
	status := 999
	header := http.Header{}
	got := streamFrameMetadata{StatusCode: &status, Headers: map[string]string{"content-length": "1", "x-ok": "yes"}}.apply(header)
	if got != http.StatusOK {
		t.Fatalf("an out-of-range status must fall back to 200: %d", got)
	}
	if header.Get("Content-Length") != "" || header.Get("x-ok") != "yes" {
		t.Fatalf("headers: %v", header)
	}
}

func TestFunctionURLStreamReportsAWriteError(t *testing.T) {
	writer := &errorWriter{header: http.Header{}}
	sink := &functionURLStream{writer: writer, flusher: writer}
	if err := sink.Start("text/plain", true); err != nil {
		t.Fatal(err)
	}
	if err := sink.Chunk([]byte("payload")); err == nil {
		t.Fatal("a failed write must be reported")
	}
}

func TestFunctionURLStreamEndsWithoutAChunk(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &functionURLStream{writer: recorder, flusher: recorder}
	if err := sink.Start(streamIntegrationContentType, true); err != nil {
		t.Fatal(err)
	}
	if err := sink.End("", nil); err != nil {
		t.Fatal(err)
	}
	if recorder.status != http.StatusOK {
		t.Fatalf("an empty stream is a 200: %d", recorder.status)
	}
}

func TestAPIGatewayStreamEndsWithoutAFrame(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &apiGatewayStream{writer: recorder, flusher: recorder}
	if err := sink.Start("", true); err != nil {
		t.Fatal(err)
	}
	if err := sink.End("", nil); err == nil {
		t.Fatal("an empty stream is not a valid API Gateway response")
	}
}

func TestAPIGatewayStreamReportsAWriteError(t *testing.T) {
	writer := &errorWriter{header: http.Header{}}
	sink := &apiGatewayStream{writer: writer, flusher: writer}
	if err := sink.Start("", true); err != nil {
		t.Fatal(err)
	}
	if err := sink.Chunk([]byte(`{}` + string(streamFrameDelimiter) + "payload")); err == nil {
		t.Fatal("a failed write must be reported")
	}
}

func TestRuntimeAPINextAfterClose(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	api.close()
	response, err := http.Get(api.HostURL() + runtimeNextPath) //nolint:noctx // a test client
	if err != nil {
		// A closed listener refuses the connection; either answer is a closed API.
		return
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("closed API: %d", response.StatusCode)
	}
}

func TestRuntimeAPINextHonorsTheRequestContext(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequestWithContext(ctx, http.MethodGet, api.HostURL()+runtimeNextPath, nil)
	cancel()
	recorder := httptest.NewRecorder()
	api.serveHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("a canceled long poll writes no error status: %d", recorder.Code)
	}
}

func TestRuntimeAPIReadErrorsAreRefused(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	initRequest := httptest.NewRequestWithContext(context.Background(), http.MethodPost, runtimeInitErrorPath, errorReader{err: errors.New("broken body")})
	initRecorder := httptest.NewRecorder()
	api.serveHTTP(initRecorder, initRequest)
	if initRecorder.Code != http.StatusBadRequest {
		t.Fatalf("an unreadable init error must be 400: %d", initRecorder.Code)
	}

	result := make(chan runtimeInvocationResult, 1)
	go func() {
		_, outcome := api.Invoke(context.Background(), []byte(`{}`))
		result <- outcome
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		runtimeAPIVersionPath+"/invocation/"+requestID+"/response", errorReader{err: errors.New("broken body")})
	recorder := httptest.NewRecorder()
	api.serveHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("an unreadable response must be 400: %d", recorder.Code)
	}
	if outcome := <-result; !outcome.reset || outcome.err == nil {
		t.Fatalf("an unreadable response must end the invocation: %+v", outcome)
	}
}

func TestRuntimeAPIRestoreErrorIsNotEnabled(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, runtimeRestoreError, nil)
	api.serveHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("restore error: %d", recorder.Code)
	}
}

func TestRuntimeAPIInvokeHonorsACanceledContext(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, result := api.Invoke(ctx, []byte(`{}`)); result.err == nil {
		t.Fatal("a canceled invocation must be reported")
	}
}

func TestRuntimeAPIStreamingReadErrorFailsTheInvocation(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	sink := &recordingSink{chunks: make(chan []byte, 4)}
	done := make(chan runtimeInvocationResult, 1)
	go func() {
		_, result := api.InvokeStream(context.Background(), []byte(`{}`), sink)
		done <- result
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		runtimeAPIVersionPath+"/invocation/"+requestID+"/response", errorReader{err: errors.New("stream broke")})
	request.TransferEncoding = []string{"chunked"}
	request.Header.Set(runtimeResponseModeHeader, runtimeStreamingValue)
	request.Header.Set("Content-Type", "text/event-stream")
	recorder := httptest.NewRecorder()
	api.serveHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("streaming read error: %d", recorder.Code)
	}
	result := <-done
	if !result.reset || result.err == nil {
		t.Fatalf("a broken stream must replace the environment: %+v", result)
	}
}

func TestRuntimeAPIStreamingSinkErrorIsRefused(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	sink := &failingSink{}
	done := make(chan runtimeInvocationResult, 1)
	go func() {
		_, result := api.InvokeStream(context.Background(), []byte(`{}`), sink)
		done <- result
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		runtimeAPIVersionPath+"/invocation/"+requestID+"/response", strings.NewReader("chunk"))
	request.TransferEncoding = []string{"chunked"}
	request.Header.Set(runtimeResponseModeHeader, runtimeStreamingValue)
	request.Header.Set("Content-Type", "text/event-stream")
	recorder := httptest.NewRecorder()
	api.serveHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("a client disconnect still completes the invocation: %d", recorder.Code)
	}
	if result := <-done; result.err == nil || result.reset {
		t.Fatalf("a sink failure must not replace the environment: %+v", result)
	}
}

func TestRuntimeAPIRejectsASecondResponse(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	go func() { _, _ = api.Invoke(context.Background(), []byte(`{}`)) }()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	first := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/response", []byte(`{}`), nil)
	if first.status != http.StatusAccepted {
		t.Fatalf("first response: %d", first.status)
	}
	second := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/response", []byte(`{}`), nil)
	if second.status != http.StatusInternalServerError {
		t.Fatalf("a second answer must be a container error: %d", second.status)
	}
}

type failingSink struct{}

func (f *failingSink) Start(string, bool) error { return nil }
func (f *failingSink) Chunk([]byte) error       { return errors.New("client gone") }
func (f *failingSink) End(string, []byte) error { return nil }

func TestFunctionURLOriginFetchStreamRefusesABadSignature(t *testing.T) {
	origin := &functionURLOrigin{
		originID:   "origin",
		urlID:      "url",
		domainName: "abc.lambda-url.us-east-1.on.aws",
		authType:   "AWS_IAM",
		invoker:    &fakeStreamInvoker{},
		signer:     &localOACSigner{accessKey: "AKIA", secretKey: "secret", region: LocalRegion},
		verifyFn: func(*signedRequest) error {
			return errors.New("signature mismatch")
		},
	}
	stream, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest())
	if err != nil {
		t.Fatalf("refusal: %v", err)
	}
	if stream.StatusCode != http.StatusForbidden {
		t.Fatalf("refused signature: %d", stream.StatusCode)
	}
	body, _ := io.ReadAll(stream.Body) //nolint:errcheck // test
	if !strings.Contains(string(body), "did not verify") {
		t.Fatalf("refusal body: %q", body)
	}
}

func TestFunctionURLOriginFetchStreamHonorsACanceledContext(t *testing.T) {
	blocking := &blockingStreamInvoker{release: make(chan struct{})}
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization, invoker: blocking}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := origin.FetchStream(ctx, localcloudfrontOriginRequest()); err == nil {
		t.Fatal("a canceled request must not wait for the stream")
	}
	close(blocking.release)
}

// blockingStreamInvoker never produces a head until it is released.
type blockingStreamInvoker struct{ release chan struct{} }

func (b *blockingStreamInvoker) Invoke(context.Context, []byte) ([]byte, error) { return nil, nil }
func (b *blockingStreamInvoker) StreamingIncremental() bool                     { return true }
func (b *blockingStreamInvoker) InvokeStream(ctx context.Context, _ []byte, _ StreamSink) (InvokeStreamResult, error) {
	select {
	case <-b.release:
	case <-ctx.Done():
	}
	return InvokeStreamResult{}, ctx.Err()
}

func TestFunctionURLPipeSinkReportsAWriterError(t *testing.T) {
	reader, writer := io.Pipe()
	_ = reader.Close() //nolint:errcheck // the reader is gone
	head := make(chan streamHead, 1)
	sink := &functionURLPipeSink{writer: writer, head: head}
	_ = sink.Start("application/octet-stream", true) //nolint:errcheck // test setup
	if err := sink.Chunk([]byte("data")); err == nil {
		t.Fatal("a closed pipe must report the write error")
	}
}

func TestFunctionURLPipeSinkEndDecodesTheBufferedBody(t *testing.T) {
	reader, writer := io.Pipe()
	head := make(chan streamHead, 1)
	sink := &functionURLPipeSink{writer: writer, head: head}
	go func() {
		_, _ = io.Copy(io.Discard, reader) //nolint:errcheck // test
	}()
	_ = sink.Start("application/json", false)              //nolint:errcheck // test setup
	_ = sink.Chunk([]byte(`{"statusCode":204,"body":""}`)) //nolint:errcheck // test
	_ = sink.End("", nil)                                  //nolint:errcheck // test
	_ = writer.Close()                                     //nolint:errcheck // end of stream
	result := <-head
	if result.status != http.StatusNoContent {
		t.Fatalf("buffered head: %+v", result)
	}
}

func TestFunctionURLPipeSinkEndForwardsAnUndecodableBody(t *testing.T) {
	reader, writer := io.Pipe()
	head := make(chan streamHead, 1)
	sink := &functionURLPipeSink{writer: writer, head: head}
	sink.buffered = []byte("not json")
	go func() {
		_, _ = io.Copy(io.Discard, reader) //nolint:errcheck // test
	}()
	_ = sink.End("", nil) //nolint:errcheck // test
	_ = writer.Close()    //nolint:errcheck // end of stream
	result := <-head
	if result.status != http.StatusOK || result.header.Get("Content-Type") != streamIntegrationContentType {
		t.Fatalf("undecodable head: %+v", result)
	}
}

func TestRuntimeAPIAccessorsOnAnEmptyAPI(t *testing.T) {
	var nilAPI *runtimeAPI
	if nilAPI.HostURL() != "" || nilAPI.ContainerAddress() != "" {
		t.Fatal("a nil API has no address")
	}
	nilAPI.close()
	empty := &runtimeAPI{}
	if empty.HostURL() != "" || empty.ContainerAddress() != "" {
		t.Fatal("an API without a listener has no address")
	}
	var failure *RuntimeAPIError
	empty.recordInitFailure(failure)
	if empty.initError() != nil {
		t.Fatal("a nil failure is ignored")
	}
}

func TestRuntimeAPIDefaultsAThreeSecondTimeout(t *testing.T) {
	api := testRuntimeAPI(t, 0)
	if got := api.functionTimeout(); got != 3*time.Second {
		t.Fatalf("default timeout: %s", got)
	}
}

func TestRuntimeAPIInvokeStopsWhenTheCallerCancels(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan runtimeInvocationResult, 1)
	go func() {
		_, outcome := api.Invoke(ctx, []byte(`{}`))
		result <- outcome
	}()
	_ = nextInvocation(t, api)
	cancel()
	select {
	case outcome := <-result:
		if outcome.err == nil {
			t.Fatal("a canceled invocation must be reported")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the canceled invocation did not return")
	}
}

func TestRuntimeAPIInitErrorFailsAPendingInvocation(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	result := make(chan []byte, 1)
	go func() {
		body, _ := api.Invoke(context.Background(), []byte(`{}`))
		result <- body
	}()
	// Wait until the invocation is queued, then report an init error without a
	// /next call.
	time.Sleep(50 * time.Millisecond)
	failure := []byte(`{"errorMessage":"init failed","errorType":"RuntimeError"}`)
	response := postRuntime(t, api, runtimeInitErrorPath, failure, http.Header{runtimeErrorTypeHeader: {"RuntimeError"}})
	if response.status != http.StatusAccepted {
		t.Fatalf("init error: %d", response.status)
	}
	if body := <-result; string(body) != string(failure) {
		t.Fatalf("pending invocation: %s", body)
	}
}

func TestRuntimeAPIRejectsAnUnknownInvocationSuffix(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	response := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/req/other", nil, nil)
	if response.status != http.StatusNotFound {
		t.Fatalf("unknown suffix: %d", response.status)
	}
}

func TestRuntimeAPIStreamingSinkStartErrorIsRefused(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	done := make(chan runtimeInvocationResult, 1)
	go func() {
		_, outcome := api.InvokeStream(context.Background(), []byte(`{}`), &startFailingSink{})
		done <- outcome
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		runtimeAPIVersionPath+"/invocation/"+requestID+"/response", strings.NewReader("chunk"))
	request.TransferEncoding = []string{"chunked"}
	request.Header.Set(runtimeResponseModeHeader, runtimeStreamingValue)
	request.Header.Set("Content-Type", "text/event-stream")
	recorder := httptest.NewRecorder()
	api.serveHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("a client disconnect still completes the invocation: %d", recorder.Code)
	}
	if outcome := <-done; outcome.err == nil || outcome.reset {
		t.Fatalf("a failed sink start must not replace the environment: %+v", outcome)
	}
}

type startFailingSink struct{ recordingSink }

func (s *startFailingSink) Start(string, bool) error { return errors.New("client gone") }

func TestRuntimeAPIMidstreamTrailerDecodeFailureKeepsTheRawBody(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	result := make(chan runtimeInvocationResult, 1)
	go func() {
		_, outcome := api.InvokeStream(context.Background(), []byte(`{}`), nil)
		result <- outcome
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		runtimeAPIVersionPath+"/invocation/"+requestID+"/response", strings.NewReader("body"))
	request.TransferEncoding = []string{"chunked"}
	request.Header.Set(runtimeResponseModeHeader, runtimeStreamingValue)
	request.Trailer = http.Header{runtimeErrorBodyTrailer: {"not base64!"}, runtimeErrorTypeHeader: {"Error"}}
	recorder := httptest.NewRecorder()
	api.serveHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("trailer response: %d", recorder.Code)
	}
	outcome := <-result
	if string(outcome.errorBody) != "not base64!" {
		t.Fatalf("raw trailer body: %q", outcome.errorBody)
	}
}

func TestRuntimeAPIInvocationErrorReadFailureIsRefused(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	go func() { _, _ = api.Invoke(context.Background(), []byte(`{}`)) }()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		runtimeAPIVersionPath+"/invocation/"+requestID+"/error", errorReader{err: errors.New("broken body")})
	recorder := httptest.NewRecorder()
	api.serveHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unreadable invocation error: %d", recorder.Code)
	}
}

func TestRuntimeInvocationFinishIsIdempotent(t *testing.T) {
	invocation := &runtimeInvocation{done: make(chan struct{})}
	invocation.finish(runtimeInvocationResult{body: []byte("first")})
	invocation.finish(runtimeInvocationResult{body: []byte("second")})
	if string(invocation.result.body) != "first" {
		t.Fatalf("the first result wins: %q", invocation.result.body)
	}
}

func TestRuntimeAPIStreamingWithANonChunkedEncodingStaysBuffered(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	go func() { _, _ = api.Invoke(context.Background(), []byte(`{}`)) }()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		runtimeAPIVersionPath+"/invocation/"+requestID+"/response", strings.NewReader(`{"statusCode":200}`))
	request.Header.Set("Content-Type", "text/plain")
	request.TransferEncoding = []string{"gzip"}
	recorder := httptest.NewRecorder()
	api.serveHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("buffered response: %d", recorder.Code)
	}
}

func TestFunctionProcessURLAndResetErrors(t *testing.T) {
	if (&FunctionProcess{}).URL() != "" {
		t.Fatal("a process without a published port has no RIE URL")
	}
	process := &FunctionProcess{Function: FunctionSpec{LogicalID: "Fn"}, needsReset: true, reset: func(context.Context, *FunctionProcess) error {
		return errors.New("pull failed")
	}}
	if err := process.ensureFresh(context.Background()); err == nil {
		t.Fatal("a failed replacement must be reported")
	}
	process.reset = nil
	if err := process.ensureFresh(context.Background()); err != nil {
		t.Fatalf("no reset function means nothing to do: %v", err)
	}
}

func TestStreamFrameDecoderIgnoresTrailingFrames(t *testing.T) {
	decoder := &streamFrameDecoder{}
	decoder.Feed([]byte(`{}` + string(streamFrameDelimiter) + "one"))
	if got := decoder.Feed([]byte("two")); string(got) != "two" {
		t.Fatalf("after the prelude every chunk is payload: %q", got)
	}
}

func TestTransportStreamingErrorAfterTheHeadKeepsThePartialBody(t *testing.T) {
	invoker := &failingAfterHeadInvoker{}
	api := APISpec{Class: APIFunctionURL, LogicalID: "Url", Routes: []Route{{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn", Streaming: true}}}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf))
	defer server.Close()
	response, err := http.Get(server.URL + "/") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	body, _ := io.ReadAll(response.Body)         //nolint:errcheck // test
	if response.StatusCode != http.StatusOK || string(body) != "partial" {
		t.Fatalf("partial stream: %d %q", response.StatusCode, body)
	}
}

type failingAfterHeadInvoker struct{}

func (f *failingAfterHeadInvoker) Invoke(context.Context, []byte) ([]byte, error) {
	return nil, errors.New("no")
}

func (f *failingAfterHeadInvoker) StreamingIncremental() bool { return true }

func (f *failingAfterHeadInvoker) InvokeStream(_ context.Context, _ []byte, sink StreamSink) (InvokeStreamResult, error) {
	if err := sink.Start("text/plain", true); err != nil {
		return InvokeStreamResult{}, err
	}
	_ = sink.Chunk([]byte("partial")) //nolint:errcheck // the transport records the bytes
	return InvokeStreamResult{Body: []byte("partial"), Streamed: true}, errors.New("runtime died")
}

// framedThenFailingInvoker sends a valid REST prelude and payload, then fails.
type framedThenFailingInvoker struct{}

func (f *framedThenFailingInvoker) Invoke(context.Context, []byte) ([]byte, error) {
	return nil, errors.New("no")
}

func (f *framedThenFailingInvoker) StreamingIncremental() bool { return true }

func (f *framedThenFailingInvoker) InvokeStream(_ context.Context, _ []byte, sink StreamSink) (InvokeStreamResult, error) {
	if err := sink.Start(streamIntegrationContentType, true); err != nil {
		return InvokeStreamResult{}, err
	}
	_ = sink.Chunk([]byte(`{"statusCode":200}` + string(streamFrameDelimiter) + "partial")) //nolint:errcheck // the transport records the bytes
	return InvokeStreamResult{Body: []byte("partial"), Streamed: true}, errors.New("runtime died")
}

func TestTransportStreamingRESTErrorAfterTheHeadKeepsThePartialBody(t *testing.T) {
	invoker := &framedThenFailingInvoker{}
	api := APISpec{Class: APIRESTV1, LogicalID: "Api", Routes: []Route{{Method: "GET", Path: "/sse", Function: "Fn", Streaming: true}}}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf))
	defer server.Close()
	response, err := http.Get(server.URL + "/sse") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != http.StatusOK {
		t.Fatalf("a failure after the head must not rewrite the status: %d", response.StatusCode)
	}
	_, _ = io.ReadAll(response.Body) //nolint:errcheck // test
}

func TestTransportRefusesAnUndecodableBufferedStreamBody(t *testing.T) {
	invoker := &fakeStreamInvoker{contentType: "application/json", streamed: false, chunks: [][]byte{[]byte("not json")}}
	api := APISpec{Class: APIFunctionURL, LogicalID: "Url", Routes: []Route{{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn", Streaming: true}}}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf))
	defer server.Close()
	response, err := http.Get(server.URL + "/") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("an undecodable buffered body must be 502: %d", response.StatusCode)
	}
}

func TestRuntimeAPINextWhenClosed(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	api.close()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, runtimeNextPath, nil)
	api.serveNext(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("a closed API must refuse a long poll: %d", recorder.Code)
	}
}

func TestRuntimeAPIInvokeWhenClosed(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	api.pending <- &runtimeInvocation{done: make(chan struct{})}
	api.close()
	body, result := api.Invoke(context.Background(), []byte(`{}`))
	if len(body) == 0 || !result.reset || result.err == nil {
		t.Fatalf("a closed API must fail the invocation: %s %+v", body, result)
	}
}

func TestFunctionURLOriginFetchStreamNeedsASignerForAWSIAM(t *testing.T) {
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: "AWS_IAM", invoker: &fakeStreamInvoker{}}
	if _, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest()); err == nil {
		t.Fatal("an AWS_IAM Function URL without a signer must be unavailable")
	}
}

func TestFunctionProcessCloseRuntimeAPIWithoutOne(t *testing.T) {
	process := &FunctionProcess{}
	process.closeRuntimeAPI()
	if process.api != nil {
		t.Fatal("closing a missing runtime API is a no-op")
	}
}

func TestFunctionProcessResetWithoutAFunction(t *testing.T) {
	process := &FunctionProcess{Function: FunctionSpec{LogicalID: "Fn"}, needsReset: true}
	if err := process.resetNow(context.Background()); err != nil {
		t.Fatalf("a process with no reset function is already fresh: %v", err)
	}
}

func TestFunctionURLStreamEmptyWritesAreNoOps(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &functionURLStream{writer: recorder, flusher: recorder}
	sink.start(http.StatusOK, "")
	sink.start(http.StatusTeapot, "ignored")
	if err := sink.write(nil); err != nil {
		t.Fatal(err)
	}
	if recorder.status != http.StatusOK || recorder.body.Len() != 0 {
		t.Fatalf("empty write: %d %q", recorder.status, recorder.body.String())
	}
}

func TestFunctionURLStreamInvalidPreludeIsRaw(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &functionURLStream{writer: recorder, flusher: recorder}
	if err := sink.Start(streamIntegrationContentType, true); err != nil {
		t.Fatal(err)
	}
	if err := sink.Chunk(bytes.Repeat([]byte("x"), streamFrameMetadataMax+1)); err != nil {
		t.Fatal(err)
	}
	if recorder.status != http.StatusOK || recorder.body.Len() != streamFrameMetadataMax+1 {
		t.Fatalf("invalid prelude: %d %q", recorder.status, recorder.body.String())
	}
}

func TestFunctionURLStreamInvalidMetadataIsRaw(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &functionURLStream{writer: recorder, flusher: recorder}
	if err := sink.Start(streamIntegrationContentType, true); err != nil {
		t.Fatal(err)
	}
	if err := sink.Chunk([]byte("{not-json" + string(streamFrameDelimiter) + "payload")); err != nil {
		t.Fatal(err)
	}
	if recorder.status != http.StatusOK || recorder.body.String() != "payload" {
		t.Fatalf("invalid metadata: %d %q", recorder.status, recorder.body.String())
	}
}

func TestFunctionURLStreamWaitsForTheWholePrelude(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &functionURLStream{writer: recorder, flusher: recorder}
	if err := sink.Start(streamIntegrationContentType, true); err != nil {
		t.Fatal(err)
	}
	if err := sink.Chunk([]byte(`{"statusCode":200}`)); err != nil {
		t.Fatal(err)
	}
	if recorder.status != 0 {
		t.Fatalf("a partial prelude must not start the response: %d", recorder.status)
	}
	if err := sink.Chunk([]byte(string(streamFrameDelimiter) + "payload")); err != nil {
		t.Fatal(err)
	}
	if recorder.status != http.StatusOK || recorder.body.String() != "payload" {
		t.Fatalf("completed prelude: %d %q", recorder.status, recorder.body.String())
	}
}

func TestAPIGatewayStreamForwardsChunksAfterThePrelude(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &apiGatewayStream{writer: recorder, flusher: recorder}
	if err := sink.Start("", true); err != nil {
		t.Fatal(err)
	}
	if err := sink.Chunk([]byte(`{"statusCode":200}` + string(streamFrameDelimiter) + "one")); err != nil {
		t.Fatal(err)
	}
	if err := sink.Chunk([]byte("two")); err != nil {
		t.Fatal(err)
	}
	if err := sink.write(nil); err != nil {
		t.Fatal(err)
	}
	if recorder.body.String() != "onetwo" {
		t.Fatalf("payload: %q", recorder.body.String())
	}
}

func TestAPIGatewayStreamRejectsInvalidMetadata(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &apiGatewayStream{writer: recorder, flusher: recorder}
	if err := sink.Start("", true); err != nil {
		t.Fatal(err)
	}
	if err := sink.Chunk([]byte("{not-json" + string(streamFrameDelimiter) + "payload")); err != nil {
		t.Fatal(err)
	}
	if err := sink.End("", nil); err == nil {
		t.Fatal("invalid metadata must be refused")
	}
}
