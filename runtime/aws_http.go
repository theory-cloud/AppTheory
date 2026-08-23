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
	// deliver. It is returned as HTTP 500 with the nested AppTheory error body.
	apigatewayV2StreamingBodyErrorMessage = "streaming response body cannot be delivered by the HTTP API v2 adapter"

	// lambdaFunctionURLStreamingBodyErrorMessage is the documented
	// client-visible error for a streaming response body the buffered Lambda
	// Function URL adapter cannot deliver. It is returned as HTTP 500 with the
	// nested AppTheory error body, matching the HTTP API v2 fail-closed shape
	// with the adapter named in the message.
	lambdaFunctionURLStreamingBodyErrorMessage = "streaming response body cannot be delivered by the Function URL adapter"
)

// The HTTP API v2 and Lambda Function URL adapters both deliver buffered
// responses only, so they share the same bounded drain budget
// (apigatewayV2StreamingBodyMaxBytes / apigatewayV2StreamingBodyTimeout) and
// the same fail-closed semantics; only the client-visible error message names
// the adapter that could not deliver the body.

var errAPIGatewayV2StreamingBodyTooLarge = errors.New("apptheory: streaming response body exceeds HTTP API v2 adapter budget")

func (a *App) ServeAPIGatewayV2(ctx context.Context, event events.APIGatewayV2HTTPRequest) events.APIGatewayV2HTTPResponse {
	req, err := requestFromAPIGatewayV2(event)
	if err != nil {
		return apigatewayV2ResponseFromResponse(ctx, a.responseForHTTPError(err))
	}
	return apigatewayV2ResponseFromResponse(ctx, a.Serve(ctx, req))
}

func (a *App) ServeLambdaFunctionURL(ctx context.Context, event events.LambdaFunctionURLRequest) events.LambdaFunctionURLResponse {
	req, err := requestFromLambdaFunctionURL(event)
	if err != nil {
		return lambdaFunctionURLResponseFromResponse(ctx, a.responseForHTTPError(err))
	}
	return lambdaFunctionURLResponseFromResponse(ctx, a.Serve(ctx, req))
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
// (BodyReader / BodyStream) is drained into the buffered body with a bounded
// byte and time budget. A terminating stream is delivered as content; a stream
// that does not terminate within the budget fails closed with a documented
// error instead of silently returning an empty 200 (which caused SSE clients
// to reconnect in a tight loop against throttled stages).
func apigatewayV2ResponseFromResponse(ctx context.Context, resp Response) events.APIGatewayV2HTTPResponse {
	if ctx == nil {
		ctx = context.Background()
	}
	if resp.BodyReader != nil || resp.BodyStream != nil {
		drained, err := drainStreamingBodyForAPIGatewayV2(ctx, resp)
		if err != nil {
			return apigatewayV2ResponseFromResponse(
				ctx,
				errorResponse(errorCodeInternal, apigatewayV2StreamingBodyErrorMessage, nil),
			)
		}
		resp = drained
	}

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
		return resp, err
	}

	resp.Body = body
	resp.BodyReader = nil
	resp.BodyStream = nil
	return resp, nil
}

func drainBodyReaderForAPIGatewayV2(ctx context.Context, reader io.Reader) ([]byte, error) {
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
		// A reader that ended with an empty body because the drain deadline
		// fired is a non-terminating stream, not a legitimate empty response:
		// fail closed so the caller cannot ship the silent empty 200.
		if res.err == nil && len(res.body) == 0 && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return res.body, res.err
	case <-ctx.Done():
		// Unblock a blocked pipe read so the drain goroutine can exit instead
		// of leaking until the producer writes or closes. Only pipe readers are
		// closed; other readers either do not block (bytes.Reader) or own their
		// own lifecycle.
		if pr, ok := reader.(*io.PipeReader); ok {
			if err := pr.Close(); err != nil {
				_ = err
			}
		}
		return nil, ctx.Err()
	}
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
				// Same deadline guard as the reader path: a stream that closed
				// empty because the drain deadline fired is non-terminating.
				if len(body) == 0 && ctx.Err() != nil {
					return nil, ctx.Err()
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
// (BodyReader / BodyStream) is drained into the buffered body with the same
// bounded byte and time budget as the HTTP API v2 adapter
// (drainStreamingBodyForAPIGatewayV2). A terminating stream is delivered as
// content; a stream that does not terminate within the budget fails closed
// with a documented error instead of silently returning an empty 200.
func lambdaFunctionURLResponseFromResponse(ctx context.Context, resp Response) events.LambdaFunctionURLResponse {
	if ctx == nil {
		ctx = context.Background()
	}
	if resp.BodyReader != nil || resp.BodyStream != nil {
		drained, err := drainStreamingBodyForAPIGatewayV2(ctx, resp)
		if err != nil {
			return lambdaFunctionURLResponseFromResponse(
				ctx,
				errorResponse(errorCodeInternal, lambdaFunctionURLStreamingBodyErrorMessage, nil),
			)
		}
		resp = drained
	}

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
