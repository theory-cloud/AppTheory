package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"
)

func collectStreamEvents(t *testing.T, ch <-chan StreamEvent, want int) []StreamEvent {
	t.Helper()

	events := make([]StreamEvent, 0, want)
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for len(events) < want {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatalf("stream closed after %d of %d events", len(events), want)
			}
			events = append(events, ev)
		case <-timer.C:
			t.Fatalf("timed out after %d of %d events", len(events), want)
		}
	}
	return events
}

func TestMemoryStreamStore_EventCountLimitEvictsOldest(t *testing.T) {
	store := NewMemoryStreamStore(WithStreamEventsPerSessionLimit(3))
	streamID, err := store.Create(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	for i := 0; i < 5; i++ {
		if _, appendErr := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(fmt.Sprintf(`{"n":%d}`, i))); appendErr != nil {
			t.Fatalf("Append(%d): %v", i, appendErr)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := store.Subscribe(ctx, "sess-1", streamID, "")
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	events := collectStreamEvents(t, ch, 3)
	cancel()

	wantIDs := []string{"3", "4", "5"}
	for i, want := range wantIDs {
		if events[i].ID != want {
			t.Fatalf("event %d id: got %q want %q", i, events[i].ID, want)
		}
	}

	if _, err := store.StreamForEvent(context.Background(), "sess-1", "2"); !errors.Is(err, ErrEventNotFound) {
		t.Fatalf("evicted event lookup: got %v want %v", err, ErrEventNotFound)
	}
	if id, err := store.StreamForEvent(context.Background(), "sess-1", "5"); err != nil || id != streamID {
		t.Fatalf("retained event lookup: got (%q, %v)", id, err)
	}
}

func TestMemoryStreamStore_SessionByteLimitEvictsOldest(t *testing.T) {
	store := NewMemoryStreamStore(WithStreamSessionByteLimit(10))
	streamID, err := store.Create(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, appendErr := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`1234`)); appendErr != nil {
			t.Fatalf("Append(%d): %v", i, appendErr)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := store.Subscribe(ctx, "sess-1", streamID, "")
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	events := collectStreamEvents(t, ch, 2)
	cancel()

	if events[0].ID != "2" || events[1].ID != "3" {
		t.Fatalf("retained event ids: got %q, %q", events[0].ID, events[1].ID)
	}
	if _, err := store.StreamForEvent(context.Background(), "sess-1", "1"); !errors.Is(err, ErrEventNotFound) {
		t.Fatalf("evicted event lookup: got %v want %v", err, ErrEventNotFound)
	}
}

func TestMemoryStreamStore_RejectsOversizeEvent(t *testing.T) {
	store := NewMemoryStreamStore(WithStreamEventByteLimit(4))
	streamID, err := store.Create(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`12345`)); !errors.Is(err, ErrStreamEventTooLarge) {
		t.Fatalf("Append oversize: got %v want %v", err, ErrStreamEventTooLarge)
	}
	if _, err := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`1234`)); err != nil {
		t.Fatalf("Append at limit: %v", err)
	}
}

func TestMemoryStreamStore_DefaultsLeaveSmallStreamsUnchanged(t *testing.T) {
	store := NewMemoryStreamStore()
	streamID, err := store.Create(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	for i := 0; i < 50; i++ {
		if _, appendErr := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{}`)); appendErr != nil {
			t.Fatalf("Append(%d): %v", i, appendErr)
		}
	}
	if _, err := store.StreamForEvent(context.Background(), "sess-1", "1"); err != nil {
		t.Fatalf("first event should be retained by default limits: %v", err)
	}
}
