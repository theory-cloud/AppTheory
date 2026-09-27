package streamjoin

import (
	"bytes"
	"context"
	"errors"
	"io"
	"runtime"
	"strings"
	"testing"
	"time"
)

const producerFrameMarker = "runtime/internal/streamjoin.New.func"

// producerGoroutines returns the stacks of live goroutines still executing the
// producer closure started by New.
func producerGoroutines() string {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			stack := string(buf[:n])
			if !strings.Contains(stack, producerFrameMarker) {
				return ""
			}
			var leaked []string
			for _, block := range strings.Split(stack, "\n\n") {
				if strings.Contains(block, producerFrameMarker) {
					leaked = append(leaked, block)
				}
			}
			return strings.Join(leaked, "\n\n")
		}
		buf = make([]byte, 2*len(buf))
	}
}

// assertNoProducerGoroutine fails the test if a producer started by New is
// still running. The producer signals its join channel from a deferred call, so
// the stack is sampled over a short settle window instead of once.
func assertNoProducerGoroutine(t *testing.T, when string) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for {
		stack := producerGoroutines()
		if stack == "" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: producer goroutine outlived the body reader:\n%s", when, stack)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestBodyStreamsAndJoinsBeforeEOF(t *testing.T) {
	producerReturned := false

	body := New(context.Background(), func(_ context.Context, w *io.PipeWriter) {
		defer func() {
			if err := w.Close(); err != nil {
				t.Errorf("close pipe writer: %v", err)
			}
		}()

		if _, err := w.Write([]byte("first")); err != nil {
			t.Errorf("write first chunk: %v", err)
			return
		}
		if _, err := w.Write([]byte("second")); err != nil {
			t.Errorf("write second chunk: %v", err)
			return
		}
		producerReturned = true
	})

	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(got) != "firstsecond" {
		t.Fatalf("body = %q, want %q", got, "firstsecond")
	}
	if !producerReturned {
		t.Fatal("EOF was reported before the producer returned")
	}
	assertNoProducerGoroutine(t, "after EOF")
}

func TestCloseJoinsProducerBlockedOnWrite(t *testing.T) {
	released := make(chan struct{})

	body := New(context.Background(), func(_ context.Context, w *io.PipeWriter) {
		defer close(released)
		// This write blocks until the reader is closed; Close must unblock it.
		if _, err := w.Write([]byte("never read")); err != nil {
			return
		}
	})

	closed := make(chan error, 1)
	go func() { closed <- body.Close() }()

	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("close body: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not wait for the producer to be released")
	}

	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("producer was not released by Close")
	}

	if err := body.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	assertNoProducerGoroutine(t, "after Close")
}

func TestCloseJoinsProducerBlockedOnChannelReceive(t *testing.T) {
	released := make(chan struct{})

	body := New(context.Background(), func(ctx context.Context, w *io.PipeWriter) {
		defer close(released)
		// A producer that pulls from an external source blocks on a channel
		// receive, which pipe closure alone cannot interrupt; the producer
		// context must be canceled by Close.
		select {
		case <-ctx.Done():
		case <-time.After(10 * time.Second):
		}
	})

	closed := make(chan error, 1)
	go func() { closed <- body.Close() }()

	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("close body: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not interrupt a producer blocked on a channel receive")
	}

	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("producer context was not canceled by Close")
	}
	assertNoProducerGoroutine(t, "after channel close")
}

func TestReadReportsProducerErrorAfterJoin(t *testing.T) {
	wantErr := errors.New("producer failed")
	producerReturned := false

	body := New(context.Background(), func(_ context.Context, w *io.PipeWriter) {
		defer func() { producerReturned = true }()
		if err := w.CloseWithError(wantErr); err != nil {
			t.Errorf("close pipe writer with error: %v", err)
		}
	})

	_, err := io.ReadAll(body)
	if !errors.Is(err, wantErr) {
		t.Fatalf("read error = %v, want %v", err, wantErr)
	}
	if !producerReturned {
		t.Fatal("error was reported before the producer returned")
	}
	assertNoProducerGoroutine(t, "after producer error")
}

func TestCloseEndsStreamEarlyForReader(t *testing.T) {
	body := New(context.Background(), func(ctx context.Context, w *io.PipeWriter) {
		<-ctx.Done()
	})

	readErr := make(chan error, 1)
	go func() {
		buf := make([]byte, 8)
		_, err := body.Read(buf)
		readErr <- err
	}()

	time.Sleep(10 * time.Millisecond)
	if err := body.Close(); err != nil {
		t.Fatalf("close body: %v", err)
	}

	select {
	case err := <-readErr:
		if !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("blocked read error = %v, want %v", err, io.ErrClosedPipe)
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not release a blocked read")
	}
	assertNoProducerGoroutine(t, "after closing a blocked read")
}

func TestNewNilInputs(t *testing.T) {
	// A nil parent context and a nil producer are both supported; they are
	// passed through variables so the call is not a literal nil context.
	var parent context.Context
	var produce Producer

	body := New(parent, produce)

	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read nil-producer body: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("nil-producer body = %q, want empty", got)
	}
	if err := body.Close(); err != nil {
		t.Fatalf("close nil-producer body: %v", err)
	}
	assertNoProducerGoroutine(t, "after nil producer")

	var absent *Body
	if n, err := absent.Read(make([]byte, 1)); n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("nil body read = (%d, %v), want (0, EOF)", n, err)
	}
	if err := absent.Close(); err != nil {
		t.Fatalf("nil body close = %v, want nil", err)
	}
}

func TestParentCancellationEndsBody(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	released := make(chan struct{})

	body := New(parent, func(ctx context.Context, w *io.PipeWriter) {
		defer close(released)
		select {
		case <-ctx.Done():
		case <-time.After(10 * time.Second):
		}
		if err := w.Close(); err != nil {
			t.Errorf("close pipe writer: %v", err)
		}
	})

	cancel()

	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("body = %q, want empty", got)
	}

	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("parent cancellation did not reach the producer")
	}
	assertNoProducerGoroutine(t, "after parent cancellation")
}

func TestBodySatisfiesReadCloser(t *testing.T) {
	var body io.ReadCloser = New(context.Background(), func(_ context.Context, w *io.PipeWriter) {
		if _, err := w.Write([]byte("payload")); err != nil {
			return
		}
	})

	got, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if !bytes.Equal(got, []byte("payload")) {
		t.Fatalf("body = %q, want %q", got, "payload")
	}
	if err := body.Close(); err != nil {
		t.Fatalf("close body: %v", err)
	}
}
