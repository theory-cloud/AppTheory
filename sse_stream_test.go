package apptheory

import (
	"context"
	"io"
	"testing"
)

func TestSSEStreamResponse_MatchesBufferedSSE(t *testing.T) {
	ev1 := SSEEvent{ID: "1", Event: "message", Data: map[string]any{"ok": true}}
	ev2 := SSEEvent{ID: "2", Event: "message", Data: "hello"}

	buffered, err := SSEResponse(200, ev1, ev2)
	if err != nil {
		t.Fatalf("SSEResponse: %v", err)
	}

	ch := make(chan SSEEvent, 2)
	ch <- ev1
	ch <- ev2
	close(ch)

	streamed, err := SSEStreamResponse(context.Background(), 200, ch)
	if err != nil {
		t.Fatalf("SSEStreamResponse: %v", err)
	}
	if streamed.BodyReader == nil {
		t.Fatalf("expected BodyReader to be set")
	}

	got, err := io.ReadAll(streamed.BodyReader)
	if err != nil {
		t.Fatalf("read streamed body: %v", err)
	}

	if string(got) != string(buffered.Body) {
		t.Fatalf("streamed body mismatch:\nstreamed=%q\nbuffered=%q", string(got), string(buffered.Body))
	}
}
