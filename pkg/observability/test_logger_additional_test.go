package observability

import (
	"context"
	"testing"
	"time"
)

func TestTestLogger_EntriesAndWithCallsShareCore(t *testing.T) {
	t.Parallel()

	base := NewTestLogger()
	base.WithField("a", "b").Info("one")

	derived := base.WithRequestID("r1").WithTenantID("t1").WithUserID("u1").WithTraceID("tr1").WithSpanID("sp1")
	derived.Warn("two", map[string]any{"k": "v"})

	entries := base.Entries()
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[1].RequestID != "r1" || entries[1].TenantID != "t1" || entries[1].UserID != "u1" || entries[1].TraceID != "tr1" || entries[1].SpanID != "sp1" {
		t.Fatalf("unexpected IDs: %#v", entries[1])
	}
	if entries[1].Fields["k"] != "v" {
		t.Fatalf("unexpected fields: %#v", entries[1].Fields)
	}
}

func TestTestLogger_FlushAndCloseAndStatsBranches(t *testing.T) {
	t.Parallel()

	logger := NewTestLogger()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := logger.Flush(ctx); err == nil {
		t.Fatal("expected canceled context error")
	}

	if err := logger.Flush(context.Background()); err != nil {
		t.Fatalf("expected Flush to succeed, got %v", err)
	}

	stats := logger.GetStats()
	if stats.FlushCount == 0 || stats.LastFlush.IsZero() {
		t.Fatalf("expected stats to include flush data, got %#v", stats)
	}

	if err := logger.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if logger.IsHealthy() {
		t.Fatal("expected IsHealthy=false after Close")
	}

	// log should be a no-op when closed.
	logger.Info("ignored")
}

func TestTestLogger_Log_SanitizeNilFallback(t *testing.T) {
	t.Parallel()

	logger := NewTestLogger()
	logger.sanitize = nil

	logger.Info("ok", map[string]any{"k": "v"})
	entries := logger.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Fields["k"] != "v" {
		t.Fatalf("unexpected sanitized fields: %#v", entries[0].Fields)
	}
}

func TestTestLogger_Clone_NilReceiver_ReturnsNewLogger(t *testing.T) {
	t.Parallel()

	var nilLogger *TestLogger
	cloned := nilLogger.clone()
	if cloned == nil || cloned.core == nil {
		t.Fatal("expected clone() on nil receiver to return a usable logger")
	}

	start := time.Now()
	cloned.Info("ok")
	if len(cloned.Entries()) != 1 {
		t.Fatal("expected cloned logger to record entries")
	}
	_ = start
}
