package observability

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/theory-cloud/apptheory/pkg/sanitization"
)

type testLoggerCore struct {
	mu      sync.Mutex
	entries []LogEntry

	entriesLogged  atomic.Int64
	flushCount     atomic.Int64
	lastFlushNanos atomic.Int64
	lastError      atomic.Value
}

// TestLogger is an in-memory logger implementation for deterministic unit tests.
//
// Derived loggers (via With* calls) share the same underlying core.
type TestLogger struct {
	core *testLoggerCore

	fields   map[string]any
	sanitize SanitizerFunc

	requestID string
	tenantID  string
	userID    string
	traceID   string
	spanID    string

	closed atomic.Bool
}

var _ StructuredLogger = (*TestLogger)(nil)

func NewTestLogger() *TestLogger {
	core := &testLoggerCore{
		entries: nil,
	}
	core.lastError.Store("")
	return &TestLogger{
		core:      core,
		fields:    map[string]any{},
		sanitize:  sanitization.SanitizeFieldValue,
		requestID: "",
		tenantID:  "",
		userID:    "",
		traceID:   "",
		spanID:    "",
	}
}

func (l *TestLogger) Entries() []LogEntry {
	if l == nil || l.core == nil {
		return nil
	}
	l.core.mu.Lock()
	defer l.core.mu.Unlock()
	out := make([]LogEntry, len(l.core.entries))
	copy(out, l.core.entries)
	return out
}

func (l *TestLogger) Debug(message string, fields ...map[string]any) {
	l.log("debug", message, fields...)
}
func (l *TestLogger) Info(message string, fields ...map[string]any) {
	l.log("info", message, fields...)
}
func (l *TestLogger) Warn(message string, fields ...map[string]any) {
	l.log("warn", message, fields...)
}
func (l *TestLogger) Error(message string, fields ...map[string]any) {
	l.log("error", message, fields...)
}

func (l *TestLogger) WithField(key string, value any) StructuredLogger {
	return l.WithFields(map[string]any{key: value})
}

func (l *TestLogger) WithFields(fields map[string]any) StructuredLogger {
	next := l.clone()
	for k, v := range fields {
		next.fields[k] = v
	}
	return next
}

func (l *TestLogger) WithRequestID(requestID string) StructuredLogger {
	next := l.clone()
	next.requestID = requestID
	return next
}

func (l *TestLogger) WithTenantID(tenantID string) StructuredLogger {
	next := l.clone()
	next.tenantID = tenantID
	return next
}

func (l *TestLogger) WithUserID(userID string) StructuredLogger {
	next := l.clone()
	next.userID = userID
	return next
}

func (l *TestLogger) WithTraceID(traceID string) StructuredLogger {
	next := l.clone()
	next.traceID = traceID
	return next
}

func (l *TestLogger) WithSpanID(spanID string) StructuredLogger {
	next := l.clone()
	next.spanID = spanID
	return next
}

func (l *TestLogger) Flush(ctx context.Context) error {
	if l == nil || l.core == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	l.core.flushCount.Add(1)
	l.core.lastFlushNanos.Store(time.Now().UnixNano())
	return nil
}

func (l *TestLogger) Close() error {
	if l == nil {
		return nil
	}
	l.closed.Store(true)
	return nil
}

func (l *TestLogger) IsHealthy() bool {
	return l != nil && l.core != nil && !l.closed.Load()
}

func (l *TestLogger) GetStats() LoggerStats {
	if l == nil || l.core == nil {
		return LoggerStats{}
	}

	lastFlush := time.Unix(0, l.core.lastFlushNanos.Load())
	lastError, ok := l.core.lastError.Load().(string)
	if !ok {
		lastError = ""
	}
	return LoggerStats{
		LastFlush:      lastFlush,
		LastError:      lastError,
		EntriesLogged:  l.core.entriesLogged.Load(),
		EntriesDropped: 0,
		FlushCount:     l.core.flushCount.Load(),
		ErrorCount:     0,
		AverageFlush:   0,
	}
}

func (l *TestLogger) clone() *TestLogger {
	if l == nil {
		return NewTestLogger()
	}
	nextFields := make(map[string]any, len(l.fields))
	for k, v := range l.fields {
		nextFields[k] = v
	}
	return &TestLogger{
		core:      l.core,
		fields:    nextFields,
		sanitize:  l.sanitize,
		requestID: l.requestID,
		tenantID:  l.tenantID,
		userID:    l.userID,
		traceID:   l.traceID,
		spanID:    l.spanID,
	}
}

func (l *TestLogger) log(level string, message string, fields ...map[string]any) {
	if l == nil || l.core == nil {
		return
	}
	if l.closed.Load() {
		return
	}

	allFields := make(map[string]any, len(l.fields))
	for k, v := range l.fields {
		allFields[k] = v
	}
	for _, set := range fields {
		for k, v := range set {
			allFields[k] = v
		}
	}

	message = sanitization.SanitizeLogString(message)
	sanitized := make(map[string]any, len(allFields))
	for k, v := range allFields {
		if l.sanitize != nil {
			sanitized[k] = l.sanitize(k, v)
		} else {
			sanitized[k] = sanitization.SanitizeFieldValue(k, v)
		}
	}

	entry := LogEntry{
		Timestamp: time.Now(),
		Level:     level,
		Message:   message,
		Fields:    sanitized,

		RequestID: l.requestID,
		TenantID:  l.tenantID,
		UserID:    l.userID,
		TraceID:   l.traceID,
		SpanID:    l.spanID,
	}

	l.core.entriesLogged.Add(1)

	l.core.mu.Lock()
	l.core.entries = append(l.core.entries, entry)
	l.core.mu.Unlock()
}
