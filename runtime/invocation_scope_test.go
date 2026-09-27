package apptheory

import (
	"bytes"
	"context"
	"errors"
	"io"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory/v4/runtime/internal/streamjoin"
)

// This file proves the invocation-scope invariant for the Go runtime: a
// goroutine the runtime starts to produce or consume a response body must have
// returned before the adapter that owns that body returns, so no work outlives
// the Lambda invocation that started it. There are no grace windows: every
// adapter path either joins its producer or never starts one.
//
// The checks are goroutine-stack scans rather than a process-wide leak detector:
// they run inside the tests that exercise a site, they are unaffected by other
// tests running in parallel, and they name the exact producer frame that must be
// gone.

// goroutineStacksContaining returns the stacks of live goroutines whose stack
// contains marker.
func goroutineStacksContaining(marker string) string {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			break
		}
		buf = make([]byte, 2*len(buf))
	}

	var leaked []string
	for _, block := range strings.Split(string(buf), "\n\n") {
		if strings.Contains(block, marker) {
			leaked = append(leaked, block)
		}
	}
	return strings.Join(leaked, "\n\n")
}

// assertNoGoroutineFor fails the test if a goroutine whose stack contains marker
// is still running once the settle window elapses. Producers signal completion
// from a deferred call, so the stack is sampled repeatedly instead of once.
func assertNoGoroutineFor(t *testing.T, marker, when string) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for {
		if leaked := goroutineStacksContaining(marker); leaked == "" {
			return
		} else if time.Now().After(deadline) {
			t.Fatalf("%s: producer goroutine outlived its invocation:\n%s", when, leaked)
		}
		time.Sleep(time.Millisecond)
	}
}

// currentGoroutineID identifies the goroutine a call runs on, so a test can
// prove that a wrapper or a middleware runs its work inline instead of on a
// producer goroutine.
func currentGoroutineID(t *testing.T) int {
	t.Helper()

	buf := make([]byte, 64)
	n := runtime.Stack(buf, false)
	fields := strings.Fields(string(buf[:n]))
	if len(fields) < 2 || fields[0] != "goroutine" {
		t.Fatalf("unexpected goroutine header: %q", string(buf[:n]))
	}
	id, err := strconv.Atoi(fields[1])
	if err != nil {
		t.Fatalf("parse goroutine id: %v", err)
	}
	return id
}

type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }

// toolBodyProducer models a runtime producer that holds its own work (the
// streamed MCP tool body): it runs until its context is canceled or its output
// pipe is closed, and it signals exit so a test can prove it was joined.
func toolBodyProducer(finished chan struct{}) streamjoin.Producer {
	return func(ctx context.Context, _ *io.PipeWriter) {
		defer close(finished)
		<-ctx.Done()
	}
}

// oversizedToolBodyProducer emits more than the buffered adapter's byte budget
// and then keeps producing until the adapter releases it.
func oversizedToolBodyProducer(finished chan struct{}) streamjoin.Producer {
	return func(ctx context.Context, pw *io.PipeWriter) {
		defer close(finished)
		chunk := bytes.Repeat([]byte("a"), 32*1024)
		for {
			if _, err := pw.Write(chunk); err != nil {
				return
			}
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}
}

func eventsAPIGatewayV2Request(path string) events.APIGatewayV2HTTPRequest {
	event := events.APIGatewayV2HTTPRequest{RawPath: path}
	event.RequestContext.HTTP.Method = "GET"
	event.RequestContext.HTTP.Path = path
	return event
}

func appWithStreamingBody(body io.Reader) *App {
	app := New(
		WithTier(TierP1),
		WithIDGenerator(fixedIDGenerator("req_stream")),
	)
	app.Get("/stream", func(_ *Context) (*Response, error) {
		return &Response{Status: 200, BodyReader: body}, nil
	})
	return app
}

func TestSSEStreamResponseJoinsProducer(t *testing.T) {
	t.Run("on EOF", func(t *testing.T) {
		events := make(chan SSEEvent, 1)
		events <- SSEEvent{Data: "one"}
		close(events)

		resp, err := SSEStreamResponse(context.Background(), 200, events)
		if err != nil {
			t.Fatalf("SSEStreamResponse: %v", err)
		}

		body, err := io.ReadAll(resp.BodyReader)
		if err != nil {
			t.Fatalf("read SSE body: %v", err)
		}
		if !strings.Contains(string(body), "data: one") {
			t.Fatalf("unexpected SSE body: %q", string(body))
		}
		assertNoGoroutineFor(t, "internal/streamjoin.New.func", "SSE stream served to EOF")
	})

	t.Run("on close", func(t *testing.T) {
		events := make(chan SSEEvent)
		resp, err := SSEStreamResponse(context.Background(), 200, events)
		if err != nil {
			t.Fatalf("SSEStreamResponse: %v", err)
		}

		closer, ok := resp.BodyReader.(io.Closer)
		if !ok {
			t.Fatal("expected SSE body reader to be closable")
		}
		if err := closer.Close(); err != nil {
			t.Fatalf("close SSE body: %v", err)
		}
		assertNoGoroutineFor(t, "internal/streamjoin.New.func", "SSE stream abandoned by the adapter")
	})
}

// TestAPIGatewayV2AdapterReleasesBodyOnAdapterBudgetOverflow covers the 413 the
// adapter's own 4 MiB byte budget produces. The reader it gives up on must be
// closed, which is what stops and joins the producer behind it.
func TestAPIGatewayV2AdapterReleasesBodyOnAdapterBudgetOverflow(t *testing.T) {
	finished := make(chan struct{})
	body := streamjoin.New(context.Background(), oversizedToolBodyProducer(finished))

	out := appWithStreamingBody(body).ServeAPIGatewayV2(context.Background(), eventsAPIGatewayV2Request("/stream"))
	if out.StatusCode != 413 {
		t.Fatalf("expected the adapter byte budget to map to 413, got %d", out.StatusCode)
	}
	assertClosedBeforeReturn(t, finished)
	assertNoGoroutineFor(t, "internal/streamjoin.New.func", "API Gateway v2 adapter byte budget")
}

// TestAPIGatewayV2AdapterReleasesBodyOnLimiterOverflow covers the 413 the
// framework's MaxResponseBytes limiter produces. The reader is wrapped by
// limitedBodyReader, so this is the path that only works when the limiter
// forwards Close to the body it wraps.
func TestAPIGatewayV2AdapterReleasesBodyOnLimiterOverflow(t *testing.T) {
	finished := make(chan struct{})
	body := streamjoin.New(context.Background(), oversizedToolBodyProducer(finished))

	app := New(
		WithTier(TierP1),
		WithIDGenerator(fixedIDGenerator("req_stream")),
		WithLimits(Limits{MaxResponseBytes: 4096}),
	)
	app.Get("/stream", func(_ *Context) (*Response, error) {
		return &Response{Status: 200, BodyReader: body}, nil
	})

	out := app.ServeAPIGatewayV2(context.Background(), eventsAPIGatewayV2Request("/stream"))
	if out.StatusCode != 413 {
		t.Fatalf("expected the response limiter to map to 413, got %d", out.StatusCode)
	}
	assertClosedBeforeReturn(t, finished)
	assertNoGoroutineFor(t, "internal/streamjoin.New.func", "API Gateway v2 response limiter")
}

// TestAPIGatewayV2AdapterReleasesBodyOnDrainDeadline covers the 500 a body that
// does not terminate within the drain budget produces. The abandoned body is
// closed so its producer is joined, including when the limiter wrapped it.
func TestAPIGatewayV2AdapterReleasesBodyOnDrainDeadline(t *testing.T) {
	finished := make(chan struct{})
	body := streamjoin.New(context.Background(), toolBodyProducer(finished))

	app := New(
		WithTier(TierP1),
		WithIDGenerator(fixedIDGenerator("req_stream")),
		WithLimits(Limits{MaxResponseBytes: 1 << 20}),
	)
	app.Get("/stream", func(_ *Context) (*Response, error) {
		return &Response{Status: 200, BodyReader: body}, nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	out := app.ServeAPIGatewayV2(ctx, eventsAPIGatewayV2Request("/stream"))
	if out.StatusCode != 500 {
		t.Fatalf("expected the abandoned streaming body to fail closed with 500, got %d", out.StatusCode)
	}
	assertClosedBeforeReturn(t, finished)
	assertNoGoroutineFor(t, "internal/streamjoin.New.func", "API Gateway v2 drain deadline")
	assertNoGoroutineFor(t, "drainBodyReaderForAPIGatewayV2.func", "API Gateway v2 drain deadline")
}

// TestLambdaFunctionURLAdapterReleasesBodyOnBudgetOverflow covers the same
// release on the buffered Function URL adapter, which shares the drain.
func TestLambdaFunctionURLAdapterReleasesBodyOnBudgetOverflow(t *testing.T) {
	finished := make(chan struct{})
	body := streamjoin.New(context.Background(), oversizedToolBodyProducer(finished))

	app := appWithStreamingBody(body)
	urlEvent := events.LambdaFunctionURLRequest{RawPath: "/stream"}
	urlEvent.RequestContext.HTTP.Method = "GET"
	urlEvent.RequestContext.HTTP.Path = "/stream"

	out := app.ServeLambdaFunctionURL(context.Background(), urlEvent)
	if out.StatusCode != 413 {
		t.Fatalf("expected the Function URL adapter byte budget to map to 413, got %d", out.StatusCode)
	}
	assertClosedBeforeReturn(t, finished)
	assertNoGoroutineFor(t, "internal/streamjoin.New.func", "Function URL adapter byte budget")
}

// TestALBTargetGroupAdapterDeliversAndReleasesStreamingBody covers the ALB
// target group adapter (it previously dropped a streaming body entirely).
func TestALBTargetGroupAdapterDeliversAndReleasesStreamingBody(t *testing.T) {
	t.Run("terminating body is delivered", func(t *testing.T) {
		body := streamjoin.New(context.Background(), func(_ context.Context, pw *io.PipeWriter) {
			defer closePipeWriter(pw)
			if _, err := pw.Write([]byte("alb body")); err != nil {
				_ = err
			}
		})

		out := appWithStreamingBody(body).ServeALB(context.Background(), events.ALBTargetGroupRequest{HTTPMethod: "GET", Path: "/stream"})
		if out.StatusCode != 200 || out.Body != "alb body" {
			t.Fatalf("expected the ALB adapter to deliver the drained body, got %d %q", out.StatusCode, out.Body)
		}
		assertNoGoroutineFor(t, "internal/streamjoin.New.func", "ALB drained body")
	})

	t.Run("oversized body fails closed and is released", func(t *testing.T) {
		finished := make(chan struct{})
		body := streamjoin.New(context.Background(), oversizedToolBodyProducer(finished))

		out := appWithStreamingBody(body).ServeALB(context.Background(), events.ALBTargetGroupRequest{HTTPMethod: "GET", Path: "/stream"})
		if out.StatusCode != 413 {
			t.Fatalf("expected the ALB byte budget to map to 413, got %d", out.StatusCode)
		}
		assertClosedBeforeReturn(t, finished)
		assertNoGoroutineFor(t, "internal/streamjoin.New.func", "ALB byte budget")
	})
}

// TestAPIGatewayProxyBufferedAdapterDeliversAndReleasesStreamingBody covers the
// buffered API Gateway REST v1 conversion.
func TestAPIGatewayProxyBufferedAdapterDeliversAndReleasesStreamingBody(t *testing.T) {
	t.Run("terminating body is delivered", func(t *testing.T) {
		body := streamjoin.New(context.Background(), func(_ context.Context, pw *io.PipeWriter) {
			defer closePipeWriter(pw)
			if _, err := pw.Write([]byte("v1 body")); err != nil {
				_ = err
			}
		})

		out := appWithStreamingBody(body).ServeAPIGatewayProxy(context.Background(), events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/stream"})
		if out.StatusCode != 200 || out.Body != "v1 body" {
			t.Fatalf("expected the buffered v1 adapter to deliver the drained body, got %d %q", out.StatusCode, out.Body)
		}
		assertNoGoroutineFor(t, "internal/streamjoin.New.func", "buffered v1 drained body")
	})

	t.Run("oversized body fails closed and is released", func(t *testing.T) {
		finished := make(chan struct{})
		body := streamjoin.New(context.Background(), oversizedToolBodyProducer(finished))

		out := appWithStreamingBody(body).ServeAPIGatewayProxy(context.Background(), events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/stream"})
		if out.StatusCode != 413 {
			t.Fatalf("expected the buffered v1 byte budget to map to 413, got %d", out.StatusCode)
		}
		assertClosedBeforeReturn(t, finished)
		assertNoGoroutineFor(t, "internal/streamjoin.New.func", "buffered v1 byte budget")
	})
}

// TestAPIGatewayProxyBufferedAdapterReleasesBodyOnDrainDeadline covers the 500
// path of the buffered v1 conversion.
func TestAPIGatewayProxyBufferedAdapterReleasesBodyOnDrainDeadline(t *testing.T) {
	finished := make(chan struct{})
	body := streamjoin.New(context.Background(), toolBodyProducer(finished))

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	out := appWithStreamingBody(body).ServeAPIGatewayProxy(ctx, events.APIGatewayProxyRequest{HTTPMethod: "GET", Path: "/stream"})
	if out.StatusCode != 500 {
		t.Fatalf("expected the abandoned streaming body to fail closed with 500, got %d", out.StatusCode)
	}
	assertClosedBeforeReturn(t, finished)
	assertNoGoroutineFor(t, "internal/streamjoin.New.func", "buffered v1 drain deadline")
}

// TestNonClosableBodyReaderIsReadOnTheInvokingGoroutine covers the reader the
// adapter cannot interrupt: it has no goroutine to abandon because the read
// happens on the invoking goroutine, and the invocation — not the adapter —
// bounds a reader that neither terminates nor can be closed.
func TestNonClosableBodyReaderIsReadOnTheInvokingGoroutine(t *testing.T) {
	caller := currentGoroutineID(t)
	readOn := make(chan int, 1)

	_, err := drainBodyReaderForAPIGatewayV2(context.Background(), readerFunc(func([]byte) (int, error) {
		readOn <- currentGoroutineID(t)
		return 0, io.EOF
	}))
	if err != nil {
		t.Fatalf("inline drain: %v", err)
	}

	select {
	case got := <-readOn:
		if got != caller {
			t.Fatalf("non-closable reader read on goroutine %d, want the invoking goroutine %d", got, caller)
		}
	case <-time.After(time.Second):
		t.Fatal("non-closable reader never read")
	}
	assertNoGoroutineFor(t, "drainBodyReaderForAPIGatewayV2.func", "inline drain of a non-closable reader")
}

// TestLimitedBodyReaderListensForOverflowAndPreservesSources pins the limiter's
// inline accounting and its Close forwarding.
func TestLimitedBodyReaderPreservesSources(t *testing.T) {
	body, err := io.ReadAll(limitBodyReader(bytes.NewReader([]byte("abc")), &responseSizeLimiter{max: 2}))
	if string(body) != "ab" {
		t.Fatalf("limited body = %q, want %q", string(body), "ab")
	}
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Code != errorCodeTooLarge {
		t.Fatalf("expected the size error, got %v", err)
	}
}

// TestLimitBodyReaderForwardsClose proves the limiter wrapper is an io.Closer
// that reaches the body it wraps.
func TestLimitBodyReaderForwardsClose(t *testing.T) {
	target := streamjoin.New(context.Background(), func(ctx context.Context, _ *io.PipeWriter) {
		<-ctx.Done()
	})

	limited := limitBodyReader(target, &responseSizeLimiter{max: 1024})
	closer, ok := limited.(io.Closer)
	if !ok {
		t.Fatal("expected the limited body reader to be closable")
	}
	if err := closer.Close(); err != nil {
		t.Fatalf("close limited body: %v", err)
	}
	assertNoGoroutineFor(t, "internal/streamjoin.New.func", "limiter forwarded close")
}

func TestLimitBodyReaderReadsInline(t *testing.T) {
	caller := currentGoroutineID(t)
	readOn := make(chan int, 1)

	limited := limitBodyReader(readerFunc(func(p []byte) (int, error) {
		readOn <- currentGoroutineID(t)
		copy(p, "ok")
		return 2, io.EOF
	}), &responseSizeLimiter{max: 10})

	body, err := io.ReadAll(limited)
	if err != nil {
		t.Fatalf("read limited body: %v", err)
	}
	if string(body) != "ok" {
		t.Fatalf("limited body = %q", string(body))
	}

	select {
	case got := <-readOn:
		if got != caller {
			t.Fatalf("limited reader read on goroutine %d, want the consumer's goroutine %d", got, caller)
		}
	case <-time.After(time.Second):
		t.Fatal("limited reader never read its source")
	}
	assertNoGoroutineFor(t, "limitBodyReader.func", "limited reader read")
}

// TestResponseStreamingBodyIsClosableThroughTheLimiter covers R3: the body a
// response-streaming transport is handed must be an io.Closer even when the
// limiter wrapped it or it is composed with a buffered prefix, because the
// aws-lambda-go streaming runtime closes the body on disconnect — and that close
// is what stops and joins the SSE writer and forwarder behind it.
func TestResponseStreamingBodyIsClosableThroughTheLimiter(t *testing.T) {
	newScopedBody := func(t *testing.T) (*Response, chan struct{}) {
		t.Helper()

		finished := make(chan struct{})
		body := streamjoin.New(context.Background(), func(ctx context.Context, _ *io.PipeWriter) {
			defer close(finished)
			<-ctx.Done()
		})
		limited := limitBodyReader(body, &responseSizeLimiter{max: 1024})
		return &Response{Status: 200, Body: []byte("prefix"), BodyReader: limited}, finished
	}

	t.Run("composed with a buffered prefix", func(t *testing.T) {
		resp, finished := newScopedBody(t)
		out := apigatewayProxyStreamingResponseFromResponse(*resp)

		closer, ok := out.Body.(io.Closer)
		if !ok {
			t.Fatalf("expected the streaming body to be closable, got %T", out.Body)
		}
		if err := closer.Close(); err != nil {
			t.Fatalf("close streaming body: %v", err)
		}
		assertClosedBeforeReturn(t, finished)
		assertNoGoroutineFor(t, "internal/streamjoin.New.func", "streaming client disconnect")
	})

	t.Run("without a buffered prefix", func(t *testing.T) {
		resp, finished := newScopedBody(t)
		resp.Body = nil
		out := apigatewayProxyStreamingResponseFromResponse(*resp)

		closer, ok := out.Body.(io.Closer)
		if !ok {
			t.Fatalf("expected the streaming body to be closable, got %T", out.Body)
		}
		if err := closer.Close(); err != nil {
			t.Fatalf("close streaming body: %v", err)
		}
		assertClosedBeforeReturn(t, finished)
		assertNoGoroutineFor(t, "internal/streamjoin.New.func", "streaming client disconnect")
	})
}

func TestLimitBodyStreamProducerStopsOnServeContextCancel(t *testing.T) {
	app := New(
		WithTier(TierP1),
		WithLimits(Limits{MaxResponseBytes: 16}),
	)
	app.Get("/stream", func(_ *Context) (*Response, error) {
		return &Response{
			Status:     200,
			BodyStream: make(chan StreamChunk),
		}, nil
	})

	serveCtx, cancelServe := context.WithCancel(context.Background())
	resp := app.Serve(serveCtx, Request{Method: "GET", Path: "/stream"})
	if resp.BodyStream == nil {
		t.Fatal("expected a limited body stream")
	}

	// The adapter cancels the invocation's serve context before it returns; the
	// limiter's producer must observe that and exit, and the adapter's join must
	// observe the closed stream.
	cancelServe()

	started := time.Now()
	joinAbandonedBodyStream(resp.BodyStream)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("join of the abandoned stream took %s", elapsed)
	}
	assertNoGoroutineFor(t, "limitBodyStream.func", "serve context canceled")
}

func TestAPIGatewayV2AdapterJoinsAbandonedBodyStream(t *testing.T) {
	app := New(
		WithTier(TierP1),
		WithIDGenerator(fixedIDGenerator("req_v2_stream")),
		WithLimits(Limits{MaxResponseBytes: 16}),
	)

	never := make(chan StreamChunk)
	app.Get("/live", func(_ *Context) (*Response, error) {
		return &Response{
			Status:     200,
			BodyStream: never,
			Headers:    map[string][]string{"content-type": {"text/event-stream"}},
		}, nil
	})

	// A request context that expires immediately makes the buffered adapter give
	// up on the never-terminating stream, which is the path that used to leave
	// the limiter producer blocked forever.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	out := app.ServeAPIGatewayV2(ctx, eventsAPIGatewayV2Request("/live"))
	if out.StatusCode != 500 {
		t.Fatalf("expected the abandoned stream to fail closed, got %d", out.StatusCode)
	}
	assertNoGoroutineFor(t, "limitBodyStream.func", "API Gateway v2 abandoned a limited body stream")
}

func TestJoinAbandonedBodyStreamJoinsProducer(t *testing.T) {
	closed := make(chan StreamChunk)
	close(closed)

	started := time.Now()
	joinAbandonedBodyStream(closed)
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("join of a closed stream took %s", elapsed)
	}

	// A runtime-produced stream stops when the invocation context is canceled and
	// closes its channel as it returns; the join returns only after that close.
	serveCtx, cancelServe := context.WithCancel(context.Background())
	stream := limitBodyStream(serveCtx, make(chan StreamChunk), &responseSizeLimiter{max: 1024})
	released := make(chan struct{})
	go func() {
		defer close(released)
		time.Sleep(20 * time.Millisecond)
		cancelServe()
	}()

	joinAbandonedBodyStream(stream)
	<-released
	assertNoGoroutineFor(t, "limitBodyStream.func", "abandoned body stream")

	joinAbandonedBodyStream(nil)
}

// TestTimeoutMiddlewareRunsHandlerOnTheInvokingGoroutine covers E1: the handler
// chain runs on the invoking goroutine with a deadline-bearing context instead
// of on a goroutine the middleware abandons when the deadline fires.
func TestTimeoutMiddlewareRunsHandlerOnTheInvokingGoroutine(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Use(TimeoutMiddleware(TimeoutConfig{DefaultTimeout: 5 * time.Millisecond}))

	handlerGoroutine := make(chan int, 1)
	app.Get("/cooperative", func(ctx *Context) (*Response, error) {
		handlerGoroutine <- currentGoroutineID(t)
		<-ctx.Context().Done()
		return Text(200, "canceled"), nil
	})

	servingGoroutine := currentGoroutineID(t)
	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/cooperative"})
	if resp.Status != 408 {
		t.Fatalf("expected timeout response (408), got %d", resp.Status)
	}

	select {
	case got := <-handlerGoroutine:
		if got != servingGoroutine {
			t.Fatalf("timeout middleware ran the handler on goroutine %d, want the invoking goroutine %d", got, servingGoroutine)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout middleware never ran its handler")
	}
	assertNoGoroutineFor(t, "TimeoutMiddleware.func", "timeout middleware returned")
}

// TestTimeoutMiddlewareNeverAbandonsAnUncooperativeHandler covers the other half
// of E1: a handler that ignores cancellation simply runs until it returns, on the
// invoking goroutine, and nothing runs after the middleware returns.
func TestTimeoutMiddlewareNeverAbandonsAnUncooperativeHandler(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Use(TimeoutMiddleware(TimeoutConfig{DefaultTimeout: 5 * time.Millisecond}))

	sideEffect := make(chan struct{})
	app.Get("/uncooperative", func(_ *Context) (*Response, error) {
		time.Sleep(30 * time.Millisecond)
		close(sideEffect)
		return Text(200, "late"), nil
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/uncooperative"})
	if resp.Status != 408 {
		t.Fatalf("expected timeout response (408), got %d", resp.Status)
	}

	// The handler ran on the invoking goroutine, so its side effect is already
	// inside the invocation: it cannot land after the middleware returned.
	select {
	case <-sideEffect:
	default:
		t.Fatal("the timeout middleware returned before the handler it timed out finished")
	}
	assertNoGoroutineFor(t, "TimeoutMiddleware.func", "timeout middleware returned")
}

func closePipeWriter(pw *io.PipeWriter) {
	if pw == nil {
		return
	}
	if err := pw.Close(); err != nil {
		_ = err
	}
}

// assertClosedBeforeReturn fails the test unless the producer behind a released
// body has already exited.
func assertClosedBeforeReturn(t *testing.T, finished <-chan struct{}) {
	t.Helper()

	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("the adapter returned while the body's producer was still running")
	}
}
