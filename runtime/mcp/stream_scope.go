package mcp

import (
	"context"
	"io"
	"sync"

	apptheory "github.com/theory-cloud/apptheory/v5/runtime"
)

// streamScope owns the goroutines that produce one incrementally streamed MCP
// response body, so the body reader can join every one of them.
//
// A streamed tools/call response is produced concurrently by the tool body and
// by the SSE writer that serializes store events into the response body. A
// Lambda invocation ends when the adapter stops reading that body, so any of
// those goroutines still running at that point would outlive the invocation that
// started it. The scope joins all of them when the body reader reaches EOF or is
// closed.
//
// Producers are joined in two ways, because they hold different things:
//
//   - a relay (the SSE forwarder) holds no work of its own, so the scope
//     cancels its context and waits for it;
//   - the tool body holds a result that must reach the task/stream store, so the
//     scope only waits for it. Canceling it would discard the in-flight result,
//     which is the durability the streamed tools/call contract promises a client
//     that reconnects with Last-Event-ID.
type streamScope struct {
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func newStreamScope(ctx context.Context) *streamScope {
	if ctx == nil {
		ctx = context.Background()
	}
	scopeCtx, cancel := context.WithCancel(ctx)
	return &streamScope{ctx: scopeCtx, cancel: cancel}
}

// context is the subscription context every producer in the scope observes.
func (s *streamScope) context() context.Context {
	if s == nil {
		return context.Background()
	}
	return s.ctx
}

// goRun starts a relay producer whose lifetime is bound to the scope's context.
func (s *streamScope) goRun(run func(ctx context.Context)) {
	if s == nil || run == nil {
		return
	}

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		run(s.ctx)
	}()
}

// goJoin starts a producer that holds work of its own and must be waited for
// rather than canceled.
func (s *streamScope) goJoin(run func()) {
	if s == nil || run == nil {
		return
	}

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		run()
	}()
}

// stop releases the scope's relay producers and waits for every producer in the
// scope, including the ones that are only joined.
func (s *streamScope) stop() {
	if s == nil {
		return
	}
	s.cancel()
	s.wg.Wait()
}

// scopedBodyReader binds a response body reader to the scope that produced it.
// Reaching EOF and closing both release the scope.
type scopedBodyReader struct {
	inner  io.Reader
	closer io.Closer
	scope  *streamScope

	closeOnce sync.Once
	closeErr  error
}

func (r *scopedBodyReader) Read(p []byte) (int, error) {
	if r == nil || r.inner == nil {
		return 0, io.EOF
	}

	n, err := r.inner.Read(p)
	if err != nil {
		// The body is done either way; release the scope so its producers stop
		// and are joined before the reader reports completion. A close error is
		// kept for Close, because the read error is what the consumer must see.
		r.release()
	}
	return n, err
}

func (r *scopedBodyReader) Close() error {
	if r == nil {
		return nil
	}
	r.release()
	return r.closeErr
}

// release closes the SSE body first, which stops and joins the SSE writer and
// closes the event channel, and then cancels and joins the scope's remaining
// producers.
func (r *scopedBodyReader) release() {
	r.closeOnce.Do(func() {
		if r.closer != nil {
			r.closeErr = r.closer.Close()
		}
		r.scope.stop()
	})
}

// scopeResponseBody binds a response body reader to the scope that produced it,
// unconditionally.
//
// The wrapper is what releases the scope: it closes the inner body (when it has
// a closer) and then stops the scope on both EOF and Close. Installing it only
// when the inner reader happened to implement io.Closer would let a different
// body type skip the join entirely, so the wrapper is always installed and the
// closer is optional: a non-closable body still stops and joins the scope's
// producers, it just cannot also close the body underneath them.
func scopeResponseBody(scope *streamScope, reader io.Reader) io.Reader {
	wrapper := &scopedBodyReader{inner: reader, scope: scope}
	if closer, ok := reader.(io.Closer); ok {
		wrapper.closer = closer
	}
	return wrapper
}

// streamToSSE serializes a stream store subscription as an SSE response body
// whose reader joins every producer the stream started.
func (s *Server) streamToSSE(scope *streamScope, sessionID string, events <-chan StreamEvent) (*apptheory.Response, error) {
	out := make(chan apptheory.SSEEvent)
	scope.goRun(func(ctx context.Context) {
		forwardStreamEvents(ctx, events, out)
	})

	resp, err := apptheory.SSEStreamResponse(scope.context(), 200, out)
	if err != nil {
		scope.stop()
		return nil, err
	}
	if resp.Headers == nil {
		resp.Headers = map[string][]string{}
	}
	resp.Headers[headerMcpSessionID] = []string{sessionID}

	resp.BodyReader = scopeResponseBody(scope, resp.BodyReader)
	return resp, nil
}

// forwardStreamEvents translates store events into SSE events. It drains the
// subscription before returning once the scope is canceled, which joins the
// store's pump: a StreamStore implementation MUST close its subscription
// channel when the subscription context is done, so the join completes inside
// the invocation that opened the subscription.
func forwardStreamEvents(ctx context.Context, events <-chan StreamEvent, out chan<- apptheory.SSEEvent) {
	defer close(out)

	for {
		select {
		case <-ctx.Done():
			drainClosedSubscription(events)
			return
		case ev, ok := <-events:
			if !ok {
				return
			}
			select {
			case <-ctx.Done():
				drainClosedSubscription(events)
				return
			case out <- apptheory.SSEEvent{
				ID:    ev.ID,
				Event: streamEventName(ev),
				Data:  streamEventData(ev),
			}:
			}
		}
	}
}

// drainClosedSubscription waits for a canceled subscription's channel to close.
//
// The wait is unconditional. A subscription the invocation opened must not still
// have a producer running once the streamed body's reader is released, so the
// forwarder waits for the channel to close rather than giving up on a grace
// window. Every store the runtime ships closes its channel when the subscription
// context is done; a custom StreamStore MUST do the same (see the StreamStore
// interface contract), which is what keeps this join prompt. A store that
// ignores its context is bounded by the Lambda function timeout, not abandoned
// by the framework.
func drainClosedSubscription(events <-chan StreamEvent) {
	if events == nil {
		return
	}

	for {
		// Draining to the close is the join.
		if _, ok := <-events; !ok {
			return
		}
	}
}

func streamEventName(ev StreamEvent) string {
	if len(ev.Data) == 0 {
		return ""
	}
	return "message"
}

func streamEventData(ev StreamEvent) any {
	if len(ev.Data) == 0 {
		return ""
	}
	return ev.Data
}
