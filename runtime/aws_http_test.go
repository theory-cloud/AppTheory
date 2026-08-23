package apptheory

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
)

func TestParseEventRawQuery(t *testing.T) {
	out, err := parseEventRawQuery("a=1&a=2&b=x", nil)
	if err != nil {
		t.Fatalf("parseEventRawQuery returned error: %v", err)
	}
	if len(out["a"]) != 2 || out["a"][0] != "1" || out["a"][1] != "2" {
		t.Fatalf("unexpected parsed query: %v", out)
	}
	if out["b"][0] != "x" {
		t.Fatalf("unexpected parsed query: %v", out)
	}

	_, err = parseEventRawQuery("%zz", nil)
	if err == nil {
		t.Fatal("expected error for invalid raw query")
	}
}

func TestHeadersFromSingle_IgnoreCookieHeader(t *testing.T) {
	out := headersFromSingle(map[string]string{
		"cookie": "a=b",
		"x-test": "v",
	}, true)
	if _, ok := out["cookie"]; ok {
		t.Fatal("expected cookie header to be ignored")
	}
	if out["x-test"][0] != "v" {
		t.Fatalf("unexpected headers: %v", out)
	}
}

func TestRequestFromHTTPEvent_IncludesCookiesAndRawQuery(t *testing.T) {
	req, err := requestFromHTTPEvent(
		"?a=1&a=2",
		map[string]string{"ignored": "x"},
		map[string]string{"cookie": "ignored", "x-test": "v"},
		[]string{"a=b", "c=d"},
		"/path",
		"GET",
		"",
		"body",
		false,
	)
	if err != nil {
		t.Fatalf("requestFromHTTPEvent returned error: %v", err)
	}
	if req.Path != "/path" || req.Method != "GET" {
		t.Fatalf("unexpected request: %#v", req)
	}
	if len(req.Query["a"]) != 2 {
		t.Fatalf("unexpected query: %v", req.Query)
	}
	if len(req.Headers["cookie"]) != 2 || req.Headers["cookie"][0] != "a=b" {
		t.Fatalf("unexpected cookie headers: %v", req.Headers["cookie"])
	}
}

func TestAPIGatewayV2ResponseFromResponse_Base64(t *testing.T) {
	resp := Response{
		Status:   200,
		Headers:  map[string][]string{"x-test": {"a", "b"}},
		Cookies:  []string{"a=b"},
		Body:     []byte{0x01, 0x02},
		IsBase64: true,
	}
	out := apigatewayV2ResponseFromResponse(context.Background(), resp)
	if out.StatusCode != 200 || !out.IsBase64Encoded {
		t.Fatalf("unexpected apigw v2 response: %#v", out)
	}
	if out.Headers["x-test"] != "a" || len(out.MultiValueHeaders["x-test"]) != 2 {
		t.Fatalf("unexpected headers: %#v", out)
	}
	if out.Body != base64.StdEncoding.EncodeToString(resp.Body) {
		t.Fatalf("unexpected body: %q", out.Body)
	}
}

func TestLambdaFunctionURLResponseFromResponse_JoinsMultiHeaders(t *testing.T) {
	resp := Response{
		Status:  201,
		Headers: map[string][]string{"x-test": {"a", "b"}},
		Body:    []byte("ok"),
	}
	out := lambdaFunctionURLResponseFromResponse(context.Background(), resp)
	if out.StatusCode != 201 {
		t.Fatalf("unexpected status: %d", out.StatusCode)
	}
	if out.Headers["x-test"] != "a,b" {
		t.Fatalf("unexpected joined header: %q", out.Headers["x-test"])
	}
}

func TestRequestFromAPIGatewayV2AndLambdaURL(t *testing.T) {
	v2 := events.APIGatewayV2HTTPRequest{
		RawPath:        "/v2",
		RawQueryString: "a=1",
		Headers:        map[string]string{"x-test": "v"},
		Cookies:        []string{"a=b"},
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method: "GET",
				Path:   "/ignored",
			},
		},
	}
	req, err := requestFromAPIGatewayV2(v2)
	if err != nil {
		t.Fatalf("requestFromAPIGatewayV2 returned error: %v", err)
	}
	if req.Path != "/v2" || req.Method != "GET" {
		t.Fatalf("unexpected request: %#v", req)
	}

	url := events.LambdaFunctionURLRequest{
		RawPath:        "/url",
		RawQueryString: "",
		QueryStringParameters: map[string]string{
			"a": "1",
		},
		Headers: map[string]string{"x-test": "v"},
		RequestContext: events.LambdaFunctionURLRequestContext{
			HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{
				Method: "POST",
				Path:   "/ignored",
			},
		},
	}
	req, err = requestFromLambdaFunctionURL(url)
	if err != nil {
		t.Fatalf("requestFromLambdaFunctionURL returned error: %v", err)
	}
	if req.Path != "/url" || req.Method != "POST" || req.Query["a"][0] != "1" {
		t.Fatalf("unexpected request: %#v", req)
	}
}

func requireAPIGatewayV2StreamingError(t *testing.T, out events.APIGatewayV2HTTPResponse) {
	t.Helper()
	if out.StatusCode != 500 {
		t.Fatalf("expected fail-closed status 500, got %d (body: %q)", out.StatusCode, out.Body)
	}
	if ct := out.Headers["content-type"]; !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("expected JSON error content type, got %q", ct)
	}
	if !strings.Contains(out.Body, `"error"`) {
		t.Fatalf("expected nested AppTheory error body, got %q", out.Body)
	}
	if !strings.Contains(out.Body, apigatewayV2StreamingBodyErrorMessage) {
		t.Fatalf("expected documented streaming error message in body, got %q", out.Body)
	}
}

// requireAPIGatewayV2TooLarge asserts the size-semantics mapping for a
// streaming body that exceeds the drain byte budget: HTTP 413 with the
// framework's app.too_large error shape instead of the 500 fail-closed shape
// used for non-size drain failures (non-termination, stream errors).
func requireAPIGatewayV2TooLarge(t *testing.T, out events.APIGatewayV2HTTPResponse) {
	t.Helper()
	if out.StatusCode != 413 {
		t.Fatalf("expected payload-too-large status 413, got %d (body: %q)", out.StatusCode, out.Body)
	}
	if ct := out.Headers["content-type"]; !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("expected JSON error content type, got %q", ct)
	}
	if !strings.Contains(out.Body, errorMessageResponseTooLarge) {
		t.Fatalf("expected response-too-large message in body, got %q", out.Body)
	}
	if !strings.Contains(out.Body, `"app.too_large"`) {
		t.Fatalf("expected app.too_large error code in body, got %q", out.Body)
	}
}

func TestAPIGatewayV2ResponseFromResponse_BuffersTerminatingBodyReader(t *testing.T) {
	resp := Response{
		Status:     200,
		Headers:    map[string][]string{"content-type": {"text/event-stream"}},
		BodyReader: strings.NewReader("data: hello\n\n"),
	}
	out := apigatewayV2ResponseFromResponse(context.Background(), resp)
	if out.StatusCode != 200 {
		t.Fatalf("unexpected status: %d", out.StatusCode)
	}
	if out.Body != "data: hello\n\n" {
		t.Fatalf("expected drained body, got %q", out.Body)
	}
	if out.Headers["content-type"] != "text/event-stream" {
		t.Fatalf("expected content-type preserved, got %#v", out.Headers)
	}
}

func TestAPIGatewayV2ResponseFromResponse_NonTerminatingBodyReaderFailsClosed(t *testing.T) {
	pr, _ := io.Pipe() // never written, never closed: a live stream
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	out := apigatewayV2ResponseFromResponse(ctx, Response{Status: 200, BodyReader: pr})
	elapsed := time.Since(start)

	if elapsed > 2*time.Second {
		t.Fatalf("non-terminating body did not fail closed promptly (elapsed %s)", elapsed)
	}
	requireAPIGatewayV2StreamingError(t, out)
}

func TestAPIGatewayV2ResponseFromResponse_BodyReaderOverrunFailsClosed(t *testing.T) {
	over := bytes.NewReader(make([]byte, apigatewayV2StreamingBodyMaxBytes+1))
	out := apigatewayV2ResponseFromResponse(context.Background(), Response{Status: 200, BodyReader: over})
	requireAPIGatewayV2TooLarge(t, out)
}

func TestAPIGatewayV2ResponseFromResponse_BodyStreamOverrunIsTooLarge(t *testing.T) {
	// Denial-shape test for the size-semantics mapping: a streamed body that
	// exceeds the drain byte budget must map to 413 app.too_large, not the 500
	// delivery-failure shape used for non-termination and stream errors.
	over := StreamBytes(make([]byte, apigatewayV2StreamingBodyMaxBytes+1))
	out := apigatewayV2ResponseFromResponse(context.Background(), Response{Status: 200, BodyStream: over})
	requireAPIGatewayV2TooLarge(t, out)
}

func TestLambdaFunctionURLResponseFromResponse_BodyStreamOverrunIsTooLarge(t *testing.T) {
	over := StreamBytes(make([]byte, apigatewayV2StreamingBodyMaxBytes+1))
	out := lambdaFunctionURLResponseFromResponse(context.Background(), Response{Status: 200, BodyStream: over})
	if out.StatusCode != 413 {
		t.Fatalf("expected payload-too-large status 413, got %d (body: %q)", out.StatusCode, out.Body)
	}
	if !strings.Contains(out.Body, errorMessageResponseTooLarge) {
		t.Fatalf("expected response-too-large message in body, got %q", out.Body)
	}
	if !strings.Contains(out.Body, `"app.too_large"`) {
		t.Fatalf("expected app.too_large error code in body, got %q", out.Body)
	}
}

func TestAPIGatewayV2ResponseFromResponse_DrainsBodyStream(t *testing.T) {
	resp := Response{
		Status:     200,
		Headers:    map[string][]string{"content-type": {"text/html; charset=utf-8"}},
		BodyStream: StreamBytes([]byte("a"), []byte("b")),
	}
	out := apigatewayV2ResponseFromResponse(context.Background(), resp)
	if out.StatusCode != 200 {
		t.Fatalf("unexpected status: %d", out.StatusCode)
	}
	if out.Body != "ab" {
		t.Fatalf("expected drained stream body, got %q", out.Body)
	}
}

func TestAPIGatewayV2ResponseFromResponse_BodyStreamErrorFailsClosed(t *testing.T) {
	resp := Response{Status: 200, BodyStream: StreamError(errors.New("boom"))}
	out := apigatewayV2ResponseFromResponse(context.Background(), resp)
	requireAPIGatewayV2StreamingError(t, out)
}

func TestServeAPIGatewayV2_StreamingHandlerDeliversBufferedBody(t *testing.T) {
	app := New()
	app.Get("/sse", func(c *Context) (*Response, error) {
		ch := make(chan SSEEvent, 2)
		ch <- SSEEvent{ID: "1", Data: "first"}
		ch <- SSEEvent{ID: "2", Data: "second"}
		close(ch)
		return SSEStreamResponse(c.Context(), 200, ch)
	})

	out := app.ServeAPIGatewayV2(context.Background(), events.APIGatewayV2HTTPRequest{
		RawPath: "/sse",
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{Method: "GET", Path: "/sse"},
		},
	})

	if out.StatusCode != 200 {
		t.Fatalf("unexpected status: %d (body: %q)", out.StatusCode, out.Body)
	}
	if ct := out.Headers["content-type"]; !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("expected text/event-stream content type, got %q", ct)
	}
	if out.Body == "" {
		t.Fatal("expected non-empty SSE body: the v2 adapter must not silently drop a BodyReader payload")
	}
	if !strings.Contains(out.Body, "first") || !strings.Contains(out.Body, "second") {
		t.Fatalf("expected drained SSE events in body, got %q", out.Body)
	}
}

func TestServeAPIGatewayV2_LiveStreamingHandlerFailsClosed(t *testing.T) {
	app := New()
	app.Get("/live", func(c *Context) (*Response, error) {
		ch := make(chan SSEEvent) // never written, never closed: a live listener
		return SSEStreamResponse(c.Context(), 200, ch)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	out := app.ServeAPIGatewayV2(ctx, events.APIGatewayV2HTTPRequest{
		RawPath: "/live",
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{Method: "GET", Path: "/live"},
		},
	})
	elapsed := time.Since(start)

	if elapsed > 2*time.Second {
		t.Fatalf("live stream did not fail closed promptly (elapsed %s)", elapsed)
	}
	requireAPIGatewayV2StreamingError(t, out)
}

func requireLambdaFunctionURLStreamingError(t *testing.T, out events.LambdaFunctionURLResponse) {
	t.Helper()
	if out.StatusCode != 500 {
		t.Fatalf("expected fail-closed status 500, got %d (body: %q)", out.StatusCode, out.Body)
	}
	if ct := out.Headers["content-type"]; !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("expected JSON error content type, got %q", ct)
	}
	if !strings.Contains(out.Body, `"error"`) {
		t.Fatalf("expected nested AppTheory error body, got %q", out.Body)
	}
	if !strings.Contains(out.Body, lambdaFunctionURLStreamingBodyErrorMessage) {
		t.Fatalf("expected documented streaming error message in body, got %q", out.Body)
	}
}

func TestLambdaFunctionURLResponseFromResponse_BuffersTerminatingBodyReader(t *testing.T) {
	resp := Response{
		Status:     200,
		Headers:    map[string][]string{"content-type": {"text/event-stream"}},
		BodyReader: strings.NewReader("data: hello\n\n"),
	}
	out := lambdaFunctionURLResponseFromResponse(context.Background(), resp)
	if out.StatusCode != 200 {
		t.Fatalf("unexpected status: %d", out.StatusCode)
	}
	if out.Body != "data: hello\n\n" {
		t.Fatalf("expected drained body, got %q", out.Body)
	}
	if out.Headers["content-type"] != "text/event-stream" {
		t.Fatalf("expected content-type preserved, got %#v", out.Headers)
	}
}

func TestLambdaFunctionURLResponseFromResponse_NonTerminatingBodyReaderFailsClosed(t *testing.T) {
	pr, _ := io.Pipe() // never written, never closed: a live stream
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	out := lambdaFunctionURLResponseFromResponse(ctx, Response{Status: 200, BodyReader: pr})
	elapsed := time.Since(start)

	if elapsed > 2*time.Second {
		t.Fatalf("non-terminating body did not fail closed promptly (elapsed %s)", elapsed)
	}
	requireLambdaFunctionURLStreamingError(t, out)
}

func TestLambdaFunctionURLResponseFromResponse_BodyReaderOverrunFailsClosed(t *testing.T) {
	over := bytes.NewReader(make([]byte, apigatewayV2StreamingBodyMaxBytes+1))
	out := lambdaFunctionURLResponseFromResponse(context.Background(), Response{Status: 200, BodyReader: over})
	if out.StatusCode != 413 {
		t.Fatalf("expected payload-too-large status 413, got %d (body: %q)", out.StatusCode, out.Body)
	}
	if !strings.Contains(out.Body, errorMessageResponseTooLarge) {
		t.Fatalf("expected response-too-large message in body, got %q", out.Body)
	}
	if !strings.Contains(out.Body, `"app.too_large"`) {
		t.Fatalf("expected app.too_large error code in body, got %q", out.Body)
	}
}

func TestLambdaFunctionURLResponseFromResponse_DrainsBodyStream(t *testing.T) {
	resp := Response{
		Status:     200,
		Headers:    map[string][]string{"content-type": {"text/html; charset=utf-8"}},
		BodyStream: StreamBytes([]byte("a"), []byte("b")),
	}
	out := lambdaFunctionURLResponseFromResponse(context.Background(), resp)
	if out.StatusCode != 200 {
		t.Fatalf("unexpected status: %d", out.StatusCode)
	}
	if out.Body != "ab" {
		t.Fatalf("expected drained stream body, got %q", out.Body)
	}
}

func TestLambdaFunctionURLResponseFromResponse_BodyStreamErrorFailsClosed(t *testing.T) {
	resp := Response{Status: 200, BodyStream: StreamError(errors.New("boom"))}
	out := lambdaFunctionURLResponseFromResponse(context.Background(), resp)
	requireLambdaFunctionURLStreamingError(t, out)
}

func TestServeLambdaFunctionURL_StreamingHandlerDeliversBufferedBody(t *testing.T) {
	app := New()
	app.Get("/sse", func(c *Context) (*Response, error) {
		ch := make(chan SSEEvent, 2)
		ch <- SSEEvent{ID: "1", Data: "first"}
		ch <- SSEEvent{ID: "2", Data: "second"}
		close(ch)
		return SSEStreamResponse(c.Context(), 200, ch)
	})

	out := app.ServeLambdaFunctionURL(context.Background(), events.LambdaFunctionURLRequest{
		RawPath: "/sse",
		RequestContext: events.LambdaFunctionURLRequestContext{
			HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{Method: "GET", Path: "/sse"},
		},
	})

	if out.StatusCode != 200 {
		t.Fatalf("unexpected status: %d (body: %q)", out.StatusCode, out.Body)
	}
	if ct := out.Headers["content-type"]; !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("expected text/event-stream content type, got %q", ct)
	}
	if out.Body == "" {
		t.Fatal("expected non-empty SSE body: the Function URL adapter must not silently drop a BodyReader payload")
	}
	if !strings.Contains(out.Body, "first") || !strings.Contains(out.Body, "second") {
		t.Fatalf("expected drained SSE events in body, got %q", out.Body)
	}
}

func TestServeLambdaFunctionURL_LiveStreamingHandlerFailsClosed(t *testing.T) {
	app := New()
	app.Get("/live", func(c *Context) (*Response, error) {
		ch := make(chan SSEEvent) // never written, never closed: a live listener
		return SSEStreamResponse(c.Context(), 200, ch)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	out := app.ServeLambdaFunctionURL(ctx, events.LambdaFunctionURLRequest{
		RawPath: "/live",
		RequestContext: events.LambdaFunctionURLRequestContext{
			HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{Method: "GET", Path: "/live"},
		},
	})
	elapsed := time.Since(start)

	if elapsed > 2*time.Second {
		t.Fatalf("live stream did not fail closed promptly (elapsed %s)", elapsed)
	}
	requireLambdaFunctionURLStreamingError(t, out)
}

// deadlineCtxWithNilError is a context whose Deadline() is already in the past
// but whose Err() stays nil and whose Done() never fires. It models the exact
// guard-check instant inside the parent-cancel propagation window: the drain
// deadline has been reached by wall clock, but cancellation has not made
// itself observable through ctx.Err() yet. The pre-fix guard (ctx.Err() != nil
// only) misses on this context and returns the silent empty body; the
// wall-clock deadline comparison catches it deterministically.
type deadlineCtxWithNilError struct {
	context.Context // delegates Value() to context.Background()
	deadline        time.Time
}

func (d deadlineCtxWithNilError) Deadline() (time.Time, bool) { return d.deadline, true }
func (d deadlineCtxWithNilError) Done() <-chan struct{}       { return nil }
func (d deadlineCtxWithNilError) Err() error                  { return nil }

// TestDrainBodyReaderForAPIGatewayV2_EmptyEOFAtDeadlineFailsClosed pins the
// fail-closed guard against the parent-cancel propagation race: an empty EOF
// that lands in the drain select while ctx.Err() is still nil must fail closed
// when the drain deadline has been reached by wall clock. No sleeps, no timing
// dependence: the deadline is pinned to the past and the context never fires.
func TestDrainBodyReaderForAPIGatewayV2_EmptyEOFAtDeadlineFailsClosed(t *testing.T) {
	pr, pw := io.Pipe()
	if err := pw.Close(); err != nil {
		t.Fatalf("close pipe writer: %v", err)
	}

	// The pipe writer already unwound (reader sees an empty EOF) and the drain
	// deadline is already in the past: the guard-check instant is the one where
	// the parent-cancel propagation has not made ctx.Err() observable yet.
	ctx := deadlineCtxWithNilError{context.Background(), time.Now().Add(-time.Second)}
	body, err := drainBodyReaderForAPIGatewayV2(ctx, pr)
	if err == nil {
		t.Fatalf("empty EOF at the drain deadline must fail closed, got body %q with nil error (silent empty 200)", body)
	}
	if len(body) != 0 {
		t.Fatalf("fail-closed drain must not return content, got %q", body)
	}
}

// TestDrainBodyReaderForAPIGatewayV2_EmptyEOFBeforeDeadlineIsLegitimate pins
// the no-false-positive invariant: a legitimately empty terminating stream
// that ends before the drain deadline still returns its empty body (empty 200,
// not a 500).
func TestDrainBodyReaderForAPIGatewayV2_EmptyEOFBeforeDeadlineIsLegitimate(t *testing.T) {
	pr, pw := io.Pipe()
	if err := pw.Close(); err != nil {
		t.Fatalf("close pipe writer: %v", err)
	}

	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(time.Hour))
	defer cancel()
	body, err := drainBodyReaderForAPIGatewayV2(ctx, pr)
	if err != nil {
		t.Fatalf("empty EOF before the deadline is a legitimate empty response, got error %v", err)
	}
	if len(body) != 0 {
		t.Fatalf("expected empty body, got %q", body)
	}
}

// TestDrainBodyReaderForAPIGatewayV2_EmptyEOFAfterParentCancelFailsClosed pins
// the early parent-cancel branch of the guard (the MCP session-listener unwind
// after its request context expires): an empty EOF must fail closed even when
// the wall clock is still before the drain deadline.
func TestDrainBodyReaderForAPIGatewayV2_EmptyEOFAfterParentCancelFailsClosed(t *testing.T) {
	pr, pw := io.Pipe()
	if err := pw.Close(); err != nil {
		t.Fatalf("close pipe writer: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the parent request context already fired
	body, err := drainBodyReaderForAPIGatewayV2(ctx, pr)
	if err == nil {
		t.Fatalf("empty EOF after parent cancel must fail closed, got body %q with nil error (silent empty 200)", body)
	}
	if len(body) != 0 {
		t.Fatalf("fail-closed drain must not return content, got %q", body)
	}
}

// TestDrainBodyReaderForAPIGatewayV2_NonEmptyEOFDelivered pins the
// non-empty-completed-drain invariant: content read before termination is
// delivered regardless of the deadline, so legitimate content never turns into
// a false 500.
func TestDrainBodyReaderForAPIGatewayV2_NonEmptyEOFDelivered(t *testing.T) {
	pr, pw := io.Pipe()
	// io.Pipe writes are synchronous and block until the reader consumes
	// them, so the producer writes and closes from a goroutine while the
	// drain reads.
	go func() {
		if _, err := pw.Write([]byte("data: hello\n\n")); err != nil {
			t.Errorf("write pipe: %v", err)
		}
		if err := pw.Close(); err != nil {
			t.Errorf("close pipe writer: %v", err)
		}
	}()

	// Even with the deadline already reached, non-empty content must pass
	// through: the guard only treats an empty EOF as non-terminating.
	ctx := deadlineCtxWithNilError{context.Background(), time.Now().Add(-time.Second)}
	body, err := drainBodyReaderForAPIGatewayV2(ctx, pr)
	if err != nil {
		t.Fatalf("non-empty completed drain must be delivered, got error %v", err)
	}
	if string(body) != "data: hello\n\n" {
		t.Fatalf("expected drained content, got %q", body)
	}
}

// TestDrainBodyStreamForAPIGatewayV2_EmptyCloseAtDeadlineFailsClosed pins the
// same propagation-window guard on the BodyStream path: a stream that closed
// empty while ctx.Err() is still nil must fail closed when the drain deadline
// has been reached by wall clock.
func TestDrainBodyStreamForAPIGatewayV2_EmptyCloseAtDeadlineFailsClosed(t *testing.T) {
	ch := make(chan StreamChunk)
	close(ch) // the producer unwound and closed the stream empty

	ctx := deadlineCtxWithNilError{context.Background(), time.Now().Add(-time.Second)}
	body, err := drainBodyStreamForAPIGatewayV2(ctx, ch)
	if err == nil {
		t.Fatalf("empty stream close at the drain deadline must fail closed, got body %q with nil error (silent empty 200)", body)
	}
	if len(body) != 0 {
		t.Fatalf("fail-closed drain must not return content, got %q", body)
	}
}

// TestDrainBodyStreamForAPIGatewayV2_EmptyCloseBeforeDeadlineIsLegitimate pins
// the no-false-positive invariant on the BodyStream path.
func TestDrainBodyStreamForAPIGatewayV2_EmptyCloseBeforeDeadlineIsLegitimate(t *testing.T) {
	ch := make(chan StreamChunk)
	close(ch)

	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(time.Hour))
	defer cancel()
	body, err := drainBodyStreamForAPIGatewayV2(ctx, ch)
	if err != nil {
		t.Fatalf("empty stream close before the deadline is a legitimate empty response, got error %v", err)
	}
	if len(body) != 0 {
		t.Fatalf("expected empty body, got %q", body)
	}
}
