package apptheory

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestServePortable_MaxResponseBytesTerminatesBodyStreamLate(t *testing.T) {
	app := New(
		WithTier(TierP1),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithLimits(Limits{MaxResponseBytes: 5}),
	)
	app.Get("/html-stream", func(_ *Context) (*Response, error) {
		return HTMLStream(200, StreamBytes([]byte("<h1>"), []byte("Hello</h1>"))), nil
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/html-stream"})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}
	if got := resp.Headers["x-request-id"]; len(got) != 1 || got[0] != "req_1" {
		t.Fatalf("unexpected request id header: %v", got)
	}

	chunks, body, err := CaptureBodyStream(context.Background(), resp.BodyStream)
	if err == nil {
		t.Fatal("expected stream error")
	}
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Code != errorCodeTooLarge {
		t.Fatalf("expected app.too_large, got %v", err)
	}
	if len(chunks) != 1 || string(chunks[0]) != "<h1>" {
		t.Fatalf("unexpected chunks: %q", chunks)
	}
	if string(body) != "<h1>" {
		t.Fatalf("unexpected body: %q", string(body))
	}
}

func TestServePortable_MaxResponseBytesTerminatesBodyReaderLate(t *testing.T) {
	app := New(
		WithTier(TierP1),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithLimits(Limits{MaxResponseBytes: 5}),
	)
	app.Get("/reader-stream", func(_ *Context) (*Response, error) {
		return &Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"text/plain; charset=utf-8"},
			},
			BodyReader: bytes.NewReader([]byte("abcdef")),
		}, nil
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/reader-stream"})
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}
	body, err := io.ReadAll(resp.BodyReader)
	if err == nil {
		t.Fatal("expected read error")
	}
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Code != errorCodeTooLarge {
		t.Fatalf("expected app.too_large, got %v", err)
	}
	if string(body) != "abcde" {
		t.Fatalf("unexpected limited reader body: %q", string(body))
	}
}

func TestResponseSizeLimiterDirectBranches(t *testing.T) {
	limiter := &responseSizeLimiter{max: 5, emitted: 2}
	if !limiter.allowChunk(0) {
		t.Fatal("zero-size chunks should be allowed")
	}
	if limiter.allowChunk(4) {
		t.Fatal("expected oversized chunk to trip limiter")
	}
	if limiter.allowChunk(1) {
		t.Fatal("tripped limiter must reject later chunks")
	}

	limiter = &responseSizeLimiter{max: 5, emitted: 3}
	emit, overflow := limiter.consumeReader(10)
	if emit != 2 || !overflow {
		t.Fatalf("expected partial reader emit with overflow, got emit=%d overflow=%v", emit, overflow)
	}
	emit, overflow = limiter.consumeReader(1)
	if emit != 0 || !overflow {
		t.Fatalf("expected tripped reader to report overflow, got emit=%d overflow=%v", emit, overflow)
	}

	limiter = &responseSizeLimiter{max: 1, emitted: 1}
	emit, overflow = limiter.consumeReader(1)
	if emit != 0 || !overflow {
		t.Fatalf("expected no remaining budget, got emit=%d overflow=%v", emit, overflow)
	}
}

func TestLimitBodyStreamPassesEmptyAndUpstreamError(t *testing.T) {
	stream := make(chan StreamChunk, 2)
	stream <- StreamChunk{Bytes: []byte{}}
	stream <- StreamChunk{Err: errors.New("upstream")}
	close(stream)

	limited := limitBodyStream(stream, &responseSizeLimiter{max: 10})
	first := <-limited
	if len(first.Bytes) != 0 || first.Err != nil {
		t.Fatalf("expected empty chunk to pass through, got %#v", first)
	}
	second := <-limited
	if second.Err == nil || second.Err.Error() != "upstream" {
		t.Fatalf("expected upstream error to pass through, got %#v", second)
	}
	if _, ok := <-limited; ok {
		t.Fatal("expected limited stream to close after upstream error")
	}

	if limitBodyStream(nil, &responseSizeLimiter{max: 1}) != nil {
		t.Fatal("nil stream should remain nil")
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }

func TestLimitBodyReaderPassesReadErrorsAndNilInputs(t *testing.T) {
	if limitBodyReader(nil, &responseSizeLimiter{max: 1}) != nil {
		t.Fatal("nil reader should remain nil")
	}
	reader := strings.NewReader("ok")
	if limitBodyReader(reader, nil) != reader {
		t.Fatal("nil limiter should return original reader")
	}

	limited := limitBodyReader(failingReader{}, &responseSizeLimiter{max: 10})
	body, err := io.ReadAll(limited)
	if len(body) != 0 || err == nil || err.Error() != "read failed" {
		t.Fatalf("expected read failure to propagate, body=%q err=%v", body, err)
	}

	closeResponseLimitPipeWriter(nil)
	closeResponseLimitPipeWriterWithError(nil, errors.New("ignored"))
}
