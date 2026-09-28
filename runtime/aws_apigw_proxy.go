package apptheory

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"strings"
	"sync"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory/v4/runtime/internal/streamjoin"
)

const apigatewayProxyStreamingRouteStageVariablePrefix = "APPTHEORYSTREAMINGV1"

func (a *App) ServeAPIGatewayProxy(ctx context.Context, event events.APIGatewayProxyRequest) events.APIGatewayProxyResponse {
	req, err := requestFromAPIGatewayProxy(event)
	if err != nil {
		return apigatewayProxyResponseFromResponse(a.responseForHTTPError(err))
	}
	if ctx == nil {
		ctx = context.Background()
	}

	serveCtx, resp, finishInvocation := a.serveForBufferedAdapter(ctx, req)
	defer finishInvocation()

	return apigatewayProxyResponseFromResponse(bufferedAdapterResponse(serveCtx, resp, apigatewayProxyStreamingBodyErrorMessage))
}

func (a *App) serveAPIGatewayProxyLambda(ctx context.Context, event events.APIGatewayProxyRequest) any {
	streamingRoute := isAPIGatewayProxyStreamingRoute(event)

	req, err := requestFromAPIGatewayProxy(event)
	if err != nil {
		if streamingRoute {
			return apigatewayProxyStreamingResponseFromResponse(a.responseForHTTPError(err))
		}
		return apigatewayProxyResponseFromResponse(a.responseForHTTPError(err))
	}
	if ctx == nil {
		ctx = context.Background()
	}

	serveCtx, cancelServe, resp := a.serveScoped(ctx, req)

	// Response streaming hands the body to the transport, which reads it and
	// closes it (which stops and joins the producer) itself. The serve context
	// must stay live while the transport reads, so this path cancels nothing
	// here: a portable BodyStream is joined through streamjoin below, and that
	// join cancels the serve context when the transport closes the body.
	if streamingRoute || (!resp.IsBase64 && isTextEventStream(resp.Headers)) {
		return apigatewayProxyStreamingResponseFromResponse(joinStreamingResponseBody(serveCtx, cancelServe, resp))
	}

	// Buffered delivery: the adapter owns the body's lifetime, so it cancels the
	// invocation scope and joins the body before returning.
	defer func() {
		cancelServe()
		joinAbandonedBodyStream(resp.BodyStream)
	}()
	return apigatewayProxyResponseFromResponse(bufferedAdapterResponse(serveCtx, resp, apigatewayProxyStreamingBodyErrorMessage))
}

func requestFromAPIGatewayProxy(event events.APIGatewayProxyRequest) (Request, error) {
	path := apigatewayProxyRequestPath(event)

	method := event.HTTPMethod
	if method == "" {
		method = event.RequestContext.HTTPMethod
	}

	return Request{
		Method:   method,
		Path:     path,
		Query:    queryFromProxyEvent(event.QueryStringParameters, event.MultiValueQueryStringParameters),
		Headers:  headersFromProxyEvent(event.Headers, event.MultiValueHeaders),
		Body:     []byte(event.Body),
		IsBase64: event.IsBase64Encoded,
		SourceProvenance: sourceProvenanceFromProviderRequestContext(
			sourceProvenanceProviderAPIGatewayV1,
			event.RequestContext.Identity.SourceIP,
		),
	}, nil
}

func apigatewayProxyRequestPath(event events.APIGatewayProxyRequest) string {
	path := event.Path
	if path == "" {
		path = event.RequestContext.Path
	}
	if !shouldCanonicalizeAPIGatewayProxyRequestPath(event) {
		return path
	}
	return canonicalizeAPIGatewayProxyRequestPath(path)
}

func shouldCanonicalizeAPIGatewayProxyRequestPath(event events.APIGatewayProxyRequest) bool {
	switch apigatewayProxyMatchedResource(event) {
	case "/mcp",
		"/mcp/{actor}",
		"/.well-known/oauth-protected-resource/mcp",
		"/.well-known/oauth-protected-resource/mcp/{actor}":
		return true
	default:
		return false
	}
}

func canonicalizeAPIGatewayProxyRequestPath(path string) string {
	normalized := normalizePath(path)
	if normalized == "/" {
		return normalized
	}
	return strings.TrimRight(normalized, "/")
}

func isTextEventStream(headers map[string][]string) bool {
	for _, value := range headers["content-type"] {
		v := strings.TrimSpace(strings.ToLower(value))
		if strings.HasPrefix(v, "text/event-stream") {
			return true
		}
	}
	return false
}

func isAPIGatewayProxyStreamingRoute(event events.APIGatewayProxyRequest) bool {
	if len(event.StageVariables) == 0 {
		return false
	}

	resource := apigatewayProxyRouteResource(event)
	if resource == "" {
		return false
	}

	method := apigatewayProxyRouteMethod(event)
	if method != "" {
		if _, ok := event.StageVariables[apigatewayProxyStreamingRouteStageVariableName(method, resource)]; ok {
			return true
		}
	}

	_, ok := event.StageVariables[apigatewayProxyStreamingRouteStageVariableName("ANY", resource)]
	return ok
}

func apigatewayProxyRouteMethod(event events.APIGatewayProxyRequest) string {
	method := strings.TrimSpace(event.HTTPMethod)
	if method == "" {
		method = strings.TrimSpace(event.RequestContext.HTTPMethod)
	}
	return strings.ToUpper(method)
}

func apigatewayProxyRouteResource(event events.APIGatewayProxyRequest) string {
	if resource := apigatewayProxyMatchedResource(event); resource != "" {
		return resource
	}
	return normalizeAPIGatewayProxyRoutePath(event.Path)
}

func apigatewayProxyMatchedResource(event events.APIGatewayProxyRequest) string {
	if resource := normalizeAPIGatewayProxyRoutePath(event.Resource); resource != "/" {
		return resource
	}
	if resource := normalizeAPIGatewayProxyRoutePath(event.RequestContext.ResourcePath); resource != "/" {
		return resource
	}
	return ""
}

func normalizeAPIGatewayProxyRoutePath(path string) string {
	trimmed := strings.Trim(strings.TrimSpace(path), "/")
	if trimmed == "" {
		return "/"
	}

	parts := strings.Split(trimmed, "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		out = append(out, part)
	}
	if len(out) == 0 {
		return "/"
	}
	return "/" + strings.Join(out, "/")
}

func apigatewayProxyStreamingRouteStageVariableName(method, resource string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(strings.ToUpper(method)) + " " + normalizeAPIGatewayProxyRoutePath(resource)))
	return apigatewayProxyStreamingRouteStageVariablePrefix + hex.EncodeToString(sum[:16])
}

// joinStreamingResponseBody converts a portable BodyStream into a body the
// response-streaming transport can read and close.
//
// The v1 response-streaming transport owns the body: it reads it and closes it
// when the POST completes, errors, or the client disconnects — but only when
// the body is an io.ReadCloser, and a portable BodyStream is a channel. Without
// this conversion the transport would see an empty body and hold no handle on
// the producers behind it, so the response limiter (limitBodyStream) and the
// handler's own producer would outlive the invocation. The converted body joins
// them (see joinedBodyStream).
func joinStreamingResponseBody(ctx context.Context, cancel context.CancelFunc, resp Response) Response {
	if resp.BodyStream == nil {
		return resp
	}

	stream := resp.BodyStream
	body := streamjoin.New(ctx, func(streamCtx context.Context, pw *io.PipeWriter) {
		streamBodyStreamChunks(streamCtx, pw, stream)
	})
	resp.BodyReader = &joinedBodyStream{body: body, cancel: cancel, stream: stream}
	resp.BodyStream = nil
	return resp
}

// streamBodyStreamChunks copies a portable BodyStream's chunks into the pipe the
// streamjoin body reads, preserving chunk boundaries and terminal stream errors.
func streamBodyStreamChunks(ctx context.Context, pw *io.PipeWriter, stream BodyStream) {
	defer safeClosePipeWriter(pw)

	if stream == nil {
		return
	}

	for {
		select {
		case <-ctx.Done():
			return
		case chunk, ok := <-stream:
			if !ok {
				return
			}
			if chunk.Err != nil {
				closePipeWriterWithError(pw, chunk.Err)
				return
			}
			if len(chunk.Bytes) == 0 {
				continue
			}
			if _, err := pw.Write(chunk.Bytes); err != nil {
				return
			}
		}
	}
}

// joinedBodyStream is the closable body a response-streaming transport receives
// for a portable BodyStream response.
//
// streamjoin turns the stream into a reader that reports EOF only after its
// producer has returned. This wrapper adds the two releases the transport's
// close must also perform on the stream that produced it:
//
//   - it cancels the serve context, which stops a response limiter
//     (limitBodyStream) blocked on the abandoned body;
//   - it drains the limiter's output channel to its close, so the limiter's
//     producer is joined rather than merely signaled.
//
// Reaching EOF performs the same release, so a transport that drains the body
// to completion also leaves no producer behind.
type joinedBodyStream struct {
	body   *streamjoin.Body
	cancel context.CancelFunc
	stream BodyStream

	once sync.Once
}

func (b *joinedBodyStream) Read(p []byte) (int, error) {
	if b == nil || b.body == nil {
		return 0, io.EOF
	}

	n, err := b.body.Read(p)
	if err != nil {
		b.release()
	}
	return n, err
}

func (b *joinedBodyStream) Close() error {
	if b == nil {
		return nil
	}

	var err error
	if b.body != nil {
		err = b.body.Close()
	}
	b.release()
	return err
}

func (b *joinedBodyStream) release() {
	b.once.Do(func() {
		if b.cancel != nil {
			b.cancel()
		}
		joinAbandonedBodyStream(b.stream)
	})
}

// streamingBodyReader is the body a response-streaming transport is handed.
//
// It is an io.Closer for every combination of a buffered prefix and a streaming
// reader, and its Close reaches the streaming reader's own closer. The
// aws-lambda-go streaming runtime closes the response (and therefore the body)
// when the POST completes, errors, or the client disconnects — but
// APIGatewayProxyStreamingResponse.Close only reaches the body when the body is
// an io.ReadCloser, and a bare io.MultiReader is not. Composing the prefix and
// the stream here keeps the close path intact, so a client disconnect on the v1
// streaming route stops and joins the SSE writer and the forwarder behind it.
type streamingBodyReader struct {
	io.Reader
	closers []io.Closer
}

func (r *streamingBodyReader) Close() error {
	if r == nil {
		return nil
	}
	var firstErr error
	for _, closer := range r.closers {
		if closer == nil {
			continue
		}
		if err := closer.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// apigatewayProxyStreamingResponseFromResponse builds the streaming envelope.
//
// A portable BodyStream is not a reader, so it MUST already have been converted
// to a closable reader by joinStreamingResponseBody. The error-path caller cannot
// carry one — error responses are buffered — and the streaming caller converts
// before it calls here, so a BodyStream left on the response is dropped.
func apigatewayProxyStreamingResponseFromResponse(resp Response) *events.APIGatewayProxyStreamingResponse {
	body := io.Reader(bytes.NewReader(resp.Body))
	var closers []io.Closer
	if resp.BodyReader != nil {
		if closer, ok := resp.BodyReader.(io.Closer); ok {
			closers = append(closers, closer)
		}
		if len(resp.Body) > 0 {
			body = io.MultiReader(bytes.NewReader(resp.Body), resp.BodyReader)
		} else {
			body = resp.BodyReader
		}
	}

	out := &events.APIGatewayProxyStreamingResponse{
		StatusCode:        resp.Status,
		Headers:           map[string]string{},
		MultiValueHeaders: map[string][]string{},
		Cookies:           append([]string(nil), resp.Cookies...),
		Body:              &streamingBodyReader{Reader: body, closers: closers},
	}

	for key, values := range resp.Headers {
		if len(values) == 0 {
			continue
		}
		out.Headers[key] = values[0]
		out.MultiValueHeaders[key] = append([]string(nil), values...)
	}

	return out
}
