package apptheory

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// This file holds the bounded-settle test for the buffered adapter's drain
// worker, the drainBodyReaderForAPIGatewayV2 baseline entry.
//
// The settle-window checks in invocation_scope_test.go prove a cooperative
// worker is gone once the drain returned. These tests prove the drain cannot be
// held open by a worker that does not respond to Close: the worker's read
// lingers past the bounded grace window, so a drain that waited for the worker
// unconditionally is caught by the elapsed-time bound.
//
// The strict tests for the limitBodyStream and streamjoin.New entries live in
// invocation_scope_test.go.

// lingerOnCloseReader blocks its Read until Close is called, then lingers before
// reporting EOF. A drain that waits for its worker unconditionally returns only
// after the read returns, which the elapsed-time bound observes as a hold.
type lingerOnCloseReader struct {
	closeCh  chan struct{}
	readDone chan struct{}

	linger    time.Duration
	closeOnce sync.Once
}

func newLingerOnCloseReader(linger time.Duration) *lingerOnCloseReader {
	return &lingerOnCloseReader{
		closeCh:  make(chan struct{}),
		readDone: make(chan struct{}),
		linger:   linger,
	}
}

func (r *lingerOnCloseReader) Read([]byte) (int, error) {
	<-r.closeCh
	time.Sleep(r.linger)
	close(r.readDone)
	return 0, io.EOF
}

func (r *lingerOnCloseReader) Close() error {
	r.closeOnce.Do(func() { close(r.closeCh) })
	return nil
}

// TestDrainBodyReaderForAPIGatewayV2AbandonIsBounded covers the
// drainBodyReaderForAPIGatewayV2 baseline entry on its ctx-done path. The drain
// deadline abandons the blocked read, closes the reader to unblock it, and joins
// the worker for a bounded grace window. A reader whose read lingers past that
// window must not hold the drain.
func TestDrainBodyReaderForAPIGatewayV2AbandonIsBounded(t *testing.T) {
	// Linger well past the bounded grace window so an unbounded `<-done` join is
	// caught by the elapsed-time bound, not by scheduler timing.
	const linger = 500 * time.Millisecond
	reader := newLingerOnCloseReader(linger)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	started := time.Now()
	_, err := drainBodyReaderForAPIGatewayV2(ctx, reader)
	elapsed := time.Since(started)

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("drain error = %v, want context.DeadlineExceeded", err)
	}
	// The bounded join (streamingBodyDrainJoinGrace) must release the drain well
	// before the worker's read returns.
	if elapsed > 300*time.Millisecond {
		t.Fatalf("drain held the invocation for %s on a lingering reader", elapsed)
	}
	select {
	case <-reader.readDone:
		t.Fatal("test reader did not linger past the grace window")
	default:
	}
	// The abandoned worker is the documented residual; it exits once the read
	// returns.
	<-reader.readDone
	assertNoGoroutineFor(t, "drainBodyReaderForAPIGatewayV2.func", "abandoned reader body")
}
