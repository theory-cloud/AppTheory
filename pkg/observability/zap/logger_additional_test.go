package zap

import (
	"context"
	"errors"
	"testing"
	"time"

	ubzap "go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"

	"github.com/theory-cloud/apptheory/pkg/observability"
)

type syncErrorWriter struct{}

func (s syncErrorWriter) Write(p []byte) (int, error) { return len(p), nil }
func (s syncErrorWriter) Sync() error                 { return errors.New("sync failed") }

func TestZapLevelParsingAndEncoderConfig(t *testing.T) {
	t.Parallel()

	level, err := parseZapLevel("warning")
	if err != nil || level != zapcore.WarnLevel {
		t.Fatalf("expected warn level, got level=%v err=%v", level, err)
	}

	level, err = parseZapLevel("error")
	if err != nil || level != zapcore.ErrorLevel {
		t.Fatalf("expected error level, got level=%v err=%v", level, err)
	}

	if _, err := parseZapLevel("nope"); err == nil {
		t.Fatal("expected error for unsupported log level")
	}

	enc := zapEncoderConfig(true)
	if enc.CallerKey == "" {
		t.Fatal("expected caller key to be set when enableCaller=true")
	}
	if enc.EncodeCaller == nil {
		t.Fatal("expected caller encoder to be set when enableCaller=true")
	}
}

func TestZapLogger_DebugWarnWithField_CloseHealthAndStats(t *testing.T) {
	t.Parallel()

	core, observed := observer.New(zapcore.DebugLevel)
	base := ubzap.New(core)

	logger, err := NewZapLogger(observability.LoggerConfig{}, WithZapLogger(base))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}

	logger.Debug("debug")
	logger.Warn("warn", map[string]any{"k": "v"})
	logger.WithField("a", "b").Info("info")

	if len(observed.All()) < 3 {
		t.Fatalf("expected >=3 log entries, got %d", len(observed.All()))
	}

	// IsHealthy and GetStats are exercised more thoroughly with a Sync failure path.
	failingCore := zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		syncErrorWriter{},
		zapcore.DebugLevel,
	)
	failing := ubzap.New(failingCore)

	l2, err := NewZapLogger(observability.LoggerConfig{}, WithZapLogger(failing))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	if err := l2.Flush(ctx); err == nil {
		t.Fatal("expected Flush to return sync error")
	}
	if l2.IsHealthy() {
		t.Fatal("expected IsHealthy=false after sync error")
	}

	stats := l2.GetStats()
	if stats.ErrorCount == 0 || stats.LastError == "" {
		t.Fatalf("expected stats to include error, got %#v", stats)
	}

	if err := l2.Close(); err == nil {
		t.Fatal("expected Close to return sync error")
	}
}

func TestZapLogger_CustomSanitizerIsUsed(t *testing.T) {
	t.Parallel()

	core, observed := observer.New(zapcore.DebugLevel)
	base := ubzap.New(core)

	logger, err := NewZapLogger(observability.LoggerConfig{}, WithZapLogger(base), WithSanitizer(func(_ string, _ any) any {
		return "masked"
	}))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}

	logger.Info("ok", map[string]any{"authorization": "Bearer secret"})
	entries := observed.All()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if got := entries[0].ContextMap()["authorization"]; got != "masked" {
		t.Fatalf("expected custom sanitizer to be used, got %#v", got)
	}
}
