package apptheory

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
)

const (
	// apigatewayV2StreamingBodyMaxBytes bounds how many bytes of a streaming
	// response body the HTTP API v2 adapter buffers before failing closed.
	// HTTP API v2 (payload format 2.0) delivers buffered responses only, so the
	// adapter drains terminating streams into the buffered body up to this
	// budget instead of silently dropping them.
	apigatewayV2StreamingBodyMaxBytes = 4 * 1024 * 1024

	// apigatewayV2StreamingBodyTimeout bounds how long the HTTP API v2 adapter
	// waits for a streaming response body to terminate before failing closed.
	// A never-terminating stream (for example a live SSE session listener or an
	// open replay subscription) must not hold the Lambda until the API Gateway
	// buffering ceiling; failing loudly and cheaply lets clients surface the
	// transport mismatch instead of spinning on an empty 200.
	apigatewayV2StreamingBodyTimeout = 5 * time.Second

	// apigatewayV2StreamingBodyErrorMessage is the documented client-visible
	// error for a streaming response body the HTTP API v2 adapter cannot
	// deliver for a non-size reason (a stream that did not terminate in time or
	// one that errored). It is returned as HTTP 500 with the nested AppTheory
	// error body. A body that merely exceeds the byte budget maps to 413
	// (errorCodeTooLarge) instead, matching the framework's size semantics.
	apigatewayV2StreamingBodyErrorMessage = "streaming response body cannot be delivered by the HTTP API v2 adapter"

	// lambdaFunctionURLStreamingBodyErrorMessage is the documented
	// client-visible error for a streaming response body the buffered Lambda
	// Function URL adapter cannot deliver for a non-size reason. It is returned
	// as HTTP 500 with the nested AppTheory error body, matching the HTTP API
	// v2 fail-closed shape with the adapter named in the message. A body that
	// merely exceeds the byte budget maps to 413 (errorCodeTooLarge) instead.
	lambdaFunctionURLStreamingBodyErrorMessage = "streaming response body cannot be delivered by the Function URL adapter"

	// albTargetGroupStreamingBodyErrorMessage is the documented client-visible
	// error for a streaming response body the buffered ALB target group adapter
	// cannot deliver for a non-size reason. ALB delivers buffered responses
	// only, so the adapter drains the body under the same budget as the HTTP API
	// v2 adapter and fails closed with the adapter named in the message.
	albTargetGroupStreamingBodyErrorMessage = "streaming response body cannot be delivered by the ALB target group adapter"

	// apigatewayProxyStreamingBodyErrorMessage is the documented client-visible
	// error for a streaming response body the buffered API Gateway REST v1
	// adapter cannot deliver for a non-size reason. The v1 buffered shape
	// delivers a complete body only, so the adapter drains the body under the
	// same budget and fails closed with the adapter named in the message. A
	// v1 route configured for response streaming delivers the body through
	// apigatewayProxyStreamingResponseFromResponse instead.
	apigatewayProxyStreamingBodyErrorMessage = "streaming response body cannot be delivered by the API Gateway REST v1 adapter"
)

// The HTTP API v2, Lambda Function URL, ALB target group and buffered API
// Gateway REST v1 adapters all deliver buffered responses only, so they share
// the same bounded drain budget
// (apigatewayV2StreamingBodyMaxBytes / apigatewayV2StreamingBodyTimeout) and
// the same fail-closed semantics; only the client-visible error message names
// the adapter that could not deliver the body.

var errAPIGatewayV2StreamingBodyTooLarge = errors.New("apptheory: streaming response body exceeds HTTP API v2 adapter budget")

// isStreamingBodySizeError reports whether a drain failure is a size violation
// (the streaming body exceeded a byte budget) rather than a delivery failure
// (non-termination or a stream error). Size violations map to 413
// (errorCodeTooLarge) per the framework's size semantics; delivery failures
// keep the documented 500 fail-closed shape. Both the adapter's own byte
// budget (errAPIGatewayV2StreamingBodyTooLarge) and the framework's
// MaxResponseBytes limiter (an AppError with errorCodeTooLarge) are size
// errors and must map to 413.
func isStreamingBodySizeError(err error) bool {
	if errors.Is(err, errAPIGatewayV2StreamingBodyTooLarge) {
		return true
	}
	return errorCodeForError(err) == errorCodeTooLarge
}

// serveScoped serves a request on an invocation-scoped context and returns the
// context the response was produced on plus the cancel that ends the
// invocation's scope.
//
// A caller that hands the response body to a response-streaming transport MUST
// NOT cancel the scope: the transport owns the body's lifetime there and closes
// the body (which stops and joins the producer) itself. A caller that buffers
// the response body cancels the scope and joins the body before returning.
func (a *App) serveScoped(ctx context.Context, req Request) (context.Context, context.CancelFunc, Response) {
	serveCtx, cancelServe := context.WithCancel(ctx)
	return serveCtx, cancelServe, a.Serve(serveCtx, req)
}

// serveForBufferedAdapter serves a request on an invocation-scoped context and
// returns the cleanup the adapter must run before it returns.
//
// The cleanup cancels the serve context (so producers that observe it stop with
// the invocation) and joins any runtime-produced body stream the adapter
// abandoned, so no producer the invocation started is still running once the
// adapter hands its response back to the Lambda runtime.
func (a *App) serveForBufferedAdapter(ctx context.Context, req Request) (context.Context, Response, func()) {
	serveCtx, cancelServe, resp := a.serveScoped(ctx, req)
	return serveCtx, resp, func() {
		cancelServe()
		joinAbandonedBodyStream(resp.BodyStream)
	}
}

// bufferedAdapterResponse drains a streaming response body into the buffered
// body under the shared adapter budget and fails closed when the body cannot be
// delivered.
//
// Every buffered adapter routes through here, so the ALB target group and the
// buffered API Gateway REST v1 shapes get the same drain, close and join as the
// HTTP API v2 and Function URL shapes. An adapter that dropped a streaming body
// instead would return a response whose producer the invocation had started was
// still running.
func bufferedAdapterResponse(ctx context.Context, resp Response, errorMessage string) Response {
	if resp.BodyReader == nil && resp.BodyStream == nil {
		return resp
	}

	drained, err := drainStreamingBodyForAPIGatewayV2(ctx, resp)
	if err == nil {
		return drained
	}
	if isStreamingBodySizeError(err) {
		return errorResponse(errorCodeTooLarge, errorMessageResponseTooLarge, nil)
	}
	return errorResponse(errorCodeInternal, errorMessage, nil)
}

func (a *App) ServeAPIGatewayV2(ctx context.Context, event events.APIGatewayV2HTTPRequest) events.APIGatewayV2HTTPResponse {
	startedAt := adapterEntryTime(a)
	req, err := requestFromAPIGatewayV2(event)
	if err != nil {
		resp := a.responseForHTTPError(err)
		a.recordAdapterDecodeError(startedAt, event.RequestContext.HTTP.Method, event.RequestContext.HTTP.Path, err, resp.Status)
		return apigatewayV2ResponseFromResponse(ctx, resp)
	}

	serveCtx, resp, finishInvocation := a.serveForBufferedAdapter(ctx, req)
	defer finishInvocation()

	return apigatewayV2ResponseFromResponse(serveCtx, resp)
}

func (a *App) ServeLambdaFunctionURL(ctx context.Context, event events.LambdaFunctionURLRequest) events.LambdaFunctionURLResponse {
	startedAt := adapterEntryTime(a)
	req, err := requestFromLambdaFunctionURL(event)
	if err != nil {
		resp := a.responseForHTTPError(err)
		a.recordAdapterDecodeError(startedAt, event.RequestContext.HTTP.Method, event.RequestContext.HTTP.Path, err, resp.Status)
		return lambdaFunctionURLResponseFromResponse(ctx, resp)
	}

	serveCtx, resp, finishInvocation := a.serveForBufferedAdapter(ctx, req)
	defer finishInvocation()

	return lambdaFunctionURLResponseFromResponse(serveCtx, resp)
}

func requestFromAPIGatewayV2(event events.APIGatewayV2HTTPRequest) (Request, error) {
	path := normalizeAPIGatewayV2StagePath(
		event.RawPath,
		event.RequestContext.HTTP.Path,
		event.RequestContext.Stage,
	)
	req, err := requestFromHTTPEvent(
		event.RawQueryString,
		event.QueryStringParameters,
		event.Headers,
		event.Cookies,
		path,
		event.RequestContext.HTTP.Method,
		event.RequestContext.HTTP.Path,
		event.Body,
		event.IsBase64Encoded,
	)
	if err != nil {
		return Request{}, err
	}
	req.SourceProvenance = sourceProvenanceFromProviderRequestContext(
		sourceProvenanceProviderAPIGatewayV2,
		event.RequestContext.HTTP.SourceIP,
	)
	return req, nil
}

func normalizeAPIGatewayV2StagePath(rawPath, requestContextHTTPPath, stage string) string {
	path := rawPath
	if path == "" {
		path = requestContextHTTPPath
	}
	stage = strings.Trim(strings.TrimSpace(stage), "/")
	if stage == "" || stage == "$default" {
		return path
	}
	prefix := "/" + stage
	if path == prefix {
		return "/"
	}
	if strings.HasPrefix(path, prefix+"/") {
		return strings.TrimPrefix(path, prefix)
	}
	return path
}

func requestFromLambdaFunctionURL(event events.LambdaFunctionURLRequest) (Request, error) {
	req, err := requestFromHTTPEvent(
		event.RawQueryString,
		event.QueryStringParameters,
		event.Headers,
		event.Cookies,
		event.RawPath,
		event.RequestContext.HTTP.Method,
		event.RequestContext.HTTP.Path,
		event.Body,
		event.IsBase64Encoded,
	)
	if err != nil {
		return Request{}, err
	}
	req.SourceProvenance = sourceProvenanceFromProviderRequestContext(
		sourceProvenanceProviderLambdaURL,
		event.RequestContext.HTTP.SourceIP,
	)
	return req, nil
}

func requestFromHTTPEvent(
	rawQueryString string,
	queryStringParameters map[string]string,
	singleHeaders map[string]string,
	cookies []string,
	rawPath string,
	requestContextHTTPMethod string,
	requestContextHTTPPath string,
	body string,
	isBase64Encoded bool,
) (Request, error) {
	rawQuery := strings.TrimPrefix(rawQueryString, "?")
	query, err := parseEventRawQuery(rawQuery, queryStringParameters)
	if err != nil {
		return Request{}, err
	}

	headers := headersFromSingle(singleHeaders, len(cookies) > 0)
	if len(cookies) > 0 {
		headers["cookie"] = append([]string(nil), cookies...)
	}

	path := rawPath
	if path == "" {
		path = requestContextHTTPPath
	}

	return Request{
		Method:   requestContextHTTPMethod,
		Path:     path,
		Query:    query,
		Headers:  headers,
		Body:     []byte(body),
		IsBase64: isBase64Encoded,
	}, nil
}

// apigatewayV2ResponseFromResponse converts a canonical Response into the
// buffered HTTP API v2 (payload format 2.0) shape.
//
// HTTP API v2 cannot deliver incremental responses, so a streaming body
// (BodyReader / BodyStream) must already have been drained into the buffered
// body with a bounded byte and time budget (bufferedAdapterResponse). A stream
// that does not terminate within the budget fails closed with a documented
// error instead of silently returning an empty 200 (which caused SSE clients
// to reconnect in a tight loop against throttled stages).
func apigatewayV2ResponseFromResponse(ctx context.Context, resp Response) events.APIGatewayV2HTTPResponse {
	resp = bufferedAdapterResponse(ctx, resp, apigatewayV2StreamingBodyErrorMessage)

	out := events.APIGatewayV2HTTPResponse{
		StatusCode:        resp.Status,
		Headers:           map[string]string{},
		MultiValueHeaders: map[string][]string{},
		Cookies:           append([]string(nil), resp.Cookies...),
		IsBase64Encoded:   resp.IsBase64,
		Body:              string(resp.Body),
	}

	for key, values := range resp.Headers {
		if len(values) == 0 {
			continue
		}
		out.Headers[key] = values[0]
		out.MultiValueHeaders[key] = append([]string(nil), values...)
	}

	if resp.IsBase64 {
		out.Body = base64.StdEncoding.EncodeToString(resp.Body)
	}

	return out
}

// joinAbandonedBodyStream waits for the runtime's own BodyStream producer to
// exit after the invocation's serve context has been canceled.
//
// The buffered adapters cancel the serve context before returning, which is what
// stops a stream limiter (limitBodyStream) blocked on an abandoned body. The
// producer closes its output channel as it returns, so draining it here is the
// join. The join is unconditional: a producer the invocation started must not be
// running once the adapter returns, so the adapter waits for the channel to
// close rather than giving up on a grace window. Every producer the runtime
// creates observes the invocation context and closes its channel with it; a
// handler that supplies a BodyStream is responsible for closing it when the
// context passed to Serve is done, and the adapter then waits for the handler's
// producer exactly as it waits for its own. A producer that never closes is
// bounded by the Lambda function timeout, not abandoned by the framework.
func joinAbandonedBodyStream(stream BodyStream) {
	if stream == nil {
		return
	}

	for {
		// Draining to the close is the join.
		if _, ok := <-stream; !ok {
			return
		}
	}
}

func drainStreamingBodyForAPIGatewayV2(ctx context.Context, resp Response) (Response, error) {
	drainCtx, cancel := context.WithTimeout(ctx, apigatewayV2StreamingBodyTimeout)
	defer cancel()

	var body []byte
	var err error
	if resp.BodyStream != nil {
		body, err = drainBodyStreamForAPIGatewayV2(drainCtx, resp.BodyStream)
	} else {
		body, err = drainBodyReaderForAPIGatewayV2(drainCtx, resp.BodyReader)
	}
	if err != nil {
		// The body could not be delivered. Release it before returning: the
		// reader is the only handle the adapter has on the producer that feeds
		// it, so closing it here is what stops and joins that producer inside
		// the invocation that started it. Every error return from this function
		// closes the body; a path that skipped the close would leave the
		// producer running after the adapter returned.
		closeAbandonedBodyReader(resp.BodyReader)
		return resp, err
	}

	resp.Body = body
	resp.BodyReader = nil
	resp.BodyStream = nil
	return resp, nil
}

// closeAbandonedBodyReader closes a body reader the adapter could not deliver.
//
// It is idempotent for the runtime's own readers (streamjoin bodies close once,
// and limitedBodyReader delegates to the same once-guarded close), so the drain
// path and the adapter's cleanup can both run it.
func closeAbandonedBodyReader(reader io.Reader) {
	if reader == nil {
		return
	}
	if closer, ok := reader.(io.Closer); ok {
		if err := closer.Close(); err != nil {
			_ = err
		}
	}
}

// deadlineReachedByWallClock reports whether ctx's deadline has been reached by
// wall clock, independent of whether cancellation has propagated to ctx.Err()
// yet. It is the deterministic counterpart of ctx.Err() != nil for the
// empty-EOF-at-deadline guard: when the drain deadline and the producer's
// unwind coincide (the request context and the drain context share the earlier
// of the two deadlines, so they expire at the same instant), the pipe writer's
// EOF can win the drain select while ctx.Err() is still nil, because the
// parent-cancel propagation runs on a different core than the writer/reader
// chain. Comparing against ctx.Deadline() — the exact instant the context's
// timer fires — closes that window in every configuration (a parent carrying
// an earlier deadline, or the drain's own budget expiring). A context without
// a deadline (ok == false) never triggers the wall-clock branch; the guard
// then relies on ctx.Err() alone, matching the pre-fix behavior.
func deadlineReachedByWallClock(ctx context.Context) bool {
	d, ok := ctx.Deadline()
	return ok && !time.Now().Before(d)
}

// drainBodyReaderForAPIGatewayV2 drains a reader body under the drain context.
//
// The drain is structured so the adapter can never return while a read it
// started is still running, and so it never abandons one:
//
//   - A closable reader is drained on a worker so the drain budget can interrupt
//     a blocked read. When the deadline fires the adapter closes the reader
//     first (io.Closer guarantees Close unblocks a blocked Read, which covers
//     every reader the runtime produces and handler-supplied bodies that own an
//     external resource) and then waits for the worker unconditionally. A closer
//     that violates the io.Closer contract is bounded by the Lambda function
//     timeout, not abandoned.
//   - A reader that is not closable is read on the invoking goroutine. There is
//     no worker to abandon, and nothing the adapter could use to interrupt the
//     read by construction, so the invocation — not the adapter — bounds a
//     reader that neither terminates nor can be closed.
func drainBodyReaderForAPIGatewayV2(ctx context.Context, reader io.Reader) ([]byte, error) {
	if reader == nil {
		return nil, nil
	}

	closer, closable := reader.(io.Closer)
	if !closable {
		return readInlineBoundedForAPIGatewayV2(ctx, reader)
	}

	type readResult struct {
		body []byte
		err  error
	}

	done := make(chan readResult, 1)
	go func() {
		body, err := readAllBoundedForAPIGatewayV2(reader)
		done <- readResult{body: body, err: err}
	}()

	select {
	case res := <-done:
		// A reader that ended with an empty body on or after the drain
		// deadline is a non-terminating stream, not a legitimate empty
		// response: fail closed so the caller cannot ship the silent empty
		// 200. The wall-clock deadline comparison (deadlineReachedByWallClock)
		// keeps the guard deterministic even when the pipe writer's unwind
		// EOF wins the select inside the parent-cancel propagation window,
		// where ctx.Err() is still nil; the ctx.Err() branch additionally
		// covers a parent cancel that fires before the drain deadline (for
		// example the MCP session-listener unwind after its request context
		// expires). A legitimately empty terminating stream that ends before
		// the deadline still returns its empty body.
		if res.err == nil && len(res.body) == 0 && (ctx.Err() != nil || deadlineReachedByWallClock(ctx)) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			return nil, context.DeadlineExceeded
		}
		return res.body, res.err
	case <-ctx.Done():
		// The invocation is abandoning this body. Unblock the drain worker and
		// wait for it to exit before returning: a worker left reading a body
		// that nobody consumes would outlive the invocation it was started in.
		if closeErr := closer.Close(); closeErr != nil {
			_ = closeErr
		}
		<-done
		return nil, ctx.Err()
	}
}

// readInlineBoundedForAPIGatewayV2 drains a reader the adapter cannot interrupt
// on the invoking goroutine, applying the same empty-EOF-at-deadline guard the
// worker path uses so both paths agree on the fail-closed shape.
func readInlineBoundedForAPIGatewayV2(ctx context.Context, reader io.Reader) ([]byte, error) {
	body, err := readAllBoundedForAPIGatewayV2(reader)
	if err == nil && len(body) == 0 && (ctx.Err() != nil || deadlineReachedByWallClock(ctx)) {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, context.DeadlineExceeded
	}
	return body, err
}

func readAllBoundedForAPIGatewayV2(reader io.Reader) ([]byte, error) {
	var body []byte
	buf := make([]byte, 32*1024)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			if len(body)+n > apigatewayV2StreamingBodyMaxBytes {
				return nil, errAPIGatewayV2StreamingBodyTooLarge
			}
			body = append(body, buf[:n]...)
		}
		if err == io.EOF {
			return body, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

func drainBodyStreamForAPIGatewayV2(ctx context.Context, stream BodyStream) ([]byte, error) {
	var body []byte
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case chunk, ok := <-stream:
			if !ok {
				// Same deadline guard as the reader path: a stream that
				// closed empty on or after the drain deadline is
				// non-terminating and must fail closed even when ctx.Err()
				// has not propagated yet; a legitimately empty terminating
				// stream that ends before the deadline still returns its
				// empty body.
				if len(body) == 0 && (ctx.Err() != nil || deadlineReachedByWallClock(ctx)) {
					if err := ctx.Err(); err != nil {
						return nil, err
					}
					return nil, context.DeadlineExceeded
				}
				return body, nil
			}
			if chunk.Err != nil {
				return nil, chunk.Err
			}
			if len(body)+len(chunk.Bytes) > apigatewayV2StreamingBodyMaxBytes {
				return nil, errAPIGatewayV2StreamingBodyTooLarge
			}
			body = append(body, chunk.Bytes...)
		}
	}
}

// lambdaFunctionURLResponseFromResponse converts a canonical Response into the
// buffered Lambda Function URL shape.
//
// A Function URL invocation can be served in streaming mode, but this buffered
// adapter cannot deliver incremental responses, so a streaming body
// (BodyReader / BodyStream) must already have been drained into the buffered
// body with the same bounded byte and time budget as the HTTP API v2 adapter
// (bufferedAdapterResponse). A stream that does not terminate within the budget
// fails closed with a documented error instead of silently returning an empty
// 200.
func lambdaFunctionURLResponseFromResponse(ctx context.Context, resp Response) events.LambdaFunctionURLResponse {
	resp = bufferedAdapterResponse(ctx, resp, lambdaFunctionURLStreamingBodyErrorMessage)

	out := events.LambdaFunctionURLResponse{
		StatusCode:      resp.Status,
		Headers:         map[string]string{},
		Cookies:         append([]string(nil), resp.Cookies...),
		IsBase64Encoded: resp.IsBase64,
		Body:            string(resp.Body),
	}

	for key, values := range resp.Headers {
		if len(values) == 0 {
			continue
		}
		out.Headers[key] = strings.Join(values, ",")
	}

	if resp.IsBase64 {
		out.Body = base64.StdEncoding.EncodeToString(resp.Body)
	}

	return out
}

func headersFromSingle(headers map[string]string, ignoreCookieHeader bool) map[string][]string {
	out := map[string][]string{}
	for key, value := range headers {
		if ignoreCookieHeader && strings.EqualFold(key, "cookie") {
			continue
		}
		out[key] = []string{value}
	}
	return out
}

func parseEventRawQuery(raw string, single map[string]string) (map[string][]string, error) {
	if raw != "" {
		values, err := url.ParseQuery(raw)
		if err != nil {
			return nil, &AppError{Code: errorCodeBadRequest, Message: errorMessageInvalidQueryString}
		}
		out := map[string][]string{}
		for key, vs := range values {
			out[key] = append([]string(nil), vs...)
		}
		return out, nil
	}

	out := map[string][]string{}
	for key, value := range single {
		out[key] = []string{value}
	}
	return out, nil
}
