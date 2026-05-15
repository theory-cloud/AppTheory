package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestMemoryStreamStore_IDGeneratorAndDeleteSession(t *testing.T) {
	store := NewMemoryStreamStore(WithStreamIDGenerator(staticIDGenerator{id: "stream-1"}))

	streamID, err := store.Create(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if streamID != "stream-1" {
		t.Fatalf("streamID: got %q want %q", streamID, "stream-1")
	}

	if _, err := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"jsonrpc":"2.0"}`)); err != nil {
		t.Fatalf("Append: %v", err)
	}

	// DeleteSession should remove all stream state.
	if err := store.DeleteSession(context.Background(), "sess-1"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, err := store.Subscribe(context.Background(), "sess-1", streamID, ""); !errors.Is(err, ErrStreamNotFound) {
		t.Fatalf("Subscribe after DeleteSession: got %v want %v", err, ErrStreamNotFound)
	}

	// Deleting a missing session is a no-op.
	if err := store.DeleteSession(context.Background(), "missing"); err != nil {
		t.Fatalf("DeleteSession(missing): %v", err)
	}
}

func TestMemoryStreamStore_SubscribeRejectsLastEventIDFromDifferentStream(t *testing.T) {
	store := NewMemoryStreamStore()

	streamA, err := store.Create(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("Create streamA: %v", err)
	}
	streamB, err := store.Create(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("Create streamB: %v", err)
	}

	if _, appendErr := store.Append(context.Background(), "sess-1", streamA, json.RawMessage(`{"stream":"A","seq":1}`)); appendErr != nil {
		t.Fatalf("Append streamA: %v", appendErr)
	}
	eventB, err := store.Append(context.Background(), "sess-1", streamB, json.RawMessage(`{"stream":"B","seq":1}`))
	if err != nil {
		t.Fatalf("Append streamB: %v", err)
	}
	if _, appendErr := store.Append(context.Background(), "sess-1", streamA, json.RawMessage(`{"stream":"A","seq":2}`)); appendErr != nil {
		t.Fatalf("Append streamA second: %v", appendErr)
	}

	if _, err := store.Subscribe(context.Background(), "sess-1", streamA, eventB); !errors.Is(err, ErrEventNotFound) {
		t.Fatalf("Subscribe with cross-stream Last-Event-ID: got %v want %v", err, ErrEventNotFound)
	}
}

func TestMemoryStreamStore_Errors(t *testing.T) {
	store := NewMemoryStreamStore()

	if _, err := store.Create(context.Background(), ""); err == nil {
		t.Fatalf("expected Create to error on missing session id")
	}

	if _, err := store.Append(context.Background(), "", "s", nil); err == nil {
		t.Fatalf("expected Append to error on missing session id")
	}
	if _, err := store.Append(context.Background(), "sess", "", nil); err == nil {
		t.Fatalf("expected Append to error on missing stream id")
	}
	if _, err := store.Append(context.Background(), "sess", "missing", nil); !errors.Is(err, ErrStreamNotFound) {
		t.Fatalf("expected ErrStreamNotFound, got %v", err)
	}

	if err := store.Close(context.Background(), "", "s"); err == nil {
		t.Fatalf("expected Close to error on missing session id")
	}
	if err := store.Close(context.Background(), "sess", ""); err == nil {
		t.Fatalf("expected Close to error on missing stream id")
	}
	if err := store.Close(context.Background(), "sess", "missing"); !errors.Is(err, ErrStreamNotFound) {
		t.Fatalf("expected ErrStreamNotFound, got %v", err)
	}

	if _, err := store.StreamForEvent(context.Background(), "", "1"); err == nil {
		t.Fatalf("expected StreamForEvent to error on missing session id")
	}
	if _, err := store.StreamForEvent(context.Background(), "sess", ""); err == nil {
		t.Fatalf("expected StreamForEvent to error on missing event id")
	}
	if _, err := store.StreamForEvent(context.Background(), "sess", "not-a-number"); err == nil {
		t.Fatalf("expected StreamForEvent to error on invalid event id")
	}
	if _, err := store.StreamForEvent(context.Background(), "sess", "1"); !errors.Is(err, ErrEventNotFound) {
		t.Fatalf("expected ErrEventNotFound, got %v", err)
	}

	if _, err := store.Subscribe(context.Background(), "", "s", ""); err == nil {
		t.Fatalf("expected Subscribe to error on missing session id")
	}
	if _, err := store.Subscribe(context.Background(), "sess", "", ""); err == nil {
		t.Fatalf("expected Subscribe to error on missing stream id")
	}
	if _, err := store.Subscribe(context.Background(), "sess", "missing", ""); !errors.Is(err, ErrStreamNotFound) {
		t.Fatalf("expected ErrStreamNotFound, got %v", err)
	}
	if _, err := store.Subscribe(context.Background(), "sess", "missing", "not-a-number"); err == nil {
		t.Fatalf("expected Subscribe to error on invalid last-event-id")
	}
}
