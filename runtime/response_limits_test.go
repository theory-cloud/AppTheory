package apptheory

import (
	"bytes"
	"context"
	"errors"
	"io"
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
