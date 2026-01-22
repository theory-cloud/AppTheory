package apptheory

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestStreamBytes_CopiesChunks(t *testing.T) {
	chunk := []byte("a")
	stream := StreamBytes(chunk)
	chunk[0] = 'X'

	_, body, err := CaptureBodyStream(context.Background(), stream)
	if err != nil {
		t.Fatalf("CaptureBodyStream returned error: %v", err)
	}
	if string(body) != "a" {
		t.Fatalf("expected body 'a', got %q", string(body))
	}
}

func TestStreamError(t *testing.T) {
	streamErr := errors.New("boom")
	_, _, err := CaptureBodyStream(context.Background(), StreamError(streamErr))
	if !errors.Is(err, streamErr) {
		t.Fatalf("expected error %v, got %v", streamErr, err)
	}
}

func TestCaptureBodyStream_EdgeCases(t *testing.T) {
	chunks, body, err := CaptureBodyStream(context.Background(), nil)
	if err != nil || chunks != nil || body != nil {
		t.Fatalf("expected nil stream to return nils, got chunks=%v body=%v err=%v", chunks, body, err)
	}
}

func TestCaptureBodyStream_Cancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	stream := make(chan StreamChunk, 2)
	stream <- StreamChunk{Bytes: []byte("a")}

	cancel()
	chunks, body, err := CaptureBodyStream(ctx, stream)
	if err == nil {
		t.Fatal("expected cancellation error")
	}
	// CaptureBodyStream may observe cancellation before draining buffered chunks; accept either outcome.
	if string(body) != "" && string(body) != "a" {
		t.Fatalf("unexpected captured body on cancel: %q (chunks=%v)", string(body), chunks)
	}
}

func TestCaptureBodyStream_EmptyChunks(t *testing.T) {
	stream := make(chan StreamChunk, 2)
	stream <- StreamChunk{Bytes: []byte{}}
	close(stream)

	chunks, body, err := CaptureBodyStream(context.Background(), stream)
	if err != nil {
		t.Fatalf("CaptureBodyStream returned error: %v", err)
	}
	if len(chunks) != 1 || len(chunks[0]) != 0 {
		t.Fatalf("unexpected chunks: %v", chunks)
	}
	if len(body) != 0 {
		t.Fatalf("expected empty body, got %q", string(body))
	}
}

func TestCaptureBodyStream_ContextDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()

	stream := make(chan StreamChunk)

	_, _, err := CaptureBodyStream(ctx, stream)
	if err == nil {
		t.Fatal("expected deadline error")
	}
}
