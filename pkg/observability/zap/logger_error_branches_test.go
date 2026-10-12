package zap

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory/v6/pkg/observability"
)

type flakyNotifier struct {
	failures int
	calls    int
}

func (n *flakyNotifier) Notify(_ context.Context, _ observability.LogEntry) error {
	n.calls++
	if n.calls <= n.failures {
		return errors.New("notify failed")
	}
	return nil
}

func TestNewZapLogger_RejectsUnsupportedFormatAndLevel(t *testing.T) {
	t.Parallel()

	if _, err := NewZapLogger(observability.LoggerConfig{Format: "nope"}); err == nil {
		t.Fatal("expected error for unsupported log format")
	}

	if _, err := NewZapLogger(observability.LoggerConfig{Level: "nope"}); err == nil {
		t.Fatal("expected error for unsupported log level")
	}
}

func TestZapCore_NotifyWithRetries_DefaultsAndStopsOnSuccess(t *testing.T) {
	t.Parallel()

	notifier := &flakyNotifier{failures: 2}
	core := &zapCore{
		notifier:   notifier,
		maxRetries: 0, // exercise default=3
		retryDelay: time.Nanosecond,
	}

	if err := core.notifyWithRetries(observability.LogEntry{Message: "x"}); err != nil {
		t.Fatalf("expected notify to succeed after retries, got %v", err)
	}
	if notifier.calls != 3 {
		t.Fatalf("expected 3 notify attempts, got %d", notifier.calls)
	}

	core.notifier = nil
	if err := core.notifyWithRetries(observability.LogEntry{}); err != nil {
		t.Fatalf("expected nil notifier to return nil, got %v", err)
	}
}

func TestZapCore_EnqueueNotification_BoundedQueue(t *testing.T) {
	t.Parallel()

	// A core with no queue (no notifier) drops the entry rather than blocking.
	var empty zapCore
	empty.enqueueNotification(observability.LogEntry{})
	if empty.entriesDropped.Load() != 1 {
		t.Fatalf("expected a drop for a nil queue, got %d", empty.entriesDropped.Load())
	}

	// A full queue drops the overflow entry instead of growing the backlog.
	core := &zapCore{notifyCh: make(chan observability.LogEntry, 1)}
	core.enqueueNotification(observability.LogEntry{Message: "first"})
	core.enqueueNotification(observability.LogEntry{Message: "second"})
	if core.entriesDropped.Load() != 1 {
		t.Fatalf("expected the overflow entry to be dropped, got drops=%d", core.entriesDropped.Load())
	}
}

func TestZapCore_LastErrorString_EmptyWhenUnset(t *testing.T) {
	t.Parallel()

	var core zapCore
	if got := core.lastErrorString(); got != "" {
		t.Fatalf("expected empty last error, got %q", got)
	}
}

func TestLogger_NilReceiverMethods_AreSafe(t *testing.T) {
	t.Parallel()

	var logger *Logger
	if err := logger.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if err := logger.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if logger.IsHealthy() {
		t.Fatal("expected IsHealthy=false for nil logger")
	}
	_ = logger.GetStats()
}

func TestLogger_Info_NoOpWhenLoggerIsNil(t *testing.T) {
	t.Parallel()

	(&Logger{}).Info("ok")
}
