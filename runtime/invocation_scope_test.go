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
// the Lambda invocation that started it.
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
// prove that a wrapper reads inline instead of on a producer goroutine.
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

// blockingReader blocks until released, and is not an io.Closer, so it models a
// handler-supplied body the adapter cannot interrupt.
type blockingReader struct {
	released chan struct{}
}

func (r blockingReader) Read([]byte) (int, error) {
	<-r.released
	return 0, io.EOF
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

func TestAPIGatewayV2DrainJoinsAbandonedWorker(t *testing.T) {
	drainCtx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	body := streamjoin.New(context.Background(), func(ctx context.Context, _ *io.PipeWriter) {
		<-ctx.Done()
	})

	out := apigatewayV2ResponseFromResponse(drainCtx, Response{Status: 200, BodyReader: body})
	if out.StatusCode != 500 {
		t.Fatalf("expected the abandoned streaming body to fail closed, got %d", out.StatusCode)
	}
	assertNoGoroutineFor(t, "internal/streamjoin.New.func", "API Gateway v2 drain abandoned the body")
	assertNoGoroutineFor(t, "drainBodyReaderForAPIGatewayV2.func", "API Gateway v2 drain abandoned the body")
}

func TestAPIGatewayV2DrainJoinsUninterruptibleWorker(t *testing.T) {
	reader := blockingReader{released: make(chan struct{})}

	drainCtx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	started := time.Now()
	_, err := drainBodyReaderForAPIGatewayV2(drainCtx, reader)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected the drain deadline error, got %v", err)
	}
	// The worker cannot be interrupted, so the drain waits only for its bounded
	// settle window instead of blocking the invocation forever.
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("drain held the invocation for %s on an uninterruptible reader", elapsed)
	}

	close(reader.released)
	assertNoGoroutineFor(t, "drainBodyReaderForAPIGatewayV2.func", "drain released an uninterruptible worker")
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

type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }

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
	joinAbandonedBodyStream(resp.BodyStream, time.Second)
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
	done := make(chan struct{})
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
	defer close(done)

	out := app.ServeAPIGatewayV2(ctx, eventsAPIGatewayV2Request("/live"))
	if out.StatusCode != 500 {
		t.Fatalf("expected the abandoned stream to fail closed, got %d", out.StatusCode)
	}
	assertNoGoroutineFor(t, "limitBodyStream.func", "API Gateway v2 abandoned a limited body stream")
}

func TestTimeoutMiddlewareJoinsHandlerBeforeReturning(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Use(TimeoutMiddleware(TimeoutConfig{DefaultTimeout: 5 * time.Millisecond}))

	finished := make(chan struct{})
	sideEffect := make(chan struct{}, 1)
	app.Get("/uncooperative", func(_ *Context) (*Response, error) {
		defer close(finished)
		time.Sleep(40 * time.Millisecond)
		sideEffect <- struct{}{}
		return Text(200, "late"), nil
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/uncooperative"})
	if resp.Status != 408 {
		t.Fatalf("expected timeout response (408), got %d", resp.Status)
	}

	// The response is only returned once the handler it started has unwound, so
	// the side effect cannot land after the invocation ended.
	select {
	case <-finished:
	default:
		t.Fatal("timeout middleware returned while its handler was still running")
	}
	assertNoGoroutineFor(t, "TimeoutMiddleware.func", "timeout middleware returned")
}

func eventsAPIGatewayV2Request(path string) events.APIGatewayV2HTTPRequest {
	event := events.APIGatewayV2HTTPRequest{RawPath: path}
	event.RequestContext.HTTP.Method = "GET"
	event.RequestContext.HTTP.Path = path
	return event
}

func TestJoinAbandonedBodyStreamStopsOnClosedStream(t *testing.T) {
	closed := make(chan StreamChunk)
	close(closed)

	started := time.Now()
	joinAbandonedBodyStream(closed, time.Second)
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("join of a closed stream took %s", elapsed)
	}

	// A handler-supplied stream that never closes must not hold the join open.
	open := make(chan StreamChunk)
	joinAbandonedBodyStream(open, 10*time.Millisecond)

	joinAbandonedBodyStream(nil, time.Millisecond)
}

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
