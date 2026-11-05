package localrunner

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testRuntimeAPI(t *testing.T, timeout int) *runtimeAPI {
	t.Helper()
	api, err := newRuntimeAPI(FunctionSpec{LogicalID: "Fn", Timeout: timeout}, t.Logf)
	if err != nil {
		t.Fatalf("new runtime API: %v", err)
	}
	t.Cleanup(api.close)
	return api
}

// runtimeResponse is a read and closed Runtime API response.
type runtimeResponse struct {
	status int
	header http.Header
	body   []byte
}

// nextInvocation performs the runtime's GET /next and returns the response.
func nextInvocation(t *testing.T, api *runtimeAPI) runtimeResponse {
	t.Helper()
	response, err := http.Get(api.HostURL() + runtimeNextPath) //nolint:noctx // a test client with no request context
	if err != nil {
		t.Fatalf("GET next: %v", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	body, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		t.Fatalf("read next response: %v", readErr)
	}
	return runtimeResponse{status: response.StatusCode, header: response.Header, body: body}
}

func postRuntime(t *testing.T, api *runtimeAPI, path string, body []byte, header http.Header) runtimeResponse {
	t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, api.HostURL()+path, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	for name, values := range header {
		request.Header[name] = values
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	responseBody, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		t.Fatalf("read %s response: %v", path, readErr)
	}
	return runtimeResponse{status: response.StatusCode, header: response.Header, body: responseBody}
}

func TestRuntimeAPINextCarriesEveryDocumentedHeader(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	result := make(chan []byte, 1)
	go func() {
		body, _ := api.Invoke(context.Background(), []byte(`{"hello":"world"}`))
		result <- body
	}()
	response := nextInvocation(t, api)
	if response.status != http.StatusOK {
		t.Fatalf("next status: %d", response.status)
	}
	if got := response.header.Get(runtimeRequestIDHeader); got == "" {
		t.Fatal("Lambda-Runtime-Aws-Request-Id is missing")
	}
	if got := response.header.Get(runtimeInvocationIDHeader); got == "" {
		t.Fatal("Lambda-Runtime-Invocation-Id is missing")
	}
	if got := response.header.Get(runtimeFunctionARNHeader); got != "arn:aws:lambda:us-east-1:123456789012:function:Fn" {
		t.Fatalf("invoked function ARN: %q", got)
	}
	if got := response.header.Get(runtimeTraceIDHeader); !strings.HasPrefix(got, "Root=1-") || !strings.Contains(got, ";Sampled=0") {
		t.Fatalf("trace id: %q", got)
	}
	deadlineMS, err := strconv.ParseInt(response.header.Get(runtimeDeadlineHeader), 10, 64)
	if err != nil {
		t.Fatalf("deadline header: %v", err)
	}
	if want := time.Now().Add(25 * time.Second).UnixMilli(); deadlineMS < want {
		t.Fatalf("deadline %d is not the function timeout", deadlineMS)
	}
	payload := response.body
	if string(payload) != `{"hello":"world"}` {
		t.Fatalf("event payload: %s", payload)
	}
	// Answer the invocation.
	accepted := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+response.header.Get(runtimeRequestIDHeader)+runtimeResponseSuffix,
		[]byte(`{"statusCode":200,"body":"ok"}`), http.Header{runtimeInvocationIDHeader: {response.header.Get(runtimeInvocationIDHeader)}})
	if accepted.status != http.StatusAccepted {
		t.Fatalf("response status: %d", accepted.status)
	}
	select {
	case body := <-result:
		if string(body) != `{"statusCode":200,"body":"ok"}` {
			t.Fatalf("invoke body: %s", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("invoke did not return")
	}
}

func TestRuntimeAPIRejectsAWrongInvocationIDWith400(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	go func() { _, _ = api.Invoke(context.Background(), []byte(`{}`)) }()
	response := nextInvocation(t, api)
	requestID := response.header.Get(runtimeRequestIDHeader)
	refused := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/response",
		[]byte(`{}`), http.Header{runtimeInvocationIDHeader: {"not-the-invocation"}})
	if refused.status != http.StatusBadRequest {
		t.Fatalf("mismatched invocation id: %d", refused.status)
	}
	body := refused.body
	if !strings.Contains(string(body), runtimeInvocationIDMismatch) {
		t.Fatalf("refusal body: %s", body)
	}
}

func TestRuntimeAPIStreamsChunksAsTheRuntimeWritesThem(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	sink := &recordingSink{chunks: make(chan []byte, 8)}
	go func() { _, _ = api.InvokeStream(context.Background(), []byte(`{}`), sink) }()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)

	reader, writer := io.Pipe()
	postDone := make(chan *http.Response, 1)
	go func() {
		request, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
			api.HostURL()+runtimeAPIVersionPath+"/invocation/"+requestID+"/response", reader)
		if err != nil {
			postDone <- nil
			return
		}
		request.Header.Set(runtimeResponseModeHeader, runtimeStreamingValue)
		request.Header.Set("Content-Type", "text/event-stream")
		request.Trailer = http.Header{runtimeErrorTypeHeader: nil, runtimeErrorBodyTrailer: nil}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			postDone <- nil
			return
		}
		defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
		postDone <- response
	}()
	if _, err := writer.Write([]byte("one\n")); err != nil {
		t.Fatalf("write first chunk: %v", err)
	}
	first := <-sink.chunks
	if string(first) != "one\n" {
		t.Fatalf("first chunk: %q", first)
	}
	if _, err := writer.Write([]byte("two\n")); err != nil {
		t.Fatalf("write second chunk: %v", err)
	}
	if second := <-sink.chunks; string(second) != "two\n" {
		t.Fatalf("second chunk: %q", second)
	}
	_ = writer.Close() //nolint:errcheck // end of stream
	response := <-postDone
	if response == nil || response.StatusCode != http.StatusAccepted {
		t.Fatalf("streaming response was not accepted: %#v", response)
	}
	if !sink.started || !sink.ended {
		t.Fatalf("sink did not see start/end: %+v", sink)
	}
	if sink.body.String() != "one\ntwo\n" {
		t.Fatalf("collected body: %q", sink.body.String())
	}
}

func TestRuntimeAPIMidstreamErrorTrailersAreReported(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	sink := &recordingSink{chunks: make(chan []byte, 8)}
	result := make(chan runtimeInvocationResult, 1)
	go func() {
		_, outcome := api.InvokeStream(context.Background(), []byte(`{}`), sink)
		result <- outcome
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	trailerBody := base64.StdEncoding.EncodeToString([]byte(`{"errorType":"Error","errorMessage":"boom"}`))
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		api.HostURL()+runtimeAPIVersionPath+"/invocation/"+requestID+"/response",
		strings.NewReader("partial"))
	if err != nil {
		t.Fatal(err)
	}
	request.ContentLength = -1 // force chunked encoding
	request.Header.Set(runtimeResponseModeHeader, runtimeStreamingValue)
	request.Header.Set("Content-Type", "text/event-stream")
	request.Trailer = http.Header{
		runtimeErrorTypeHeader:  {"Error"},
		runtimeErrorBodyTrailer: {trailerBody},
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("streaming POST: %v", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("streaming POST status: %d", response.StatusCode)
	}
	if chunk := <-sink.chunks; string(chunk) != "partial" {
		t.Fatalf("chunk: %q", chunk)
	}
	outcome := <-result
	if outcome.errorType != "Error" || !strings.Contains(string(outcome.errorBody), "boom") {
		t.Fatalf("trailers: %q %s", outcome.errorType, outcome.errorBody)
	}
}

func TestRuntimeAPIErrorBodyIsTheInvokePayload(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	result := make(chan []byte, 1)
	go func() {
		body, _ := api.Invoke(context.Background(), []byte(`{}`))
		result <- body
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	payload := []byte(`{"errorMessage":"kaboom","errorType":"ValueError","stackTrace":[]}`)
	accepted := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/error",
		payload, http.Header{runtimeErrorTypeHeader: {"ValueError"}})
	if accepted.status != http.StatusAccepted {
		t.Fatalf("error status: %d", accepted.status)
	}
	body := <-result
	if string(body) != string(payload) {
		t.Fatalf("invoke payload: %s", body)
	}
	if _, err := DecodeResponse(body); err == nil {
		t.Fatal("the error payload must decode as a HandlerError")
	}
}

func TestRuntimeAPIRefusesAnErrorAfterTheResponseStarted(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	sink := &recordingSink{chunks: make(chan []byte, 4)}
	go func() { _, _ = api.InvokeStream(context.Background(), []byte(`{}`), sink) }()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	reader, writer := io.Pipe()
	go func() {
		request, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
			api.HostURL()+runtimeAPIVersionPath+"/invocation/"+requestID+"/response", reader)
		if err != nil {
			return
		}
		request.Header.Set(runtimeResponseModeHeader, runtimeStreamingValue)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return
		}
		_ = response.Body.Close() //nolint:errcheck // test cleanup
	}()
	if _, err := writer.Write([]byte("started")); err != nil {
		t.Fatal(err)
	}
	<-sink.chunks
	refused := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/error",
		[]byte(`{"errorType":"Error"}`), nil)
	if refused.status != http.StatusInternalServerError {
		t.Fatalf("error after a started response: %d", refused.status)
	}
	_ = writer.Close() //nolint:errcheck // end of stream
}

func TestRuntimeAPIInitErrorFailsTheNextInvocation(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	failure := []byte(`{"errorMessage":"module blew up","errorType":"RuntimeError","stackTrace":["line"]}`)
	response := postRuntime(t, api, runtimeInitErrorPath, failure, http.Header{runtimeErrorTypeHeader: {"RuntimeError"}})
	if response.status != http.StatusAccepted {
		t.Fatalf("init error status: %d", response.status)
	}
	body, result := api.Invoke(context.Background(), []byte(`{}`))
	if string(body) != string(failure) {
		t.Fatalf("init error payload: %s", body)
	}
	if !result.reset {
		t.Fatal("an init failure must replace the execution environment")
	}
}

func TestRuntimeAPITimeoutUsesTheDocumentedShape(t *testing.T) {
	api := testRuntimeAPI(t, 1)
	start := time.Now()
	body, result := api.Invoke(context.Background(), []byte(`{}`))
	if elapsed := time.Since(start); elapsed < 900*time.Millisecond || elapsed > 5*time.Second {
		t.Fatalf("timeout elapsed %s", elapsed)
	}
	var payload runtimeErrorPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("timeout payload: %v", err)
	}
	if payload.ErrorType != "Sandbox.Timedout" {
		t.Fatalf("timeout error type: %q", payload.ErrorType)
	}
	if !strings.Contains(payload.ErrorMessage, "Task timed out after 1.00 seconds") {
		t.Fatalf("timeout message: %q", payload.ErrorMessage)
	}
	if !result.reset {
		t.Fatal("a timeout must replace the execution environment")
	}
}

func TestRuntimeAPICrashPayloadUsesRuntimeExitError(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	api.running = func(context.Context) (bool, error) { return false, nil }
	body, result := api.Invoke(context.Background(), []byte(`{}`))
	var payload runtimeErrorPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("crash payload: %v", err)
	}
	if payload.ErrorType != "Runtime.ExitError" || !strings.Contains(payload.ErrorMessage, "Runtime exited") {
		t.Fatalf("crash payload: %+v", payload)
	}
	if !result.reset {
		t.Fatal("a crash must replace the execution environment")
	}
}

func TestRuntimeAPIRestorePathsAreNotEnabled(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	response, err := http.Get(api.HostURL() + runtimeRestoreNext) //nolint:noctx // a test client
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("restore next status: %d", response.StatusCode)
	}
	body, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if !strings.Contains(string(body), "SnapStart is not enabled") {
		t.Fatalf("restore refusal body: %s", body)
	}
}

func TestRuntimeAPIUnknownAndMalformedRequests(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	unknown := postRuntime(t, api, "/2018-06-01/runtime/nope", nil, nil)
	if unknown.status != http.StatusNotFound {
		t.Fatalf("unknown path: %d", unknown.status)
	}
	malformed := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+runtimeResponseSuffix, nil, nil)
	if malformed.status != http.StatusBadRequest {
		t.Fatalf("malformed request id: %d", malformed.status)
	}
	stale := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/unknown/response", []byte(`{}`), nil)
	if stale.status != http.StatusForbidden {
		t.Fatalf("inactive invocation: %d", stale.status)
	}
}

func TestRuntimeAPIStartupFailureIsRecorded(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	api.recordInitFailure(&RuntimeAPIError{Type: "Runtime.ExitError", Message: "Runtime exited", Body: errorPayload("Runtime.ExitError", "Runtime exited")})
	if got := api.initError(); got == nil || got.Type != "Runtime.ExitError" {
		t.Fatalf("startup failure: %#v", got)
	}
	body, result := api.Invoke(context.Background(), []byte(`{}`))
	if len(body) == 0 || !result.reset {
		t.Fatalf("a recorded startup failure must fail the invocation: %s %+v", body, result)
	}
}

func TestRuntimeAPIChunkedJSONResponseIsBuffered(t *testing.T) {
	// The Go runtime client always sends chunked; a buffered response is the
	// JSON payload it encoded.
	api := testRuntimeAPI(t, 30)
	sink := &recordingSink{chunks: make(chan []byte, 4)}
	result := make(chan runtimeInvocationResult, 1)
	go func() {
		_, outcome := api.InvokeStream(context.Background(), []byte(`{}`), sink)
		result <- outcome
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		api.HostURL()+runtimeAPIVersionPath+"/invocation/"+requestID+"/response",
		strings.NewReader(`{"statusCode":200,"body":"ok"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.ContentLength = -1
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("chunked buffered POST: %v", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("status: %d", response.StatusCode)
	}
	outcome := <-result
	if outcome.streamed {
		t.Fatal("a chunked application/json response is a buffered response")
	}
	if chunk := <-sink.chunks; string(chunk) != `{"statusCode":200,"body":"ok"}` {
		t.Fatalf("buffered chunk: %s", chunk)
	}
}

func TestRuntimeAPIBufferedResponseFeedsTheSinkAsOneChunk(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	sink := &recordingSink{chunks: make(chan []byte, 4)}
	go func() {
		_, _ = api.InvokeStream(context.Background(), []byte(`{}`), sink)
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	payload := []byte(`{"statusCode":200}`)
	accepted := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/response",
		payload, http.Header{"Content-Type": {"application/json"}})
	if accepted.status != http.StatusAccepted {
		t.Fatalf("response status: %d", accepted.status)
	}
	chunk := <-sink.chunks
	if string(chunk) != string(payload) {
		t.Fatalf("buffered chunk: %s", chunk)
	}
	if sink.streamedSeen {
		t.Fatal("a buffered response must report streamed=false")
	}
}

func TestRuntimeEnvironmentSetsTheReservedVariables(t *testing.T) {
	api := testRuntimeAPI(t, 3)
	env := runtimeEnvironment(FunctionSpec{LogicalID: "Fn", Handler: "index.handler", MemoryMB: 512}, api)
	want := map[string]string{
		"AWS_LAMBDA_FUNCTION_NAME":        "Fn",
		"AWS_LAMBDA_FUNCTION_VERSION":     "$LATEST",
		"AWS_LAMBDA_FUNCTION_MEMORY_SIZE": "512",
		"AWS_LAMBDA_LOG_GROUP_NAME":       "/aws/lambda/Fn",
		"AWS_LAMBDA_INITIALIZATION_TYPE":  "on-demand",
		"LAMBDA_TASK_ROOT":                "/var/task",
		"LAMBDA_RUNTIME_DIR":              "/var/runtime",
		"TZ":                              ":UTC",
		"_HANDLER":                        "index.handler",
	}
	for name, value := range want {
		if env[name] != value {
			t.Fatalf("%s = %q, want %q", name, env[name], value)
		}
	}
	if !strings.HasPrefix(env["AWS_LAMBDA_RUNTIME_API"], "host.docker.internal:") {
		t.Fatalf("runtime API address: %q", env["AWS_LAMBDA_RUNTIME_API"])
	}
	if !strings.HasPrefix(env["AWS_LAMBDA_LOG_STREAM_NAME"], time.Now().UTC().Format("2006/01/02")+"/[$LATEST]") {
		t.Fatalf("log stream: %q", env["AWS_LAMBDA_LOG_STREAM_NAME"])
	}
	if env := runtimeEnvironment(FunctionSpec{LogicalID: "Fn"}, nil); env != nil {
		t.Fatal("RIE mode must not set the runtime environment")
	}
}

func TestFunctionProcessInvokeUsesTheRuntimeAPI(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	process := &FunctionProcess{Function: FunctionSpec{LogicalID: "Fn", Timeout: 30}, Container: "fn", api: api}
	go func() {
		next := nextInvocation(t, api)
		requestID := next.header.Get(runtimeRequestIDHeader)
		postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/response",
			[]byte(`{"statusCode":200,"body":"ok"}`), nil)
	}()
	body, err := process.Invoke(context.Background(), []byte(`{}`))
	if err != nil || string(body) != `{"statusCode":200,"body":"ok"}` {
		t.Fatalf("invoke: %s %v", body, err)
	}
	if process.RuntimeAPIURL() == "" {
		t.Fatal("RuntimeAPIURL must report the listener")
	}
	if !process.StreamingIncremental() {
		t.Fatal("the runtime API path streams incrementally")
	}
}

func TestFunctionProcessRestartsAfterATimeout(t *testing.T) {
	api := testRuntimeAPI(t, 1)
	resets := 0
	var process *FunctionProcess
	process = &FunctionProcess{
		Function: FunctionSpec{LogicalID: "Fn", Timeout: 1}, Container: "fn", api: api, logf: t.Logf,
		reset: func(context.Context, *FunctionProcess) error {
			resets++
			process.api = testRuntimeAPI(t, 30)
			return nil
		},
	}
	if _, err := process.Invoke(context.Background(), []byte(`{}`)); err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resets != 1 {
		t.Fatalf("timeout resets: %d", resets)
	}
}

// recordingSink records the calls a streaming response makes.
type recordingSink struct {
	chunks       chan []byte
	started      bool
	ended        bool
	streamedSeen bool
	body         bytes.Buffer
}

func (s *recordingSink) Start(_ string, streamed bool) error {
	s.started = true
	s.streamedSeen = s.streamedSeen || streamed
	return nil
}

func (s *recordingSink) Chunk(chunk []byte) error {
	s.body.Write(chunk)
	s.chunks <- append([]byte(nil), chunk...)
	return nil
}

func (s *recordingSink) End(string, []byte) error {
	s.ended = true
	return nil
}

func TestTimeoutPayloadForm(t *testing.T) {
	payload := timeoutPayload("req-1", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), 3*time.Second)
	var decoded runtimeErrorPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.ErrorType != timeoutErrorType || decoded.ErrorMessage != "2026-01-01T00:00:00.000Z req-1 Task timed out after 3.00 seconds" {
		t.Fatalf("timeout payload: %+v", decoded)
	}
}

func TestRuntimeErrorFromPayloadUsesTheHeaderWhenTheBodyHasNoType(t *testing.T) {
	failure := runtimeErrorFromPayload(nil, "Runtime.InvalidEntrypoint")
	if failure.Type != "Runtime.InvalidEntrypoint" || len(failure.Body) == 0 {
		t.Fatalf("failure: %+v", failure)
	}
	unknown := runtimeErrorFromPayload(nil, "")
	if unknown.Type != "Runtime.Unknown" {
		t.Fatalf("unknown type: %q", unknown.Type)
	}
	body := runtimeErrorFromPayload([]byte(`{"errorMessage":"x","errorType":"E"}`), "")
	if body.Type != "E" || body.Message != "x" {
		t.Fatalf("payload: %+v", body)
	}
}

func TestNewTraceIDShape(t *testing.T) {
	trace := newTraceID()
	parts := strings.Split(trace, ";")
	if len(parts) != 3 || !strings.HasPrefix(parts[0], "Root=1-") || !strings.HasPrefix(parts[1], "Parent=") || parts[2] != "Sampled=0" {
		t.Fatalf("trace: %q", trace)
	}
	if fmt.Sprintf("%T", localFunctionARN("Fn")) != "string" {
		t.Fatal("localFunctionARN must be a string")
	}
}
