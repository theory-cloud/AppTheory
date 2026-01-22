package zap

import (
	"context"
	"io"
	"sync"
	"testing"
	"time"

	ubzap "go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/theory-cloud/apptheory/pkg/observability"
)

type recordingNotifier struct {
	mu      sync.Mutex
	entries []observability.LogEntry
	err     error

	block <-chan struct{}
}

func (n *recordingNotifier) Notify(_ context.Context, entry observability.LogEntry) error {
	if n.block != nil {
		<-n.block
	}
	n.mu.Lock()
	n.entries = append(n.entries, entry)
	err := n.err
	n.mu.Unlock()
	return err
}

func TestZapLogger_Notifier_SendsEntry_WithIDsAndFieldOverrides(t *testing.T) {
	t.Parallel()

	base := ubzap.New(zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		zapcore.AddSync(io.Discard),
		zapcore.DebugLevel,
	))

	notifier := &recordingNotifier{}
	logger, err := NewZapLogger(observability.LoggerConfig{
		MaxRetries:  1,
		RetryDelay:  time.Millisecond,
		BufferSize:  8,
		Level:       "debug",
		Format:      "json",
		EnableStack: false,
	}, WithZapLogger(base), WithErrorNotifier(notifier), WithSanitizer(nil))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}

	logger.WithFields(map[string]any{"k": "base"}).
		WithRequestID("req_1").
		WithTenantID("t1").
		WithUserID("u1").
		WithTraceID("tr1").
		WithSpanID("sp1").
		Info("no notify", map[string]any{"k": "info"})

	logger.WithFields(map[string]any{"k": "base"}).
		WithRequestID("req_1").
		WithTenantID("t1").
		WithUserID("u1").
		WithTraceID("tr1").
		WithSpanID("sp1").
		Error("boom", map[string]any{"k": "call"})

	if err := logger.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	notifier.mu.Lock()
	defer notifier.mu.Unlock()
	if len(notifier.entries) != 1 {
		t.Fatalf("expected 1 notification entry, got %d", len(notifier.entries))
	}
	entry := notifier.entries[0]
	if entry.Level != levelError || entry.Message != "boom" {
		t.Fatalf("unexpected entry: %#v", entry)
	}
	if entry.RequestID != "req_1" || entry.TenantID != "t1" || entry.UserID != "u1" || entry.TraceID != "tr1" || entry.SpanID != "sp1" {
		t.Fatalf("unexpected IDs: %#v", entry)
	}
	if entry.Fields["k"] != "call" {
		t.Fatalf("expected call fields to override base fields, got %#v", entry.Fields)
	}

	if err := logger.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestZapLogger_Notifier_DropsWhenBufferFull_AndFlushContextCancel(t *testing.T) {
	t.Parallel()

	base := ubzap.New(zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		zapcore.AddSync(io.Discard),
		zapcore.DebugLevel,
	))

	block := make(chan struct{})
	notifier := &recordingNotifier{block: block}
	loggerAny, err := NewZapLogger(observability.LoggerConfig{
		MaxRetries: 1,
		BufferSize: 1,
		Level:      "debug",
		Format:     "json",
	}, WithZapLogger(base), WithErrorNotifier(notifier))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}
	logger, ok := loggerAny.(*Logger)
	if !ok {
		t.Fatalf("expected *Logger, got %T", loggerAny)
	}

	// First enqueue is consumed by the notifier goroutine and blocks in Notify.
	logger.Error("e1")
	// Second enqueue fills the buffer.
	logger.Error("e2")
	// Third enqueue should drop.
	logger.Error("e3")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := logger.Flush(ctx); err != nil { // should return without waiting for blocked notifier
		t.Fatalf("Flush: %v", err)
	}

	close(block) // unblock notifier to allow shutdown
	if err := logger.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	stats := logger.GetStats()
	if stats.EntriesDropped == 0 {
		t.Fatalf("expected entries to be dropped when buffer is full, got %#v", stats)
	}

	// Directly exercise enqueue drop when notifier is closed/nil.
	logger.core.enqueueNotification(observability.LogEntry{})
	if logger.core.entriesDropped.Load() == 0 {
		t.Fatalf("expected enqueueNotification to record drops when closed, got %#v", logger.GetStats())
	}
}

func TestZapLogger_NotifierFailure_SetsLastErrorAndUnhealthy(t *testing.T) {
	t.Parallel()

	base := ubzap.New(zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		zapcore.AddSync(io.Discard),
		zapcore.DebugLevel,
	))

	notifier := &recordingNotifier{err: context.Canceled}
	loggerAny, err := NewZapLogger(observability.LoggerConfig{
		MaxRetries: 1,
		BufferSize: 8,
		Level:      "debug",
		Format:     "json",
	}, WithZapLogger(base), WithErrorNotifier(notifier))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}
	logger, ok := loggerAny.(*Logger)
	if !ok {
		t.Fatalf("expected *Logger, got %T", loggerAny)
	}

	logger.Error("boom")
	if err := logger.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	if logger.IsHealthy() {
		t.Fatal("expected IsHealthy=false after notifier failure")
	}
	stats := logger.GetStats()
	if stats.ErrorCount == 0 || stats.LastError == "" {
		t.Fatalf("expected stats to include error, got %#v", stats)
	}

	if err := logger.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}
