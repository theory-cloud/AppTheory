package apptheory

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// This file holds the strict (join-dominance) test for the buffered adapter's
// drain worker, the drainBodyReaderForAPIGatewayV2 baseline entry.
//
// The settle-window checks in invocation_scope_test.go prove the worker is gone
// once the drain returned. These tests instead prove the drain cannot return
// before the worker exits: the worker lingers after the reader is closed, so a
// drain that dropped its `<-done` join is caught by an elapsed-time assertion
// and by a channel the worker closes only as its read returns.
//
// The strict tests for the limitBodyStream and streamjoin.New entries live in
// invocation_scope_test.go.

// lingerOnCloseReader blocks its Read until Close is called, then lingers before
// reporting EOF. A drain that abandons its worker returns while Read is still
// running, which readDone observes.
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

// TestDrainBodyReaderForAPIGatewayV2WaitsForItsWorkerOnAbandon covers the
// drainBodyReaderForAPIGatewayV2 baseline entry on its ctx-done path. The drain
// deadline abandons the blocked read, closes the reader to unblock it, and must
// then wait for `<-done` before returning. The worker's read lingers after the
// close, so deleting the join-wait makes the drain return at the deadline,
// before the worker exited.
func TestDrainBodyReaderForAPIGatewayV2WaitsForItsWorkerOnAbandon(t *testing.T) {
	const linger = 200 * time.Millisecond
	reader := newLingerOnCloseReader(linger)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	started := time.Now()
	_, err := drainBodyReaderForAPIGatewayV2(ctx, reader)
	elapsed := time.Since(started)

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("drain error = %v, want context.DeadlineExceeded", err)
	}
	if elapsed < linger/2 {
		t.Fatalf("drain returned after %s, before its worker exited (linger %s)", elapsed, linger)
	}
	select {
	case <-reader.readDone:
	default:
		t.Fatal("drain returned before its worker's read returned")
	}
	assertNoGoroutineFor(t, "drainBodyReaderForAPIGatewayV2.func", "abandoned reader body")
}
