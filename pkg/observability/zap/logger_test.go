package zap

import (
	"context"
	"sync"
	"testing"
	"time"

	ubzap "go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"

	"github.com/theory-cloud/apptheory/pkg/observability"
)

type fakeNotifier struct {
	mu      sync.Mutex
	entries []observability.LogEntry
}

func (f *fakeNotifier) Notify(_ context.Context, entry observability.LogEntry) error {
	f.mu.Lock()
	f.entries = append(f.entries, entry)
	f.mu.Unlock()
	return nil
}

func (f *fakeNotifier) Entries() []observability.LogEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]observability.LogEntry, len(f.entries))
	copy(out, f.entries)
	return out
}

func TestZapLogger_SanitizesMessageAndFields(t *testing.T) {
	core, observed := observer.New(zapcore.DebugLevel)
	base := ubzap.New(core)

	logger, err := NewZapLogger(observability.LoggerConfig{}, WithZapLogger(base))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}

	logger.Info("hello\r\nworld", map[string]any{
		"authorization": "Bearer secret",
		"user":          "bob\r\n",
	})

	entries := observed.All()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Message != "helloworld" {
		t.Fatalf("expected sanitized message, got %q", entries[0].Message)
	}
	ctx := entries[0].ContextMap()
	if ctx["authorization"] != "[REDACTED]" {
		t.Fatalf("expected authorization redacted, got %#v", ctx["authorization"])
	}
	if ctx["user"] != "bob" {
		t.Fatalf("expected user sanitized, got %#v", ctx["user"])
	}
}

func TestZapLogger_NotifierIncludesBaseFields(t *testing.T) {
	core, _ := observer.New(zapcore.DebugLevel)
	base := ubzap.New(core)

	notifier := &fakeNotifier{}
	logger, err := NewZapLogger(observability.LoggerConfig{BufferSize: 1, MaxRetries: 1, RetryDelay: time.Millisecond}, WithZapLogger(base), WithErrorNotifier(notifier))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}

	scoped := logger.WithFields(map[string]any{
		"api_key": "secret",
	}).WithRequestID("req-1")

	scoped.Error("boom", map[string]any{
		"operation": "charge",
	})

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := scoped.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	entries := notifier.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 notification, got %d", len(entries))
	}
	if entries[0].RequestID != "req-1" {
		t.Fatalf("expected request id, got %q", entries[0].RequestID)
	}
	if entries[0].Fields["api_key"] != "[REDACTED]" {
		t.Fatalf("expected api_key redacted, got %#v", entries[0].Fields["api_key"])
	}
	if entries[0].Fields["operation"] != "charge" {
		t.Fatalf("expected operation preserved, got %#v", entries[0].Fields["operation"])
	}
}
