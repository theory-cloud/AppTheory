package localrunner

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

// fakeStreamInvoker is an Invoker that answers through the streaming path.
type fakeStreamInvoker struct {
	contentType string
	streamed    bool
	chunks      [][]byte
	delay       time.Duration
	err         error
	requests    int
}

func (f *fakeStreamInvoker) Invoke(context.Context, []byte) ([]byte, error) {
	var body bytes.Buffer
	for _, chunk := range f.chunks {
		body.Write(chunk)
	}
	return body.Bytes(), f.err
}

func (f *fakeStreamInvoker) InvokeStream(ctx context.Context, _ []byte, sink StreamSink) (InvokeStreamResult, error) {
	f.requests++
	if f.err != nil {
		return InvokeStreamResult{}, f.err
	}
	var body bytes.Buffer
	if err := sink.Start(f.contentType, f.streamed); err != nil {
		return InvokeStreamResult{}, err
	}
	for _, chunk := range f.chunks {
		select {
		case <-ctx.Done():
			return InvokeStreamResult{}, ctx.Err()
		default:
		}
		if f.delay > 0 {
			time.Sleep(f.delay)
		}
		body.Write(chunk)
		if err := sink.Chunk(chunk); err != nil {
			return InvokeStreamResult{}, err
		}
	}
	_ = sink.End("", nil) //nolint:errcheck // the transport reports a format error itself
	return InvokeStreamResult{Body: body.Bytes(), Streamed: f.streamed, ContentType: f.contentType}, nil
}

func (f *fakeStreamInvoker) StreamingIncremental() bool { return true }

func localcloudfrontOriginRequest() localcloudfront.OriginRequest {
	return localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/", Host: "abc.lambda-url.us-east-1.on.aws"}
}

func framedChunks(metadata string, payloads ...string) [][]byte {
	chunks := make([][]byte, 0, len(payloads))
	for index, payload := range payloads {
		if index == 0 {
			chunks = append(chunks, []byte(metadata+string(streamFrameDelimiter)+payload))
			continue
		}
		chunks = append(chunks, []byte(payload))
	}
	return chunks
}

func TestFunctionURLOriginFetchStreamAppliesThePrelude(t *testing.T) {
	invoker := &fakeStreamInvoker{
		contentType: streamIntegrationContentType,
		streamed:    true,
		chunks:      framedChunks(`{"statusCode":202,"headers":{"x-case":"yes","content-type":"text/event-stream"},"cookies":["a=1"]}`, "one\n", "two\n"),
	}
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization, invoker: invoker}
	stream, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest())
	if err != nil {
		t.Fatalf("fetch stream: %v", err)
	}
	if stream.StatusCode != 202 || !stream.Chunked {
		t.Fatalf("head: %d chunked=%v", stream.StatusCode, stream.Chunked)
	}
	if stream.Header.Get("x-case") != "yes" || stream.Header.Get("Set-Cookie") != "a=1" {
		t.Fatalf("headers: %v", stream.Header)
	}
	body, err := io.ReadAll(stream.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "one\ntwo\n" {
		t.Fatalf("body: %q", body)
	}
}

func TestFunctionURLOriginFetchStreamWithoutAPreludeIsRaw(t *testing.T) {
	invoker := &fakeStreamInvoker{
		contentType: "application/octet-stream",
		streamed:    true,
		chunks:      [][]byte{[]byte("raw"), []byte("-bytes")},
	}
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization, invoker: invoker}
	stream, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest())
	if err != nil {
		t.Fatalf("fetch stream: %v", err)
	}
	if stream.Header.Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("content type: %q", stream.Header.Get("Content-Type"))
	}
	body, _ := io.ReadAll(stream.Body) //nolint:errcheck // test
	if string(body) != "raw-bytes" {
		t.Fatalf("body: %q", body)
	}
}

func TestFunctionURLOriginFetchStreamDecodesABufferedResponse(t *testing.T) {
	invoker := &fakeStreamInvoker{
		contentType: "application/json",
		streamed:    false,
		chunks:      [][]byte{[]byte(`{"statusCode":201,"headers":{"x-case":"buffered"},"body":"hello"}`)},
	}
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization, invoker: invoker}
	stream, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest())
	if err != nil {
		t.Fatalf("fetch stream: %v", err)
	}
	if stream.StatusCode != 201 || stream.Header.Get("x-case") != "buffered" {
		t.Fatalf("head: %d %v", stream.StatusCode, stream.Header)
	}
	body, _ := io.ReadAll(stream.Body) //nolint:errcheck // test
	if string(body) != "hello" {
		t.Fatalf("body: %q", body)
	}
}

func TestFunctionURLOriginFetchStreamRefusesANonStreamingInvoker(t *testing.T) {
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization, invoker: &recordingInvoker{response: []byte(`{"statusCode":200}`)}}
	if _, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest()); err == nil {
		t.Fatal("a non-streaming invoker must be refused")
	}
}

func TestFunctionURLOriginFetchStreamReportsAStreamError(t *testing.T) {
	invoker := &fakeStreamInvoker{contentType: streamIntegrationContentType, streamed: true, err: errors.New("runtime exploded")}
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization, invoker: invoker}
	_, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest())
	if err == nil || !strings.Contains(err.Error(), "runtime exploded") {
		t.Fatalf("stream error: %v", err)
	}
}

func TestTransportStreamsAFunctionURLResponse(t *testing.T) {
	invoker := &fakeStreamInvoker{
		contentType: streamIntegrationContentType,
		streamed:    true,
		chunks:      framedChunks(`{"statusCode":200,"headers":{"content-type":"text/event-stream"}}`, "one\n", "two\n"),
		delay:       150 * time.Millisecond,
	}
	api := APISpec{Class: APIFunctionURL, LogicalID: "Url", Routes: []Route{{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn", Streaming: true}}}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf))
	defer server.Close()
	started := time.Now()
	response, err := http.Get(server.URL + "/") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("head: %d %v", response.StatusCode, response.Header)
	}
	buffer := make([]byte, 32)
	n, err := response.Body.Read(buffer)
	if err != nil {
		t.Fatal(err)
	}
	first := time.Since(started)
	if !strings.HasPrefix(string(buffer[:n]), "one") || first > 300*time.Millisecond {
		t.Fatalf("first chunk %q after %s", buffer[:n], first)
	}
	rest, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(rest) != "two\n" {
		t.Fatalf("rest: %q", rest)
	}
}

func TestTransportStreamsARESTResponse(t *testing.T) {
	invoker := &fakeStreamInvoker{
		contentType: streamIntegrationContentType,
		streamed:    true,
		chunks:      framedChunks(`{"statusCode":201,"multiValueHeaders":{"x-multi":["a","b"]},"cookies":["c=1"]}`, "payload"),
	}
	api := APISpec{Class: APIRESTV1, LogicalID: "Api", Routes: []Route{{Method: "GET", Path: "/sse", Function: "Fn", Streaming: true}}}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf))
	defer server.Close()
	response, err := http.Get(server.URL + "/sse") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	body, _ := io.ReadAll(response.Body)         //nolint:errcheck // test
	if response.StatusCode != 201 || string(body) != "payload" {
		t.Fatalf("response: %d %q", response.StatusCode, body)
	}
	if values := response.Header.Values("x-multi"); len(values) != 2 {
		t.Fatalf("multi-value headers: %v", values)
	}
	if response.Header.Get("Set-Cookie") != "c=1" {
		t.Fatalf("cookie: %v", response.Header)
	}
}

func TestTransportRefusesARESTStreamWithoutAPrelude(t *testing.T) {
	invoker := &fakeStreamInvoker{contentType: "text/plain", streamed: true, chunks: [][]byte{[]byte("not framed")}}
	api := APISpec{Class: APIRESTV1, LogicalID: "Api", Routes: []Route{{Method: "GET", Path: "/sse", Function: "Fn", Streaming: true}}}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf))
	defer server.Close()
	response, err := http.Get(server.URL + "/sse") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("a REST stream without a prelude must be 500: %d", response.StatusCode)
	}
}

func TestChunkEventWriterWritesOnlyStreamedChunks(t *testing.T) {
	var output bytes.Buffer
	writer := &chunkEventWriter{writer: newBufferedWriter(&output), invocation: 2}
	if err := writer.Start("application/json", false); err != nil {
		t.Fatal(err)
	}
	if err := writer.Chunk([]byte("buffered")); err != nil {
		t.Fatal(err)
	}
	if output.Len() != 0 {
		t.Fatalf("a buffered response must not write a chunk event: %s", output.String())
	}
	if err := writer.Start("text/event-stream", true); err != nil {
		t.Fatal(err)
	}
	if err := writer.Chunk([]byte("one")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Chunk([]byte("two")); err != nil {
		t.Fatal(err)
	}
	if err := writer.End("", nil); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("chunk lines: %v", lines)
	}
	var event chunkEvent
	if err := json.Unmarshal([]byte(lines[1]), &event); err != nil {
		t.Fatal(err)
	}
	if event.Event != "chunk" || event.Invocation != 2 || event.Index != 1 || event.ContentType != "text/event-stream" {
		t.Fatalf("chunk event: %+v", event)
	}
	if data, err := base64.StdEncoding.DecodeString(event.Data); err != nil || string(data) != "two" {
		t.Fatalf("chunk data: %q %v", data, err)
	}
}

func TestEncodeInvokeResultModes(t *testing.T) {
	result := InvokeResult{Proxy: true, StatusCode: 200, Body: "ok"}
	plain, err := encodeInvokeResult(result, false, 1)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(plain), `"event"`) {
		t.Fatalf("the default protocol must not add an event field: %s", plain)
	}
	withEvents, err := encodeInvokeResult(result, true, 3)
	if err != nil {
		t.Fatal(err)
	}
	var decoded resultEvent
	if err := json.Unmarshal(withEvents, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Event != "result" || decoded.Invocation != 3 || decoded.StatusCode != 200 {
		t.Fatalf("result event: %+v", decoded)
	}
}

func TestCloneEnvironmentIsIndependent(t *testing.T) {
	original := map[string]string{"A": "1"}
	cloned := cloneEnvironment(original)
	cloned["A"] = "2"
	if original["A"] != "1" {
		t.Fatal("cloneEnvironment must copy the map")
	}
}

func TestDockerExitCode(t *testing.T) {
	docker := fakeDocker(map[string]string{
		"docker inspect --format {{.State.ExitCode}} fn": "7\n",
	})
	code, err := docker.ExitCode(context.Background(), "fn")
	if err != nil || code != 7 {
		t.Fatalf("exit code: %d %v", code, err)
	}
	broken := &Docker{exec: func(context.Context, []string) (string, string, error) {
		return "", "no such container", errors.New("exit status 1")
	}}
	if _, err := broken.ExitCode(context.Background(), "fn"); err == nil {
		t.Fatal("an inspect failure must be reported")
	}
}

func TestWaitForRuntimeAPIReadySeesTheFirstNext(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	docker := fakeDocker(map[string]string{
		"docker inspect --format {{.State.Running}} fn": "true\n",
	})
	go func() {
		response, err := http.Get(api.HostURL() + runtimeNextPath) //nolint:noctx // a test client
		if err == nil {
			_ = response.Body.Close() //nolint:errcheck // test cleanup
		}
	}()
	if err := waitForRuntimeAPIReady(context.Background(), docker, "fn", api); err != nil {
		t.Fatalf("ready: %v", err)
	}
}

func TestWaitForRuntimeAPIReadyRecordsAStartupFailure(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	docker := fakeDocker(map[string]string{
		"docker inspect --format {{.State.Running}} fn":  "false\n",
		"docker inspect --format {{.State.ExitCode}} fn": "3\n",
		"docker logs --tail 60 fn":                       "bootstrap: refused to start\n",
	})
	if err := waitForRuntimeAPIReady(context.Background(), docker, "fn", api); err != nil {
		t.Fatalf("a startup failure is reported on the first invocation, not here: %v", err)
	}
	failure := api.initError()
	if failure == nil || failure.Type != "Runtime.ExitError" || !strings.Contains(failure.Message, "exit status 3") {
		t.Fatalf("startup failure: %#v", failure)
	}
	body, result := api.Invoke(context.Background(), []byte(`{}`))
	if len(body) == 0 || !result.reset {
		t.Fatalf("the recorded failure must fail the invocation: %s %+v", body, result)
	}
}

func TestResetFunctionReplacesTheEnvironment(t *testing.T) {
	oldAPI := testRuntimeAPI(t, 30)
	process := &FunctionProcess{
		Function:  FunctionSpec{LogicalID: "Fn", Timeout: 30},
		Container: "fn",
		api:       oldAPI,
		options:   ContainerOptions{Name: "fn", Image: "image", Env: map[string]string{"AWS_LAMBDA_RUNTIME_API": oldAPI.ContainerAddress()}},
		logf:      t.Logf,
	}
	docker := &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		joined := strings.Join(argv, " ")
		switch {
		case strings.HasPrefix(joined, "docker rm -f"):
			return "", "", nil
		case strings.HasPrefix(joined, "docker run"):
			return "container-id\n", "", nil
		case strings.Contains(joined, "State.Running"):
			return "false\n", "", nil
		case strings.Contains(joined, "State.ExitCode"):
			return "1\n", "", nil
		default:
			return "", "", nil
		}
	}}
	runner := &Runner{docker: docker, invokers: map[string]*FunctionProcess{"Fn": process}, options: Options{Stdout: io.Discard}}
	if err := runner.resetFunction(context.Background(), process); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if process.api == oldAPI || process.api == nil {
		t.Fatal("reset must install a new Runtime API")
	}
	address := process.options.Env["AWS_LAMBDA_RUNTIME_API"]
	if address != process.api.ContainerAddress() || !strings.HasPrefix(address, "host.docker.internal:") {
		t.Fatalf("the replacement container must get the new address: %q", address)
	}
}

func TestFunctionProcessInvokeStreamForwardsChunks(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	process := &FunctionProcess{Function: FunctionSpec{LogicalID: "Fn", Timeout: 30}, Container: "fn", api: api}
	go func() {
		next := nextInvocation(t, api)
		requestID := next.header.Get(runtimeRequestIDHeader)
		request, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
			api.HostURL()+runtimeAPIVersionPath+"/invocation/"+requestID+"/response", strings.NewReader("one\ntwo\n"))
		if err != nil {
			return
		}
		request.ContentLength = -1
		request.Header.Set("Content-Type", "text/event-stream")
		response, err := http.DefaultClient.Do(request)
		if err == nil {
			_ = response.Body.Close() //nolint:errcheck // test cleanup
		}
	}()
	sink := &recordingSink{chunks: make(chan []byte, 4)}
	result, err := process.InvokeStream(context.Background(), []byte(`{}`), sink)
	if err != nil {
		t.Fatalf("invoke stream: %v", err)
	}
	if !result.Streamed || string(result.Body) != "one\ntwo\n" || !sink.started || !sink.ended {
		t.Fatalf("result: %+v sink=%+v", result, sink)
	}
}

func newBufferedWriter(output *bytes.Buffer) *bufio.Writer {
	return bufio.NewWriter(output)
}

func TestTransportStreamsABufferedResponseOnAFunctionURL(t *testing.T) {
	invoker := &fakeStreamInvoker{
		contentType: "application/json",
		streamed:    false,
		chunks:      [][]byte{[]byte(`{"statusCode":202,"headers":{"x-case":"buffered"},"body":"hello"}`)},
	}
	api := APISpec{Class: APIFunctionURL, LogicalID: "Url", Routes: []Route{{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn", Streaming: true}}}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf))
	defer server.Close()
	response, err := http.Get(server.URL + "/") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	body, _ := io.ReadAll(response.Body)         //nolint:errcheck // test
	if response.StatusCode != 202 || string(body) != "hello" || response.Header.Get("x-case") != "buffered" {
		t.Fatalf("buffered Function URL response: %d %q %v", response.StatusCode, body, response.Header)
	}
}

func TestTransportAnswersABadGatewayWhenTheStreamFailsBeforeItsHead(t *testing.T) {
	invoker := &fakeStreamInvoker{contentType: streamIntegrationContentType, streamed: true, err: errors.New("runtime exploded")}
	api := APISpec{Class: APIFunctionURL, LogicalID: "Url", Routes: []Route{{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn", Streaming: true}}}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf))
	defer server.Close()
	response, err := http.Get(server.URL + "/") //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("a stream that fails before its head must be 502: %d", response.StatusCode)
	}
}

// nonFlushingWriter is an http.ResponseWriter without http.Flusher.
type nonFlushingWriter struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (w *nonFlushingWriter) Header() http.Header            { return w.header }
func (w *nonFlushingWriter) WriteHeader(status int)         { w.status = status }
func (w *nonFlushingWriter) Write(data []byte) (int, error) { return w.body.Write(data) }

func TestTransportRefusesToStreamWithoutAFlusher(t *testing.T) {
	invoker := &fakeStreamInvoker{contentType: streamIntegrationContentType, streamed: true, chunks: framedChunks(`{}`, "x")}
	api := APISpec{Class: APIFunctionURL, LogicalID: "Url", Routes: []Route{{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "Fn", Streaming: true}}}
	transport := NewTransport(api, map[string]Invoker{"Fn": invoker}, make(chan struct{}, 1), t.Logf)
	writer := &nonFlushingWriter{header: http.Header{}}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://viewer.example/", nil)
	transport.ServeHTTP(writer, request)
	if writer.status != http.StatusInternalServerError {
		t.Fatalf("a listener without a flusher must fail closed: %d", writer.status)
	}
}

func TestFunctionURLPipeSinkHandlesRawAndInvalidStreams(t *testing.T) {
	reader, writer := io.Pipe()
	head := make(chan streamHead, 1)
	sink := &functionURLPipeSink{writer: writer, head: head}
	go func() {
		_ = sink.Start("application/octet-stream", true) //nolint:errcheck // test setup
		_ = sink.Chunk([]byte("raw"))                    //nolint:errcheck // test
		_ = sink.End("", nil)                            //nolint:errcheck // test
		_ = writer.Close()                               //nolint:errcheck // end of stream
	}()
	result := <-head
	if result.status != http.StatusOK || result.header.Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("raw head: %+v", result)
	}
	body, _ := io.ReadAll(reader) //nolint:errcheck // test
	if string(body) != "raw" {
		t.Fatalf("raw body: %q", body)
	}

	reader, writer = io.Pipe()
	head = make(chan streamHead, 1)
	sink = &functionURLPipeSink{writer: writer, head: head}
	go func() {
		_ = sink.Start(streamIntegrationContentType, true)                         //nolint:errcheck // test setup
		_ = sink.Chunk([]byte("not-json" + string(streamFrameDelimiter) + "body")) //nolint:errcheck // test
		_ = sink.End("", nil)                                                      //nolint:errcheck // test
		_ = writer.Close()                                                         //nolint:errcheck // end of stream
	}()
	result = <-head
	if result.status != http.StatusOK || result.header.Get("Content-Type") != streamIntegrationContentType {
		t.Fatalf("invalid head: %+v", result)
	}
	body, _ = io.ReadAll(reader) //nolint:errcheck // test
	if !strings.Contains(string(body), "not-json") {
		t.Fatalf("invalid body: %q", body)
	}
}

func TestFunctionProcessInvokeStreamRIEMode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"statusCode":200,"body":"rie"}`)) //nolint:errcheck // test
	}))
	defer server.Close()
	process := &FunctionProcess{Container: "fn", Port: serverPort(t, server.URL), rie: true}
	sink := &recordingSink{chunks: make(chan []byte, 2)}
	result, err := process.InvokeStream(context.Background(), []byte(`{}`), sink)
	if err != nil || string(result.Body) != `{"statusCode":200,"body":"rie"}` || !sink.started {
		t.Fatalf("RIE stream: %+v %v", result, err)
	}
	if process.StreamingIncremental() {
		t.Fatal("RIE mode does not stream incrementally")
	}
}

func TestFunctionProcessInvokeStreamRestartsAfterAFailure(t *testing.T) {
	api := testRuntimeAPI(t, 1)
	resets := 0
	process := &FunctionProcess{Function: FunctionSpec{LogicalID: "Fn", Timeout: 1}, Container: "fn", api: api, logf: t.Logf}
	process.reset = func(context.Context, *FunctionProcess) error {
		resets++
		process.api = testRuntimeAPI(t, 30)
		return nil
	}
	sink := &recordingSink{chunks: make(chan []byte, 2)}
	if _, err := process.InvokeStream(context.Background(), []byte(`{}`), sink); err != nil {
		t.Fatalf("invoke stream: %v", err)
	}
	if resets != 1 {
		t.Fatalf("timeout resets: %d", resets)
	}
}

func TestStreamInvocationsWritesChunkEventsWithTheFlag(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	process := &FunctionProcess{Function: FunctionSpec{LogicalID: "Fn", Timeout: 30}, Container: "fn", api: api}
	runner := &Runner{options: Options{StreamChunks: true}}
	go func() {
		next := nextInvocation(t, api)
		requestID := next.header.Get(runtimeRequestIDHeader)
		request, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
			api.HostURL()+runtimeAPIVersionPath+"/invocation/"+requestID+"/response",
			strings.NewReader(`{"statusCode":200,"headers":{"content-type":"text/event-stream"}}`+string(streamFrameDelimiter)+"one\\ntwo\\n"))
		if err != nil {
			return
		}
		request.ContentLength = -1
		request.Header.Set("Content-Type", streamIntegrationContentType)
		response, err := http.DefaultClient.Do(request)
		if err == nil {
			_ = response.Body.Close() //nolint:errcheck // test cleanup
		}
	}()
	var out bytes.Buffer
	if err := runner.streamInvocations(context.Background(), process, strings.NewReader(`{"x":1}`+"\n"), &out); err != nil {
		t.Fatalf("stream invocations: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("want one chunk and one result: %v", lines)
	}
	var chunk chunkEvent
	if err := json.Unmarshal([]byte(lines[0]), &chunk); err != nil || chunk.Event != "chunk" {
		t.Fatalf("chunk line: %v %v", lines[0], err)
	}
	var result resultEvent
	if err := json.Unmarshal([]byte(lines[1]), &result); err != nil || result.Event != "result" || result.StatusCode != 200 {
		t.Fatalf("result line: %v %v", lines[1], err)
	}
}

func TestStreamFrameDecoderSplitAcrossChunks(t *testing.T) {
	decoder := &streamFrameDecoder{}
	metadata := `{"statusCode":201,"headers":{"content-type":"text/event-stream"},"cookies":["a=1"]}`
	stream := metadata + string(streamFrameDelimiter) + "one\n"
	if got := decoder.Feed([]byte(stream[:10])); got != nil {
		t.Fatalf("a partial prelude must not forward bytes: %q", got)
	}
	if got := decoder.Feed([]byte(stream[10:])); string(got) != "one\n" {
		t.Fatalf("payload: %q", got)
	}
	parsed, err := decoder.Metadata()
	if err != nil {
		t.Fatal(err)
	}
	if parsed.StatusCode == nil || *parsed.StatusCode != 201 {
		t.Fatalf("status: %#v", parsed.StatusCode)
	}
	header := http.Header{}
	status := parsed.apply(header)
	if status != 201 || header.Get("Content-Type") != "text/event-stream" || header.Get("Set-Cookie") != "a=1" {
		t.Fatalf("applied: %d %v", status, header)
	}
}

func TestStreamFrameDecoderWithoutADelimiterIsRaw(t *testing.T) {
	decoder := &streamFrameDecoder{}
	got := decoder.Feed(bytes.Repeat([]byte("x"), streamFrameMetadataMax+1))
	if len(got) != streamFrameMetadataMax+1 || decoder.Framed() {
		t.Fatalf("unframed stream: %d framed=%v", len(got), decoder.Framed())
	}
}

func TestFunctionURLStreamForwardsThePreludeThenThePayload(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &functionURLStream{writer: recorder, flusher: recorder}
	metadata := `{"statusCode":202,"headers":{"x-case":"yes"},"cookies":["a=1"]}`
	_ = sink.Start(streamIntegrationContentType, true)                        //nolint:errcheck // test setup
	_ = sink.Chunk([]byte(metadata + string(streamFrameDelimiter) + "first")) //nolint:errcheck // test
	_ = sink.Chunk([]byte("second"))                                          //nolint:errcheck // test
	_ = sink.End("", nil)                                                     //nolint:errcheck // test
	if recorder.status != 202 || recorder.header.Get("x-case") != "yes" || recorder.header.Get("Set-Cookie") != "a=1" {
		t.Fatalf("prelude: %d %v", recorder.status, recorder.header)
	}
	if recorder.body.String() != "firstsecond" {
		t.Fatalf("payload: %q", recorder.body.String())
	}
}

func TestFunctionURLStreamWithoutAPreludeIsARawBody(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &functionURLStream{writer: recorder, flusher: recorder}
	_ = sink.Start("application/octet-stream", true) //nolint:errcheck // test setup
	_ = sink.Chunk([]byte("raw"))                    //nolint:errcheck // test
	_ = sink.End("", nil)                            //nolint:errcheck // test
	if recorder.status != 200 || recorder.body.String() != "raw" {
		t.Fatalf("raw stream: %d %q", recorder.status, recorder.body.String())
	}
	if recorder.header.Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("content type: %q", recorder.header.Get("Content-Type"))
	}
}

func TestAPIGatewayStreamRefusesOutputWithoutAPrelude(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &apiGatewayStream{writer: recorder, flusher: recorder}
	_ = sink.Start("application/json", false)    //nolint:errcheck // test setup
	_ = sink.Chunk([]byte(`{"statusCode":200}`)) //nolint:errcheck // test
	if err := sink.End("", nil); err == nil {
		t.Fatal("a buffered body must fail the streaming format")
	}
}

func TestAPIGatewayStreamAppliesTheMetadata(t *testing.T) {
	recorder := newFlushRecorder()
	sink := &apiGatewayStream{writer: recorder, flusher: recorder}
	metadata := `{"statusCode":200,"multiValueHeaders":{"x-multi":["a","b"]},"cookies":["c=1"]}`
	_ = sink.Start("", true)                                                    //nolint:errcheck // test setup
	_ = sink.Chunk([]byte(metadata + string(streamFrameDelimiter) + "payload")) //nolint:errcheck // test
	if err := sink.End("", nil); err != nil {
		t.Fatalf("valid stream: %v", err)
	}
	if recorder.status != 200 || recorder.body.String() != "payload" {
		t.Fatalf("stream: %d %q", recorder.status, recorder.body.String())
	}
	if values := recorder.header.Values("x-multi"); len(values) != 2 {
		t.Fatalf("multi-value headers: %v", values)
	}
}

func newFlushRecorder() *flushRecorder {
	return &flushRecorder{header: http.Header{}}
}

// flushRecorder is an http.ResponseWriter that records the status, headers and
// body and implements http.Flusher.
type flushRecorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *flushRecorder) Header() http.Header { return r.header }

func (r *flushRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
}

func (r *flushRecorder) Write(data []byte) (int, error) { return r.body.Write(data) }

func (r *flushRecorder) Flush() {}
