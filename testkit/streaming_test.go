package testkit

import (
	"context"
	"strings"
	"testing"

	"github.com/theory-cloud/apptheory"
)

func TestInvokeStreaming_Buffered(t *testing.T) {
	env := New()
	app := env.App(apptheory.WithTier(apptheory.TierP0))
	app.Get("/ping", func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(200, "pong"), nil
	})

	out := env.InvokeStreaming(context.Background(), app, apptheory.Request{Method: "GET", Path: "/ping"})
	if got := string(out.Body); got != "pong" {
		t.Fatalf("body mismatch: %q", got)
	}
	if out.StreamErrorCode != "" {
		t.Fatalf("stream_error_code: expected empty, got %q", out.StreamErrorCode)
	}
	if len(out.Chunks) != 1 || string(out.Chunks[0]) != "pong" {
		t.Fatalf("chunks mismatch: %#v", out.Chunks)
	}
}

func TestInvokeStreaming_BodyStream(t *testing.T) {
	env := New()
	app := env.App(apptheory.WithTier(apptheory.TierP0))
	app.Get("/stream", func(_ *apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"text/plain; charset=utf-8"},
			},
			BodyStream: apptheory.StreamBytes([]byte("a"), []byte("b")),
		}, nil
	})

	out := env.InvokeStreaming(context.Background(), app, apptheory.Request{Method: "GET", Path: "/stream"})
	if got := string(out.Body); got != "ab" {
		t.Fatalf("body mismatch: %q", got)
	}
	if out.StreamErrorCode != "" {
		t.Fatalf("stream_error_code: expected empty, got %q", out.StreamErrorCode)
	}
	if len(out.Chunks) != 2 || string(out.Chunks[0]) != "a" || string(out.Chunks[1]) != "b" {
		t.Fatalf("chunks mismatch: %#v", out.Chunks)
	}
}

func TestInvokeStreaming_BodyReader(t *testing.T) {
	env := New()
	app := env.App(apptheory.WithTier(apptheory.TierP0))
	app.Get("/reader", func(_ *apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{
			Status:     200,
			Headers:    map[string][]string{"content-type": {"text/plain; charset=utf-8"}},
			BodyReader: strings.NewReader("hello"),
		}, nil
	})

	out := env.InvokeStreaming(context.Background(), app, apptheory.Request{Method: "GET", Path: "/reader"})
	if got := string(out.Body); got != "hello" {
		t.Fatalf("body mismatch: %q", got)
	}
	if out.StreamErrorCode != "" {
		t.Fatalf("stream_error_code: expected empty, got %q", out.StreamErrorCode)
	}
	if len(out.Chunks) != 1 || string(out.Chunks[0]) != "hello" {
		t.Fatalf("chunks mismatch: %#v", out.Chunks)
	}
}

func TestInvokeStreaming_LateError(t *testing.T) {
	env := New()
	app := env.App(apptheory.WithTier(apptheory.TierP0))
	app.Get("/err", func(_ *apptheory.Context) (*apptheory.Response, error) {
		ch := make(chan apptheory.StreamChunk, 2)
		ch <- apptheory.StreamChunk{Bytes: []byte("hello")}
		ch <- apptheory.StreamChunk{Err: &apptheory.AppError{Code: "app.internal", Message: "boom"}}
		close(ch)
		return &apptheory.Response{
			Status:     200,
			Headers:    map[string][]string{"content-type": {"text/plain; charset=utf-8"}},
			BodyStream: ch,
		}, nil
	})

	out := env.InvokeStreaming(context.Background(), app, apptheory.Request{Method: "GET", Path: "/err"})
	if got := string(out.Body); got != "hello" {
		t.Fatalf("body mismatch: %q", got)
	}
	if out.StreamErrorCode != "app.internal" {
		t.Fatalf("stream_error_code mismatch: %q", out.StreamErrorCode)
	}
	if len(out.Chunks) != 1 || string(out.Chunks[0]) != "hello" {
		t.Fatalf("chunks mismatch: %#v", out.Chunks)
	}
}
