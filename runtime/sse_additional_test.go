package apptheory

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

func TestSSEDataString_CoversNilStringBytesAndMarshalError(t *testing.T) {
	t.Parallel()

	if got, err := sseDataString(nil); err != nil || got != "" {
		t.Fatalf("expected nil to return empty string, got %q err=%v", got, err)
	}
	if got, err := sseDataString("hi"); err != nil || got != "hi" {
		t.Fatalf("expected string to pass through, got %q err=%v", got, err)
	}
	if got, err := sseDataString([]byte("hi")); err != nil || got != "hi" {
		t.Fatalf("expected bytes to pass through, got %q err=%v", got, err)
	}
	if _, err := sseDataString(make(chan int)); err == nil {
		t.Fatal("expected marshal error")
	}
}

func TestFormatSSEEvent_FramesAndNormalizesNewlines(t *testing.T) {
	t.Parallel()

	b, err := formatSSEEvent(SSEEvent{
		ID:    " 1 ",
		Event: " message ",
		Data:  "a\r\nb\rc",
	})
	if err != nil {
		t.Fatalf("formatSSEEvent: %v", err)
	}
	want := "id: 1\nevent: message\ndata: a\ndata: b\ndata: c\n\n"
	if string(b) != want {
		t.Fatalf("unexpected framing:\nwant=%q\ngot =%q", want, string(b))
	}

	// nil data should still emit one data line.
	b, err = formatSSEEvent(SSEEvent{Data: nil})
	if err != nil {
		t.Fatalf("formatSSEEvent(nil data): %v", err)
	}
	if string(b) != "data: \n\n" {
		t.Fatalf("unexpected framing for nil data: %q", string(b))
	}
}

func TestSSEStreamResponse_ContextCancelAndErrorPropagation(t *testing.T) {
	t.Parallel()

	resp, err := SSEStreamResponse(context.Background(), 200, nil)
	if err != nil {
		t.Fatalf("SSEStreamResponse(nil events): %v", err)
	}
	if resp.BodyReader == nil {
		t.Fatal("expected BodyReader for stream response")
	}
	if _, readErr := io.ReadAll(resp.BodyReader); readErr != nil { // should EOF
		t.Fatalf("read stream: %v", readErr)
	}

	// Context cancellation should stop streaming.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	events := make(chan SSEEvent)
	resp, err = SSEStreamResponse(ctx, 200, events)
	if err != nil {
		t.Fatalf("SSEStreamResponse(canceled ctx): %v", err)
	}
	if _, readErr := io.ReadAll(resp.BodyReader); readErr != nil {
		t.Fatalf("read canceled stream: %v", readErr)
	}

	// Stream error should propagate through the pipe.
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	ch := make(chan SSEEvent, 1)
	ch <- SSEEvent{Data: make(chan int)} // will fail JSON marshal
	close(ch)

	resp, err = SSEStreamResponse(ctx, 200, ch)
	if err != nil {
		t.Fatalf("SSEStreamResponse(error): %v", err)
	}
	_, readErr := io.ReadAll(resp.BodyReader)
	if readErr == nil {
		t.Fatal("expected read error from stream failure")
	}
}

func TestSafeCloseHelpers_DoNotPanicOnNil(t *testing.T) {
	t.Parallel()

	safeClosePipeWriter(nil)
	closePipeWriterWithError(nil, errors.New("boom"))
}

func TestMustSSEResponse_PanicsOnError(t *testing.T) {
	t.Parallel()

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic")
		}
	}()
	_ = MustSSEResponse(200, SSEEvent{Data: make(chan int)})
}

func TestSSEResponse_ConcatenatesEvents(t *testing.T) {
	t.Parallel()

	ev1 := SSEEvent{Data: "a"}
	ev2 := SSEEvent{Data: "b"}

	resp, err := SSEResponse(200, ev1, ev2)
	if err != nil {
		t.Fatalf("SSEResponse: %v", err)
	}
	if !bytes.Contains(resp.Body, []byte("data: a")) || !bytes.Contains(resp.Body, []byte("data: b")) {
		t.Fatalf("unexpected body: %q", string(resp.Body))
	}
}
