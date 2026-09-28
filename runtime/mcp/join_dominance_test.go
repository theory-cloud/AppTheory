package mcp

import (
	"context"
	"io"
	"sync"
	"testing"
	"time"
)

// This file holds the strict (join-dominance) tests for the MCP streamed-body
// scope and the stream stores' subscription pumps. Unlike the settle-window
// checks in invocation_scope_test.go and stream_adapter_scope_test.go, these
// tests fail if the join-wait itself is removed: each producer lingers, so a
// join that returned without waiting for it is caught by an elapsed-time
// assertion and by ordering channels the producers close as they exit.
//
// Covered baseline entries:
//
//	(streamScope).goRun[#1]                 stop cancels the relay and waits
//	(streamScope).goJoin[#1]                stop waits for every producer
//	(MemoryStreamStore).Subscribe[#1]       forwarder drains the pump's channel
//	(MemoryStreamStore).broadcastOnDone[#1] the returned wait joins the watcher
//	(DynamoStreamStore).Subscribe[#1]       forwarder drains the pump's channel

const joinDominanceLinger = 200 * time.Millisecond

// scopedSSEBody builds a streamed SSE response body for events and returns the
// closer that releases the scope, so a test can measure the release.
func scopedSSEBody(t *testing.T, scope *streamScope, events <-chan StreamEvent) io.Closer {
	t.Helper()

	server := NewServer("test-server", "1.0.0")
	resp, err := server.streamToSSE(scope, "sess-join", events)
	if err != nil {
		t.Fatalf("streamToSSE: %v", err)
	}
	closer, ok := resp.BodyReader.(io.Closer)
	if !ok {
		t.Fatalf("expected the streamed body to be closable, got %T", resp.BodyReader)
	}
	return closer
}

// TestStreamScopeStopWaitsForRelayProducer is the strict test for the
// (streamScope).goRun baseline entry: stop cancels the relay's context and waits
// for it. The relay lingers after its context is canceled, so removing the
// scope's wg.Wait makes stop return before the relay exited.
func TestStreamScopeStopWaitsForRelayProducer(t *testing.T) {
	scope := newStreamScope(context.Background())

	exited := make(chan struct{})
	scope.goRun(func(ctx context.Context) {
		<-ctx.Done()
		time.Sleep(joinDominanceLinger)
		close(exited)
	})

	started := time.Now()
	scope.stop()
	elapsed := time.Since(started)

	if elapsed < joinDominanceLinger/2 {
		t.Fatalf("stop returned after %s, before the relay producer exited (linger %s)", elapsed, joinDominanceLinger)
	}
	select {
	case <-exited:
	default:
		t.Fatal("stop returned before the relay producer exited")
	}
	assertNoGoroutineFor(t, "(*streamScope).goRun.func", "scope stopped")
}

// TestStreamScopeStopWaitsForJoinedProducer is the strict test for the
// (streamScope).goJoin baseline entry: the joined producer holds work of its own
// and is waited for rather than canceled. It lingers before closing finished, so
// removing the scope's wg.Wait makes stop return before it finished.
func TestStreamScopeStopWaitsForJoinedProducer(t *testing.T) {
	scope := newStreamScope(context.Background())

	finished := make(chan struct{})
	scope.goJoin(func() {
		time.Sleep(joinDominanceLinger)
		close(finished)
	})

	started := time.Now()
	scope.stop()
	elapsed := time.Since(started)

	if elapsed < joinDominanceLinger/2 {
		t.Fatalf("stop returned after %s, before the joined producer finished (linger %s)", elapsed, joinDominanceLinger)
	}
	select {
	case <-finished:
	default:
		t.Fatal("stop returned before the joined producer finished")
	}
	assertNoGoroutineFor(t, "(*streamScope).goJoin.func", "scope stopped")
}

// TestDrainClosedSubscriptionWaitsForTheStoreToClose is the strict test for the
// join primitive the stream stores' Subscribe entries rely on: the forwarder
// drains a canceled subscription to its close. The channel here closes only after
// a linger, so deleting the drain loop makes drainClosedSubscription return
// immediately.
func TestDrainClosedSubscriptionWaitsForTheStoreToClose(t *testing.T) {
	events := make(chan StreamEvent)
	closed := make(chan struct{})
	go func() {
		time.Sleep(joinDominanceLinger)
		close(events)
		close(closed)
	}()

	started := time.Now()
	drainClosedSubscription(events)
	elapsed := time.Since(started)

	if elapsed < joinDominanceLinger/2 {
		t.Fatalf("drainClosedSubscription returned after %s, before the subscription closed (linger %s)", elapsed, joinDominanceLinger)
	}
	select {
	case <-closed:
	default:
		t.Fatal("drainClosedSubscription returned before the subscription channel closed")
	}
}

// TestMemoryStreamStoreSubscribeJoinBlocksUntilThePumpCloses is the strict
// call-site test for the (MemoryStreamStore).Subscribe baseline entry: the pump
// closes its channel with the subscription context and the forwarder drains it
// (drainClosedSubscription) before the streamed body is released.
//
// Holding the store's mutex keeps the pump from finishing and closing its
// channel. The release therefore cannot return while the mutex is held when the
// join is present; deleting the drain makes the forwarder give up on the channel
// and release the body immediately, which the assertion catches.
func TestMemoryStreamStoreSubscribeJoinBlocksUntilThePumpCloses(t *testing.T) {
	store := NewMemoryStreamStore()
	scope := newStreamScope(context.Background())

	streamID, err := store.Create(scope.context(), "sess-join")
	if err != nil {
		t.Fatalf("create stream: %v", err)
	}
	events, err := store.Subscribe(scope.context(), "sess-join", streamID, "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	closer := scopedSSEBody(t, scope, events)

	// The pump needs this mutex to observe the canceled context and close its
	// channel; holding it makes the join observable.
	store.mu.Lock()
	released := make(chan struct{})
	go func() {
		defer close(released)
		if closeErr := closer.Close(); closeErr != nil {
			t.Errorf("close streamed body: %v", closeErr)
		}
	}()

	select {
	case <-released:
		store.mu.Unlock()
		t.Fatal("the streamed body was released before the store closed its subscription channel")
	case <-time.After(joinDominanceLinger):
	}
	store.mu.Unlock()

	select {
	case <-released:
	case <-time.After(2 * time.Second):
		t.Fatal("the streamed body was not released after the store closed its subscription channel")
	}
	assertNoGoroutineFor(t, "(*MemoryStreamStore).pumpSubscription", "streamed body released")
	assertNoGoroutineFor(t, "forwardStreamEvents", "streamed body released")
}

// TestMemoryStreamStoreBroadcastOnDoneWaitJoinsTheWatcher is the strict test for
// the (MemoryStreamStore).broadcastOnDone baseline entry: the returned wait
// function blocks until the watcher has run.
//
// The store's mutex is held so the watcher cannot complete its broadcast. The
// wait must not return while the watcher is blocked; replacing the returned
// watcher.Wait with a no-op makes it return immediately and the assertion
// catches it.
func TestMemoryStreamStoreBroadcastOnDoneWaitJoinsTheWatcher(t *testing.T) {
	store := NewMemoryStreamStore()
	stream := &memoryStream{cond: sync.NewCond(&store.mu)}

	done := make(chan struct{})
	stop := make(chan struct{})

	store.mu.Lock()
	waitBroadcast := store.broadcastOnDone(done, stop, stream)
	close(done)

	waited := make(chan struct{})
	go func() {
		defer close(waited)
		waitBroadcast()
	}()

	select {
	case <-waited:
		store.mu.Unlock()
		t.Fatal("the broadcast wait returned before the watcher ran")
	case <-time.After(50 * time.Millisecond):
	}
	store.mu.Unlock()

	select {
	case <-waited:
	case <-time.After(2 * time.Second):
		t.Fatal("the broadcast wait did not return after the watcher ran")
	}
	assertNoGoroutineFor(t, "(*MemoryStreamStore).broadcastOnDone.func", "broadcast wait returned")
}

// lateClosingSubscription relays a store subscription and closes its own channel
// only after linger, so a release that waited for the store's channel close is
// observable. The real store's channel has closed by the time the relay closes
// its own, so the forwarder draining the relay's channel is what waits for the
// store's pump.
func lateClosingSubscription(linger time.Duration, events <-chan StreamEvent) (chan StreamEvent, <-chan struct{}) {
	out := make(chan StreamEvent)
	closed := make(chan struct{})
	go func() {
		for event := range events {
			out <- event
		}
		time.Sleep(linger)
		// Signal the linger before releasing the drain: the drain returns when
		// out closes, so closing the marker first keeps the ordering assertion
		// below race-free.
		close(closed)
		close(out)
	}()
	return out, closed
}

// TestDynamoStreamStoreSubscribeJoinBlocksUntilThePumpCloses is the strict
// call-site test for the (DynamoStreamStore).Subscribe baseline entry: the pump
// observes the subscription context and closes its channel, and the forwarder
// drains it before the streamed body is released.
//
// The store's subscription is relayed through a late-closing channel so the
// join is observable; deleting the drain makes the forwarder return as soon as
// the scope is canceled, releasing the body before the store's channel closed.
func TestDynamoStreamStoreSubscribeJoinBlocksUntilThePumpCloses(t *testing.T) {
	db := newFakeMCPTableDB()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	if !ok {
		t.Fatal("expected a *DynamoStreamStore")
	}
	store.pollInterval = time.Millisecond

	scope := newStreamScope(context.Background())
	streamID, err := store.Create(scope.context(), "sess-join")
	if err != nil {
		t.Fatalf("create stream: %v", err)
	}
	events, err := store.Subscribe(scope.context(), "sess-join", streamID, "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	subscription, closed := lateClosingSubscription(joinDominanceLinger, events)

	closer := scopedSSEBody(t, scope, subscription)

	started := time.Now()
	if closeErr := closer.Close(); closeErr != nil {
		t.Fatalf("close streamed body: %v", closeErr)
	}
	elapsed := time.Since(started)

	if elapsed < joinDominanceLinger/2 {
		t.Fatalf("the streamed body was released after %s, before the store's subscription closed (linger %s)", elapsed, joinDominanceLinger)
	}
	select {
	case <-closed:
	default:
		t.Fatal("the streamed body was released before the store's subscription channel closed")
	}
	assertNoGoroutineFor(t, "(*DynamoStreamStore).pumpSubscription", "streamed body released")
	assertNoGoroutineFor(t, "forwardStreamEvents", "streamed body released")
}
