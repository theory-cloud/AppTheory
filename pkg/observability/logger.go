package observability

import (
	"context"
	"time"
)

type SanitizerFunc func(key string, value any) any

type ErrorNotifier interface {
	Notify(ctx context.Context, entry LogEntry) error
}

// LogEntry represents a structured log entry.
//
// This type is intentionally small and stable so implementations can adapt it to their backend.
type LogEntry struct {
	Timestamp time.Time      `json:"timestamp"`
	Level     string         `json:"level"`
	Message   string         `json:"message"`
	Fields    map[string]any `json:"fields,omitempty"`

	RequestID string `json:"request_id,omitempty"`
	TenantID  string `json:"tenant_id,omitempty"`
	UserID    string `json:"user_id,omitempty"`
	TraceID   string `json:"trace_id,omitempty"`
	SpanID    string `json:"span_id,omitempty"`
}

// StructuredLogger is the primary Go logging surface used by Pay Theory migrations.
//
// It intentionally mirrors the Lift logger API shape (message + map fields) while allowing
// implementations to provide stronger guarantees (sanitization, health, lifecycle).
type StructuredLogger interface {
	Debug(message string, fields ...map[string]any)
	Info(message string, fields ...map[string]any)
	Warn(message string, fields ...map[string]any)
	Error(message string, fields ...map[string]any)

	WithField(key string, value any) StructuredLogger
	WithFields(fields map[string]any) StructuredLogger

	WithRequestID(requestID string) StructuredLogger
	WithTenantID(tenantID string) StructuredLogger
	WithUserID(userID string) StructuredLogger
	WithTraceID(traceID string) StructuredLogger
	WithSpanID(spanID string) StructuredLogger

	Flush(ctx context.Context) error
	Close() error
	IsHealthy() bool
	GetStats() LoggerStats
}

type LoggerStats struct {
	LastFlush      time.Time     `json:"last_flush"`
	LastError      string        `json:"last_error,omitempty"`
	EntriesLogged  int64         `json:"entries_logged"`
	EntriesDropped int64         `json:"entries_dropped"`
	FlushCount     int64         `json:"flush_count"`
	ErrorCount     int64         `json:"error_count"`
	AverageFlush   time.Duration `json:"average_flush_time"`
}

// LoggerConfig configures logger implementations.
//
// Fields are intentionally aligned with Lift’s `observability.LoggerConfig` where it matters for migrations.
type LoggerConfig struct {
	Format       string        `json:"format"`
	Level        string        `json:"level"`
	RetryDelay   time.Duration `json:"retry_delay"`
	BatchSize    int           `json:"batch_size"`
	BufferSize   int           `json:"buffer_size"`
	MaxRetries   int           `json:"max_retries"`
	EnableStack  bool          `json:"enable_stack"`
	EnableCaller bool          `json:"enable_caller"`
}

type LoggerFactory interface {
	CreateConsoleLogger(config LoggerConfig) (StructuredLogger, error)
	CreateTestLogger() StructuredLogger
	CreateNoOpLogger() StructuredLogger
}
