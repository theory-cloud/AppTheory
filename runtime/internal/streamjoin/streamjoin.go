// Package streamjoin gives response bodies whose bytes are produced
// incrementally to a reader that cannot report completion while the producer
// that writes them is still running.
//
// A Lambda invocation ends when the handler has returned its response and the
// adapter has stopped consuming the response body. A producer goroutine that is
// still running at that point outlives the invocation that started it: it keeps
// holding the execution environment, and it can resume half-finished work on a
// later invocation of the same environment. Every incremental body therefore
// hands its producer to this package, which joins the producer on both exit
// paths of the body reader:
//
//   - the reader reaches EOF only after the producer has returned, so an
//     adapter that drains a body to completion cannot return early;
//   - closing the reader unblocks the producer (by closing the pipe and
//     canceling the producer context) and then waits for it to return, so an
//     adapter that abandons a body also leaves no producer behind.
//
// A producer that blocks on something this package cannot unblock — a read from
// a source that is neither closed nor canceled by the caller — keeps the
// documented io.Closer contract instead: Close unblocks blocked reads and
// writes. Producers must observe their context for the close path to be
// prompt.
package streamjoin

import (
	"context"
	"io"
	"sync"
)

// Producer writes a response body to w. It must return when ctx is done or when
// writing to w fails, and it must close w before returning.
type Producer func(ctx context.Context, w *io.PipeWriter)

// Body is a response body backed by a producer goroutine. It implements
// io.ReadCloser and joins the producer on EOF and on Close.
type Body struct {
	pr     *io.PipeReader
	cancel context.CancelFunc
	done   chan struct{}

	closeOnce sync.Once
	closeErr  error
}

// New starts produce on its own goroutine and returns the body that streams its
// output.
//
// The context handed to produce is canceled when the body is closed or when
// parent is done, so a producer that blocks on a channel receive can also be
// unblocked by Close.
func New(parent context.Context, produce Producer) *Body {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)

	pr, pw := io.Pipe()
	body := &Body{
		pr:     pr,
		cancel: cancel,
		done:   make(chan struct{}),
	}

	if produce == nil {
		produce = func(context.Context, *io.PipeWriter) {}
	}

	go func() {
		// Declared first so it runs last: the producer's output is closed
		// before the join signal, and no reader can observe EOF while this
		// goroutine is still on its way out of the deferred close.
		defer close(body.done)
		defer func() {
			if err := pw.Close(); err != nil {
				_ = err
			}
		}()
		produce(ctx, pw)
	}()

	return body
}

// Read returns the producer's bytes. It reports EOF (or the producer's error)
// only once the producer goroutine has returned.
func (b *Body) Read(p []byte) (int, error) {
	if b == nil {
		return 0, io.EOF
	}

	n, err := b.pr.Read(p)
	if err != nil {
		b.join()
	}
	return n, err
}

// Close stops the producer and waits for it to return. It is safe to call
// concurrently with Read, and it is idempotent.
func (b *Body) Close() error {
	if b == nil {
		return nil
	}

	b.closeOnce.Do(func() {
		b.cancel()
		b.closeErr = b.pr.Close()
	})
	b.join()
	return b.closeErr
}

func (b *Body) join() {
	<-b.done
}
