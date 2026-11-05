package localrunner

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The Lambda Runtime API is the HTTP interface a runtime uses to receive
// invocations and return responses. The runner serves it for every function
// container, so the container's own runtime interface client talks to the
// runner instead of the image's embedded Runtime Interface Emulator.
//
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
const (
	runtimeAPIVersionPath = "/2018-06-01/runtime"
	runtimeNextPath       = runtimeAPIVersionPath + "/invocation/next"
	runtimeResponseSuffix = "/response"
	runtimeErrorSuffix    = "/error"
	runtimeInitErrorPath  = runtimeAPIVersionPath + "/init/error"
	runtimeRestoreNext    = runtimeAPIVersionPath + "/restore/next"
	runtimeRestoreError   = runtimeAPIVersionPath + "/restore/error"

	runtimeResponseModeHeader = "Lambda-Runtime-Function-Response-Mode"
	runtimeStreamingValue     = "streaming"
	runtimeErrorTypeHeader    = "Lambda-Runtime-Function-Error-Type"
	runtimeErrorBodyTrailer   = "Lambda-Runtime-Function-Error-Body"
	runtimeInvocationIDHeader = "Lambda-Runtime-Invocation-Id"

	runtimeRequestIDHeader   = "Lambda-Runtime-Aws-Request-Id"
	runtimeDeadlineHeader    = "Lambda-Runtime-Deadline-Ms"
	runtimeFunctionARNHeader = "Lambda-Runtime-Invoked-Function-Arn"
	runtimeTraceIDHeader     = "Lambda-Runtime-Trace-Id"
	// runtimeInvocationIDMismatch is the error message Lambda returns with 400
	// when a response or error echoes a different invocation id than the one
	// the active invocation carried.
	// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
	runtimeInvocationIDMismatch = "InvalidInvocationId"
)

// RuntimeAPIError is one error the runtime reported, or one the runner
// synthesized in the documented Lambda error shape.
type RuntimeAPIError struct {
	Type    string
	Message string
	Body    []byte
}

func (e *RuntimeAPIError) Error() string {
	return fmt.Sprintf("%s: %s", e.Type, e.Message)
}

// runtimeInvocation is one invocation attempt. A request id identifies the
// event and an invocation id identifies this attempt; the runtime echoes the
// invocation id back and Lambda rejects a mismatch with 400.
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
type runtimeInvocation struct {
	requestID    string
	invocationID string
	deadline     time.Time
	payload      []byte
	traceID      string
	sink         StreamSink

	mu      sync.Mutex
	started bool
	result  runtimeInvocationResult
	done    chan struct{}
}

type runtimeInvocationResult struct {
	body        []byte
	contentType string
	streamed    bool
	errorType   string
	errorBody   []byte
	// reported is the Lambda error the runtime reported instead of a response:
	// an /error post, a timeout, a crash or an initialization failure.
	reported *RuntimeAPIError
	// reset asks the caller to replace the execution environment: a timeout, a
	// crash and an init failure all end the environment, as the lifecycle page
	// describes.
	reset bool
	err   error
}

// runtimeAPI serves one function container's Runtime API. Each container needs
// its own listener: the runtime API has no function identifier in its paths, so
// a shared listener could not tell two functions' /next requests apart.
type runtimeAPI struct {
	function FunctionSpec
	listener net.Listener
	server   *http.Server

	// pending hands one invocation to a waiting /next. The caller serializes
	// invocations, so one slot is enough.
	pending chan *runtimeInvocation

	mu          sync.Mutex
	active      *runtimeInvocation
	initFailure *RuntimeAPIError
	nextSeen    chan struct{}
	nextOnce    sync.Once
	closed      chan struct{}
	closeOnce   sync.Once
	// running reports whether the container is still alive while an
	// invocation waits. A nil check skips the probe (unit tests).
	running func(context.Context) (bool, error)
	// gateway resolves the run network's gateway address, the fallback bind
	// when the container cannot reach the host's loopback. A nil function
	// keeps the loopback bind.
	gateway func(context.Context) (string, error)
	// boundGateway is the run network gateway the listener also serves on,
	// when the container reaches the host through it (the Linux bridge case).
	boundGateway string
	logf         func(string, ...any)
}

// runtimeAPIProbeTimeout bounds how long a container is given to reach the
// loopback listener before the listener falls back to the run network's
// gateway address. Colima and Docker Desktop forward host.docker.internal to
// the host's loopback; on Linux the host gateway is the bridge address, so a
// loopback-only listener is unreachable from the container.
const runtimeAPIProbeTimeout = 10 * time.Second

func newRuntimeAPI(function FunctionSpec, logf func(string, ...any)) (*runtimeAPI, error) {
	// The listener never binds the unspecified address: that would expose the
	// unauthenticated Runtime API (every invocation payload, the response and
	// error channel) to every host on the developer's network.
	listener, err := listenRuntimeAPI("127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("bind the runtime API listener for %s: %w", function.LogicalID, err)
	}
	api := &runtimeAPI{
		function: function,
		listener: listener,
		pending:  make(chan *runtimeInvocation, 1),
		nextSeen: make(chan struct{}),
		closed:   make(chan struct{}),
		logf:     logf,
	}
	api.server = api.newServer()
	go api.serve(api.server, listener)
	return api, nil
}

// listenRuntimeAPI is a variable so a test can prove the gateway bind without
// exposing a real non-loopback address.
var listenRuntimeAPI = func(address string) (net.Listener, error) {
	var listenConfig net.ListenConfig
	return listenConfig.Listen(context.Background(), "tcp", address)
}

func (a *runtimeAPI) newServer() *http.Server {
	return &http.Server{
		Handler:           http.HandlerFunc(a.serveHTTP),
		ReadHeaderTimeout: 10 * time.Second,
		// No read or write timeout: /next is an iterator-style blocking call
		// that Lambda may answer after seconds, and the page says not to set a
		// timeout on it.
		// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
	}
}

func (a *runtimeAPI) serve(server *http.Server, listener net.Listener) {
	if serveErr := server.Serve(listener); serveErr != nil && serveErr != http.ErrServerClosed {
		a.logf("runtime API for %s stopped: %v", a.function.LogicalID, serveErr)
	}
}

// boundAddress reports the address the listener serves on right now.
func (a *runtimeAPI) boundAddress() *net.TCPAddr {
	if a == nil || a.listener == nil {
		return nil
	}
	address, ok := a.listener.Addr().(*net.TCPAddr)
	if !ok {
		return nil
	}
	return address
}

// HostURL is the runtime API address on the host (the CLI and tests).
func (a *runtimeAPI) HostURL() string {
	address := a.boundAddress()
	if address == nil {
		return ""
	}
	return "http://" + net.JoinHostPort(address.IP.String(), strconv.Itoa(address.Port))
}

// bindGateway adds a listener on the run network's gateway address on the same
// port, which is the address a container reaches when the host's loopback is
// not forwarded to it (the Linux bridge case). The loopback listener stays
// bound for the CLI. It reports whether the extra bind succeeded.
func (a *runtimeAPI) bindGateway(gateway string) bool {
	address := a.boundAddress()
	if address == nil || a.server == nil {
		return false
	}
	gateway = strings.TrimSpace(gateway)
	if gateway == "" || a.boundGateway != "" {
		return false
	}
	listener, err := listenRuntimeAPI(net.JoinHostPort(gateway, strconv.Itoa(address.Port)))
	if err != nil {
		a.logf("runtime API for %s: cannot bind the run network gateway %s:%d: %v",
			a.function.LogicalID, gateway, address.Port, err)
		return false
	}
	a.boundGateway = gateway
	go a.serve(a.server, listener)
	a.logf("runtime API for %s: also bound the run network gateway %s:%d for the container",
		a.function.LogicalID, gateway, address.Port)
	return true
}

// rebindToGateway adds the run network's gateway listener when the container
// has not reached the loopback listener.
func (a *runtimeAPI) rebindToGateway(ctx context.Context) bool {
	if a == nil || a.gateway == nil || a.boundGateway != "" {
		return false
	}
	gateway, err := a.gateway(ctx)
	if err != nil {
		a.logf("runtime API for %s: cannot read the run network gateway: %v", a.function.LogicalID, err)
		return false
	}
	return a.bindGateway(gateway)
}

// gatewayBound reports the run network gateway the listener also serves on, or
// an empty string while it serves only loopback.
func (a *runtimeAPI) gatewayBound() string {
	if a == nil {
		return ""
	}
	return a.boundGateway
}

// ContainerAddress is the address a function container uses in
// AWS_LAMBDA_RUNTIME_API. The variable is "the host and port of the runtime
// API", without a scheme.
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
func (a *runtimeAPI) ContainerAddress() string {
	address := a.boundAddress()
	if address == nil {
		return ""
	}
	return "host.docker.internal:" + strconv.Itoa(address.Port)
}

func (a *runtimeAPI) close() {
	if a == nil {
		return
	}
	a.closeOnce.Do(func() {
		close(a.closed)
		if a.server != nil {
			_ = a.server.Close() //nolint:errcheck // shutdown is best effort
		}
	})
}

// initError returns the initialization failure the runtime reported, if any.
func (a *runtimeAPI) initError() *RuntimeAPIError {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.initFailure
}

// recordInitFailure stores an initialization error the runner observed (a
// runtime process that exited before its first Next API request).
func (a *runtimeAPI) recordInitFailure(failure *RuntimeAPIError) {
	if failure == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.initFailure == nil {
		a.initFailure = failure
	}
}

// Invoke runs one invocation. The body is the runtime's response payload; an
// /error response is returned as its raw error JSON, which is the shape the
// Runtime Interface Emulator produced, so every existing caller keeps its
// result contract.
func (a *runtimeAPI) Invoke(ctx context.Context, payload []byte) ([]byte, runtimeInvocationResult) {
	_, result := a.invoke(ctx, payload, nil)
	return result.body, result
}

// InvokeStream runs one invocation and forwards each chunk to sink as the
// runtime writes it. A nil sink buffers the response.
func (a *runtimeAPI) InvokeStream(ctx context.Context, payload []byte, sink StreamSink) ([]byte, runtimeInvocationResult) {
	return a.invoke(ctx, payload, sink)
}

//nolint:gocognit // the documented request state machine is pinned by tests
func (a *runtimeAPI) invoke(ctx context.Context, payload []byte, sink StreamSink) ([]byte, runtimeInvocationResult) {
	if failure := a.initError(); failure != nil {
		// The runtime failed initialization; the next invocation must start a
		// fresh execution environment.
		// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
		a.logf("function %s: initialization failed: %v", a.function.LogicalID, failure)
		return failure.Body, runtimeInvocationResult{body: failure.Body, err: failure, reported: failure, reset: true}
	}
	timeout := a.functionTimeout()
	now := time.Now().UTC()
	invocation := &runtimeInvocation{
		requestID:    NewRequestID(),
		invocationID: NewRequestID(),
		deadline:     now.Add(timeout),
		payload:      payload,
		traceID:      newTraceID(),
		done:         make(chan struct{}),
	}
	invocation.sink = sink
	select {
	case a.pending <- invocation:
	case <-a.closed:
		return a.crashPayload(invocation.requestID, "Runtime exited before accepting an invocation")
	case <-ctx.Done():
		return nil, runtimeInvocationResult{err: ctx.Err()}
	}

	timer := time.NewTimer(time.Until(invocation.deadline))
	defer timer.Stop()
	check := time.NewTicker(250 * time.Millisecond)
	defer check.Stop()
	for {
		select {
		case <-invocation.done:
			invocation.mu.Lock()
			result := invocation.result
			invocation.mu.Unlock()
			return result.body, result
		case <-timer.C:
			// The Invoke phase is bounded by the function timeout; a function
			// that does not answer by the deadline times out.
			// https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
			body := timeoutPayload(invocation.requestID, now, a.functionTimeout())
			payloadErr := &RuntimeAPIError{Type: timeoutErrorType, Message: strings.TrimSpace(string(body)), Body: body}
			a.logf("function %s: invocation %s exceeded its %s timeout", a.function.LogicalID, invocation.requestID, timeout)
			return body, runtimeInvocationResult{body: body, err: payloadErr, reported: payloadErr, reset: true}
		case <-ctx.Done():
			return nil, runtimeInvocationResult{err: ctx.Err()}
		case <-a.closed:
			return a.crashPayload(invocation.requestID, "Runtime exited before providing a response")
		case <-check.C:
			if a.running == nil {
				continue
			}
			running, err := a.running(ctx)
			if err != nil || running {
				continue
			}
			return a.crashPayload(invocation.requestID, "Runtime exited without providing a reason")
		}
	}
}

// crashPayload is the documented client-visible shape of a runtime that exited
// without answering. The troubleshooting page shows the log form
// "Runtime exited without providing a reason" and the error type
// Runtime.ExitError.
// https://docs.aws.amazon.com/lambda/latest/dg/troubleshooting-invocation.html
func (a *runtimeAPI) crashPayload(requestID, message string) ([]byte, runtimeInvocationResult) {
	payload := errorPayload("Runtime.ExitError", fmt.Sprintf("RequestId: %s Error: %s", requestID, message))
	failure := &RuntimeAPIError{Type: "Runtime.ExitError", Message: message, Body: payload}
	a.logf("function %s: %s", a.function.LogicalID, message)
	return payload, runtimeInvocationResult{body: payload, err: failure, reported: failure, reset: true}
}

func (a *runtimeAPI) functionTimeout() time.Duration {
	if a.function.Timeout <= 0 {
		return 3 * time.Second
	}
	return time.Duration(a.function.Timeout) * time.Second
}

// serveHTTP routes the documented Runtime API paths.
func (a *runtimeAPI) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	switch {
	case request.Method == http.MethodGet && request.URL.Path == runtimeNextPath:
		a.serveNext(writer, request)
	case request.Method == http.MethodPost && request.URL.Path == runtimeInitErrorPath:
		a.serveInitError(writer, request)
	case request.Method == http.MethodGet && request.URL.Path == runtimeRestoreNext:
		// SnapStart is not enabled for a local function: "404 SnapStart is not
		// enabled for this function".
		// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
		writeRuntimeError(writer, http.StatusNotFound, "SnapStart is not enabled for this function")
	case request.Method == http.MethodPost && request.URL.Path == runtimeRestoreError:
		writeRuntimeError(writer, http.StatusNotFound, "SnapStart is not enabled for this function")
	case request.Method == http.MethodPost && strings.HasPrefix(request.URL.Path, runtimeAPIVersionPath+"/invocation/"):
		a.serveInvocationPost(writer, request)
	default:
		writeRuntimeError(writer, http.StatusNotFound, "the local runtime API has no "+request.Method+" "+request.URL.Path)
	}
}

// serveNext answers the blocking long poll. Every documented response header is
// set; the client-context and cognito-identity headers are only present for AWS
// Mobile SDK invocations, which the runner never makes, so they are omitted.
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
func (a *runtimeAPI) serveNext(writer http.ResponseWriter, request *http.Request) {
	a.nextOnce.Do(func() { close(a.nextSeen) })
	var invocation *runtimeInvocation
	select {
	case invocation = <-a.pending:
	case <-a.closed:
		writeRuntimeError(writer, http.StatusInternalServerError, "the function container is shutting down")
		return
	case <-request.Context().Done():
		return
	}
	a.mu.Lock()
	a.active = invocation
	a.mu.Unlock()
	writer.Header().Set(runtimeRequestIDHeader, invocation.requestID)
	writer.Header().Set(runtimeDeadlineHeader, strconv.FormatInt(invocation.deadline.UnixMilli(), 10))
	writer.Header().Set(runtimeFunctionARNHeader, localFunctionARN(a.function.LogicalID))
	writer.Header().Set(runtimeTraceIDHeader, invocation.traceID)
	writer.Header().Set(runtimeInvocationIDHeader, invocation.invocationID)
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(invocation.payload) //nolint:errcheck // the response is committed
}

// serveInitError records the runtime's initialization failure. The runtime
// exits immediately after this call; the recorded error fails the pending or
// next invocation and the container is replaced.
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
func (a *runtimeAPI) serveInitError(writer http.ResponseWriter, request *http.Request) {
	body, readErr := io.ReadAll(request.Body)
	if readErr != nil {
		writeRuntimeError(writer, http.StatusBadRequest, "read the initialization error: "+readErr.Error())
		return
	}
	failure := runtimeErrorFromPayload(body, request.Header.Get(runtimeErrorTypeHeader))
	a.mu.Lock()
	a.initFailure = failure
	active := a.active
	a.mu.Unlock()
	if active != nil {
		active.finish(runtimeInvocationResult{body: body, err: failure, reported: failure, reset: true})
	} else {
		select {
		case pending := <-a.pending:
			pending.finish(runtimeInvocationResult{body: body, err: failure, reported: failure, reset: true})
		default:
		}
	}
	a.logf("function %s: initialization error %s", a.function.LogicalID, failure.Error())
	writeRuntimeStatus(writer)
}

// serveInvocationPost handles /response and /error for one invocation.
func (a *runtimeAPI) serveInvocationPost(writer http.ResponseWriter, request *http.Request) {
	trimmed := strings.TrimPrefix(request.URL.Path, runtimeAPIVersionPath+"/invocation/")
	suffix := ""
	switch {
	case strings.HasSuffix(trimmed, runtimeResponseSuffix):
		suffix = runtimeResponseSuffix
	case strings.HasSuffix(trimmed, runtimeErrorSuffix):
		suffix = runtimeErrorSuffix
	default:
		writeRuntimeError(writer, http.StatusNotFound, "unknown runtime API path "+request.URL.Path)
		return
	}
	requestID := strings.TrimSuffix(trimmed, suffix)
	if requestID == "" || strings.Contains(requestID, "/") {
		writeRuntimeError(writer, http.StatusBadRequest, "InvalidRequestId")
		return
	}
	invocation := a.invocation(requestID)
	if invocation == nil {
		// A runtime may only answer the invocation it was given.
		// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
		writeRuntimeError(writer, http.StatusForbidden, "the invocation is not active: "+requestID)
		return
	}
	// The invocation id is optional for backward compatibility; Lambda only
	// rejects 400 InvalidInvocationId when it is present and does not match.
	if header := strings.TrimSpace(request.Header.Get(runtimeInvocationIDHeader)); header != "" && header != invocation.invocationID {
		writeRuntimeError(writer, http.StatusBadRequest, runtimeInvocationIDMismatch)
		return
	}
	invocation.mu.Lock()
	started := invocation.started
	invocation.started = true
	invocation.mu.Unlock()
	if started {
		// Only one answer per invocation attempt.
		writeRuntimeError(writer, http.StatusInternalServerError, "the invocation already has a response")
		return
	}
	if suffix == runtimeErrorSuffix {
		a.serveInvocationError(writer, request, invocation)
		return
	}
	a.serveInvocationResponse(writer, request, invocation)
}

// serveInvocationResponse reads the response, forwarding streamed chunks as
// they arrive. The runtime's chunked encoding is the streaming signal: the
// docs require the response-mode header, but the Go runtime (aws-lambda-go)
// sends only Transfer-Encoding: chunked, so either marks a stream.
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
//
//nolint:gocognit,gocyclo // the documented response state machine is pinned by tests
func (a *runtimeAPI) serveInvocationResponse(writer http.ResponseWriter, request *http.Request, invocation *runtimeInvocation) {
	contentType := request.Header.Get("Content-Type")
	streaming := request.Header.Get(runtimeResponseModeHeader) == runtimeStreamingValue
	if !streaming {
		// The Go runtime client does not set the response-mode header; it
		// always sends an unknown-length body with chunked transfer encoding,
		// including for a buffered response. A buffered runtime response is the
		// JSON payload the runtime encoded, so its Content-Type is
		// application/json. A streamed response carries the proxy-integration
		// envelope or the handler's own type.
		// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
		for _, encoding := range request.TransferEncoding {
			if !strings.EqualFold(encoding, "chunked") {
				continue
			}
			mediaType := strings.TrimSpace(strings.SplitN(strings.ToLower(contentType), ";", 2)[0])
			streaming = mediaType != "" && mediaType != "application/json"
		}
	}
	if !streaming {
		body, readErr := io.ReadAll(request.Body)
		if readErr != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "read the invocation response: "+readErr.Error())
			invocation.finish(runtimeInvocationResult{
				body: errorPayload("Runtime.ExitError", "the runner could not read the invocation response: "+readErr.Error()),
				err:  readErr, reset: true,
			})
			return
		}
		if sink := invocation.sink; sink != nil {
			if startErr := sink.Start(contentType, false); startErr == nil {
				_ = sink.Chunk(body)  //nolint:errcheck // a buffered response has one chunk
				_ = sink.End("", nil) //nolint:errcheck // no trailers on a buffered response
			}
		}
		invocation.finish(runtimeInvocationResult{body: body, contentType: contentType})
		writeRuntimeStatus(writer)
		return
	}

	sink := invocation.sink
	// A sink failure means the invocation's client stopped reading. Lambda does
	// not interrupt a streamed response when the client disconnects, so the
	// runner keeps draining the runtime's body and completes the invocation; the
	// execution environment is not replaced.
	// https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
	var sinkErr error
	if sink != nil {
		if startErr := sink.Start(contentType, true); startErr != nil {
			sink, sinkErr = nil, startErr
		}
	}
	var collected bytes.Buffer
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := request.Body.Read(buffer)
		if n > 0 {
			collected.Write(buffer[:n])
			if sink != nil {
				if chunkErr := sink.Chunk(buffer[:n]); chunkErr != nil {
					sink, sinkErr = nil, chunkErr
				}
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "read the streamed invocation response: "+readErr.Error())
			invocation.finish(runtimeInvocationResult{
				body: errorPayload("Runtime.ExitError", "the runner could not read the streamed response: "+readErr.Error()),
				err:  readErr, reset: true,
			})
			return
		}
	}
	// Trailers arrive after the chunked body. Lambda treats a response with
	// error trailers as successful and forwards the error metadata.
	// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
	errorType := request.Trailer.Get(runtimeErrorTypeHeader)
	errorBody := request.Trailer.Get(runtimeErrorBodyTrailer)
	decoded, decodeErr := base64.StdEncoding.DecodeString(errorBody)
	if decodeErr != nil {
		decoded = []byte(errorBody)
	}
	if sink != nil {
		_ = sink.End(errorType, decoded) //nolint:errcheck // the client is already gone if this fails
	}
	invocation.finish(runtimeInvocationResult{
		body:        collected.Bytes(),
		contentType: contentType,
		streamed:    true,
		errorType:   errorType,
		errorBody:   decoded,
		err:         sinkErr,
	})
	writeRuntimeStatus(writer)
}

// serveInvocationError accepts /error only before the response starts, as the
// custom-runtime page states. The body is the runtime's error JSON; returning
// it unchanged keeps the caller's HandlerError contract.
func (a *runtimeAPI) serveInvocationError(writer http.ResponseWriter, request *http.Request, invocation *runtimeInvocation) {
	body, readErr := io.ReadAll(request.Body)
	if readErr != nil {
		writeRuntimeError(writer, http.StatusBadRequest, "read the invocation error: "+readErr.Error())
		return
	}
	failure := runtimeErrorFromPayload(body, request.Header.Get(runtimeErrorTypeHeader))
	invocation.finish(runtimeInvocationResult{body: body, err: failure, reported: failure})
	writeRuntimeStatus(writer)
}

func (a *runtimeAPI) invocation(requestID string) *runtimeInvocation {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.active == nil || a.active.requestID != requestID {
		return nil
	}
	return a.active
}

// finish records the invocation's result once.
func (inv *runtimeInvocation) finish(result runtimeInvocationResult) {
	inv.mu.Lock()
	defer inv.mu.Unlock()
	select {
	case <-inv.done:
		return
	default:
	}
	inv.result = result
	close(inv.done)
}

// StreamSink receives a response as the runtime writes it.
type StreamSink interface {
	// Start is called once before the first chunk with the response
	// Content-Type. streamed is false when the runtime answered with a buffered
	// response, which then arrives as a single chunk.
	Start(contentType string, streamed bool) error
	// Chunk is called for every chunk the runtime writes, in order.
	Chunk(chunk []byte) error
	// End is called after the last chunk with any midstream error trailers.
	End(errorType string, errorBody []byte) error
}

// runtimeErrorPayload is the documented ErrorRequest body.
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
type runtimeErrorPayload struct {
	ErrorMessage string   `json:"errorMessage"`
	ErrorType    string   `json:"errorType"`
	StackTrace   []string `json:"stackTrace,omitempty"`
}

func errorPayload(errorType, message string) []byte {
	raw, err := json.Marshal(runtimeErrorPayload{ErrorMessage: message, ErrorType: errorType})
	if err != nil {
		return []byte(`{"errorMessage":"the runner could not encode the error","errorType":"Runtime.Unknown"}`)
	}
	return raw
}

func runtimeErrorFromPayload(body []byte, headerType string) *RuntimeAPIError {
	var payload runtimeErrorPayload
	_ = json.Unmarshal(body, &payload) //nolint:errcheck // a malformed body reports its zero fields
	kind := payload.ErrorType
	if kind == "" {
		kind = normalizeRuntimeErrorType(headerType)
	}
	if kind == "" {
		kind = "Runtime.Unknown"
	}
	message := payload.ErrorMessage
	if strings.TrimSpace(message) == "" {
		message = truncateForMessage(string(body))
	}
	if len(body) == 0 {
		body = errorPayload(kind, message)
	}
	return &RuntimeAPIError{Type: kind, Message: message, Body: body}
}

// normalizeRuntimeErrorType implements the runtime API page's rule for the
// Lambda-Runtime-Function-Error-Type header. The page recommends the
// <Category.Reason> form, "where Category is Runtime or Function and Reason
// starts with an uppercase letter", and states: "Values that do not match this
// pattern are normalized to Runtime.Unknown or Function.Unknown."
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
func normalizeRuntimeErrorType(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	category, reason, found := strings.Cut(value, ".")
	if found && (category == "Runtime" || category == "Function") && reason != "" &&
		reason[0] >= 'A' && reason[0] <= 'Z' {
		return value
	}
	if category == "Function" {
		return "Function.Unknown"
	}
	return "Runtime.Unknown"
}

// timeoutErrorType is the documented error type for a function timeout.
// https://docs.aws.amazon.com/lambda/latest/dg/troubleshooting-invocation.html
const timeoutErrorType = "Sandbox.Timedout"

// timeoutPayload is the documented client-visible timeout message:
// "Task timed out after 3.00 seconds".
// https://docs.aws.amazon.com/lambda/latest/dg/troubleshooting-invocation.html
func timeoutPayload(requestID string, started time.Time, timeout time.Duration) []byte {
	message := fmt.Sprintf("%s %s Task timed out after %.2f seconds",
		started.UTC().Format("2006-01-02T15:04:05.000Z"), requestID, timeout.Seconds())
	return errorPayload(timeoutErrorType, message)
}

// localFunctionARN is the ARN the runtime API reports for a local function.
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
func localFunctionARN(functionID string) string {
	return "arn:" + LocalPartition + ":lambda:" + LocalRegion + ":" + LocalAccountID + ":function:" + functionID
}

// newTraceID builds an X-Ray trace header for one invocation.
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
func newTraceID() string {
	raw := NewRequestID()
	parent := NewRequestID()
	return "Root=1-" + raw[:8] + "-" + raw[8:32] + ";Parent=" + parent[:16] + ";Sampled=0"
}

func writeRuntimeStatus(writer http.ResponseWriter) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusAccepted)
	_, _ = writer.Write([]byte(`{"status":"OK"}`)) //nolint:errcheck // the response is committed
}

func writeRuntimeError(writer http.ResponseWriter, status int, message string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(errorPayload("Runtime.Unknown", message)) //nolint:errcheck,gosec // the response is committed; the message is a runtime error
}
