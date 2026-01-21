package observability

import (
	"context"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func TestNewNoOpLogger(t *testing.T) {
	logger := NewNoOpLogger()
	if logger == nil {
		t.Fatal("expected non-nil logger")
	}
	if !logger.IsHealthy() {
		t.Fatal("expected noop logger to be healthy")
	}
	if err := logger.Flush(context.Background()); err != nil {
		t.Fatalf("Flush returned error: %v", err)
	}
	if err := logger.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
}

func TestTestLogger_Basics(t *testing.T) {
	logger := NewTestLogger()
	if logger == nil || !logger.IsHealthy() {
		t.Fatal("expected healthy test logger")
	}

	logger2 := logger.WithRequestID("req_1").WithTenantID("tenant_1").WithField("k", "v")
	logger2.Info("hello", map[string]any{"x": "y"})

	entries := logger.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Level != "info" || entries[0].Message != "hello" {
		t.Fatalf("unexpected entry: %#v", entries[0])
	}
	if entries[0].RequestID != "req_1" || entries[0].TenantID != "tenant_1" {
		t.Fatalf("unexpected request/tenant ids: %#v", entries[0])
	}
	if entries[0].Fields["k"] == nil || entries[0].Fields["x"] == nil {
		t.Fatalf("expected fields to be present, got %#v", entries[0].Fields)
	}

	stats := logger.GetStats()
	if stats.EntriesLogged != 1 {
		t.Fatalf("expected EntriesLogged=1, got %d", stats.EntriesLogged)
	}
	if err := logger.Flush(context.Background()); err != nil {
		t.Fatalf("Flush returned error: %v", err)
	}
	stats = logger.GetStats()
	if stats.FlushCount != 1 {
		t.Fatalf("expected FlushCount=1, got %d", stats.FlushCount)
	}
	if stats.LastFlush.IsZero() {
		t.Fatal("expected LastFlush to be set")
	}

	if err := logger.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
	if logger.IsHealthy() {
		t.Fatal("expected logger to be unhealthy after close")
	}
}

func TestHooksFromLogger_MapsLevelsAndScopes(t *testing.T) {
	logger := NewTestLogger()
	hooks := HooksFromLogger(logger)
	if hooks.Log == nil {
		t.Fatal("expected hooks.Log")
	}

	hooks.Log(apptheory.LogRecord{
		Level:     "warn",
		Event:     "request.completed",
		RequestID: "req_1",
		TenantID:  "tenant_1",
		Method:    "GET",
		Path:      "/x",
		Status:    401,
		ErrorCode: "app.unauthorized",
	})

	entries := logger.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Level != "warn" || entries[0].Message != "request.completed" {
		t.Fatalf("unexpected entry: %#v", entries[0])
	}
	if entries[0].RequestID != "req_1" || entries[0].TenantID != "tenant_1" {
		t.Fatalf("unexpected scoping: %#v", entries[0])
	}
	if entries[0].Fields["status"] != "401" {
		t.Fatalf("unexpected status field: %#v", entries[0].Fields)
	}
}

func TestTestLogger_FlushHonorsContextCancel(t *testing.T) {
	logger := NewTestLogger()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := logger.Flush(ctx); err == nil {
		t.Fatal("expected error for canceled context")
	}

	// Ensure the timestamp parsing logic is stable even when no flush occurred.
	stats := logger.GetStats()
	if stats.LastFlush.After(time.Now().Add(1 * time.Minute)) {
		t.Fatalf("unexpected LastFlush: %v", stats.LastFlush)
	}
}
