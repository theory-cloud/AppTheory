package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func TestEncodeLoggingProfileEvent_PayTheoryAlert(t *testing.T) {
	cfg, err := DefaultLoggingProfile(LoggingProfilePayTheoryAlertV1)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile: %v", err)
	}
	stack := "processor.go:42\nhandler.go:7"
	event := LoggingProfileEvent{
		Timestamp:         time.Unix(0, 0).UTC(),
		Level:             "error",
		Message:           "charge authorization failed",
		NormalizedMessage: "charge authorization failed",
		Request: LoggingProfileRequestContext{
			RequestID:     "req_test_123",
			TraceID:       "trace-profile-123",
			CorrelationID: "corr-profile-123",
			Route:         "POST /payments/{payment_id}/authorize",
		},
		Job: LoggingProfileJobContext{Name: "authorize-payment"},
		Error: LoggingProfileError{
			Type:       "ProcessorError",
			Code:       "processor.declined",
			Message:    "processor declined",
			StackTrace: stack,
		},
		Fields: map[string]any{
			"safe_processor": "tesouro",
			"raw_payload":    "must-not-appear",
		},
	}
	env := map[string]string{
		"SERVICE_NAME":             "payments-api",
		"STAGE":                    "live",
		"PARTNER":                  "paytheory",
		"AWS_LAMBDA_FUNCTION_NAME": "payments-live-authorize",
		"AWS_REGION":               "us-east-1",
		"SOURCE_ACCOUNT_ID":        "111122223333",
		"ACCOUNT_FAMILY":           "paytheory-live",
	}

	got, err := EncodeLoggingProfileEvent(cfg, env, event)
	if err != nil {
		t.Fatalf("EncodeLoggingProfileEvent: %v", err)
	}
	want := map[string]any{
		"ts":                 "1970-01-01T00:00:00Z",
		"level":              "ERROR",
		"message":            "charge authorization failed",
		"service":            "payments-api",
		"stage":              "live",
		"partner":            "paytheory",
		"function":           "payments-live-authorize",
		"aws_region":         "us-east-1",
		"source_account_id":  "111122223333",
		"account_family":     "paytheory-live",
		"request_id":         "req_test_123",
		"trace_id":           "trace-profile-123",
		"correlation_id":     "corr-profile-123",
		"error_type":         "ProcessorError",
		"error_code":         "processor.declined",
		"normalized_message": "charge authorization failed",
		"stack_trace":        stack,
		"stack_hash":         "sha256:d3d3dd723c56522d25492427bf8ca94b80feed197d55aa42e9bab0c1b5031bdc",
		"route":              "POST /payments/{payment_id}/authorize",
		"job_name":           "authorize-payment",
		"safe_processor":     "tesouro",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("profile log mismatch:\nexpected %#v\ngot      %#v", want, got)
	}
	if _, ok := got["raw_payload"]; ok {
		t.Fatalf("raw_payload must not be emitted: %#v", got)
	}
}

func TestEncodeLoggingProfileEvent_ProfileFieldsOwnCollisions(t *testing.T) {
	cfg, err := DefaultLoggingProfile(LoggingProfilePayTheoryAlertV1)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile: %v", err)
	}
	event := LoggingProfileEvent{
		Timestamp: time.Unix(0, 0).UTC(),
		Level:     "error",
		Message:   "profile-owned message",
		Fields: map[string]any{
			"ts":             "2099-01-01T00:00:00Z",
			"level":          "INFO",
			"message":        "override-msg",
			"service":        "override-service",
			"safe_processor": "tesouro",
		},
	}
	env := map[string]string{
		"SERVICE_NAME":             "payments-api",
		"STAGE":                    "live",
		"PARTNER":                  "paytheory",
		"AWS_LAMBDA_FUNCTION_NAME": "payments-live-authorize",
		"AWS_REGION":               "us-east-1",
	}

	got, err := EncodeLoggingProfileEvent(cfg, env, event)
	if err != nil {
		t.Fatalf("EncodeLoggingProfileEvent: %v", err)
	}
	checks := map[string]any{
		"ts":             "1970-01-01T00:00:00Z",
		"level":          "ERROR",
		"message":        "profile-owned message",
		"service":        "payments-api",
		"safe_processor": "tesouro",
	}
	for field, want := range checks {
		if got[field] != want {
			t.Fatalf("field %s: expected %#v, got %#v in %#v", field, want, got[field], got)
		}
	}
}

func TestProfileLogger_WritesJSONAndHooks(t *testing.T) {
	cfg, err := DefaultLoggingProfile(LoggingProfilePayTheoryAlertV1)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile: %v", err)
	}
	var buf bytes.Buffer
	hooks, logger, err := HooksFromProfileLogger(
		cfg,
		WithProfileWriter(&buf),
		WithProfileClock(func() time.Time { return time.Unix(0, 0).UTC() }),
		WithProfileEnvironment(map[string]string{
			"SERVICE_NAME":             "svc",
			"STAGE":                    "live",
			"PARTNER":                  "paytheory",
			"AWS_LAMBDA_FUNCTION_NAME": "fn",
			"AWS_REGION":               "us-east-1",
		}),
	)
	if err != nil {
		t.Fatalf("HooksFromProfileLogger: %v", err)
	}
	if hooks.Log == nil || logger == nil {
		t.Fatal("expected hook and logger")
	}

	hooks.Log(apptheoryLogRecordForProfileTest())

	var got map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &got); err != nil {
		t.Fatalf("parse log json %q: %v", buf.String(), err)
	}
	if got["level"] != "ERROR" || got["request_id"] != "req_1" || got["error_code"] != "app.internal" {
		t.Fatalf("unexpected hook output: %#v", got)
	}
	if logger.GetStats().LastError != "" {
		t.Fatalf("unexpected logger error: %s", logger.GetStats().LastError)
	}
}

func TestEncodeLoggingProfileEvent_MissingRequiredFails(t *testing.T) {
	cfg, err := DefaultLoggingProfile(LoggingProfilePayTheoryAlertV1)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile: %v", err)
	}
	_, err = EncodeLoggingProfileEvent(cfg, nil, LoggingProfileEvent{Level: "error", Message: "boom"})
	if err == nil || !strings.Contains(err.Error(), "service") {
		t.Fatalf("expected missing required fields error, got %v", err)
	}
}

func TestEncodeLoggingProfileEvent_TimestampContextAndLiteralEnrichmentVariants(t *testing.T) {
	cfg, err := DefaultLoggingProfile(LoggingProfileCloudWatchJSON)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile: %v", err)
	}
	cfg.Encoding.TimestampFormat = loggingProfileTimestampFormatRFC3339
	cfg.Enrichment = LoggingProfileEnrichment{
		Static: map[string]string{"service": "local-service"},
		Context: map[string]string{
			"tenant_id": "request.tenant_id",
			"user_id":   "request.user_id",
			"span_id":   "request.span_id",
			"method":    "request.method",
			"path":      "request.path",
			"status":    "request.status",
		},
	}
	cfg.RequiredFields = []string{"timestamp", "level", "message", "service"}

	got, err := EncodeLoggingProfileEvent(cfg, nil, LoggingProfileEvent{
		Timestamp: time.Date(2026, 5, 22, 12, 34, 56, 789000000, time.UTC),
		Level:     "info",
		Message:   "ok",
		Request: LoggingProfileRequestContext{
			TenantID: "tenant_test_123",
			UserID:   "user_test_123",
			SpanID:   "span_test_123",
			Method:   "POST",
			Path:     "/payments",
			Status:   201,
		},
	})
	if err != nil {
		t.Fatalf("EncodeLoggingProfileEvent: %v", err)
	}
	if got["timestamp"] != "2026-05-22T12:34:56Z" || got["service"] != "local-service" || got["status"] != "201" {
		t.Fatalf("unexpected context output: %#v", got)
	}

	nanoCfg, err := DefaultLoggingProfile(LoggingProfileCloudWatchJSON)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile: %v", err)
	}
	nanoCfg.RequiredFields = []string{"timestamp", "level", "message"}
	nano, err := EncodeLoggingProfileEvent(nanoCfg, nil, LoggingProfileEvent{
		Timestamp: time.Date(2026, 5, 22, 12, 34, 56, 789000000, time.UTC),
		Message:   "ok",
	})
	if err != nil {
		t.Fatalf("EncodeLoggingProfileEvent(nano): %v", err)
	}
	if nano["timestamp"] != "2026-05-22T12:34:56.789Z" {
		t.Fatalf("unexpected nano timestamp: %#v", nano)
	}
}

func TestProfileLogger_ContextMethodsCloseAndErrorState(t *testing.T) {
	cfg, err := DefaultLoggingProfile(LoggingProfileCloudWatchJSON)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile: %v", err)
	}
	cfg.Enrichment = LoggingProfileEnrichment{Context: map[string]string{
		"tenant_id": "request.tenant_id",
		"user_id":   "request.user_id",
		"trace_id":  "request.trace_id",
		"span_id":   "request.span_id",
	}}
	cfg.RequiredFields = []string{"timestamp", "level", "message"}
	logger, err := NewProfileLogger(
		cfg,
		WithProfileWriter(nil),
		WithProfileSanitizer(nil),
		WithProfileClock(func() time.Time { return time.Unix(0, 0).UTC() }),
	)
	if err != nil {
		t.Fatalf("NewProfileLogger: %v", err)
	}

	scoped := logger.
		WithField("safe_field", "safe").
		WithUserID("user_test_123").
		WithTraceID("trace_test_123").
		WithSpanID("span_test_123").
		WithTenantID("tenant_test_123")
	scoped.Debug("debug message", map[string]any{"status": "201"})
	entries := logger.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected one entry, got %#v", entries)
	}
	if entries[0]["level"] != "DEBUG" || entries[0]["tenant_id"] != "tenant_test_123" || entries[0]["safe_field"] != "safe" {
		t.Fatalf("unexpected logger entry: %#v", entries[0])
	}
	if !logger.IsHealthy() {
		t.Fatalf("expected healthy logger, got stats %#v", logger.GetStats())
	}
	if flushErr := logger.Flush(context.Background()); flushErr != nil {
		t.Fatalf("Flush: %v", flushErr)
	}
	if closeErr := logger.Close(); closeErr != nil {
		t.Fatalf("Close: %v", closeErr)
	}
	if logger.IsHealthy() {
		t.Fatal("expected closed logger to be unhealthy")
	}
	logger.Info("ignored after close")
	if len(logger.Entries()) != 1 {
		t.Fatalf("closed logger should not append entries: %#v", logger.Entries())
	}

	broken, err := NewProfileLogger(
		mustProfile(t, LoggingProfilePayTheoryAlertV1),
		WithProfileWriter(nil),
		WithProfileClock(func() time.Time { return time.Unix(0, 0).UTC() }),
	)
	if err != nil {
		t.Fatalf("NewProfileLogger(broken): %v", err)
	}
	broken.Info("missing env")
	if !strings.Contains(broken.GetStats().LastError, "logging profile required fields missing") {
		t.Fatalf("expected last error, got %#v", broken.GetStats())
	}

	if hooks := HooksFromLogger(nil); hooks.Log != nil {
		t.Fatalf("nil logger hooks should be empty: %#v", hooks)
	}
}

func TestProfileLogger_RetentionIsBoundedAndSharedByScopedLoggers(t *testing.T) {
	cfg, err := DefaultLoggingProfile(LoggingProfileCloudWatchJSON)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile: %v", err)
	}
	cfg.Enrichment = LoggingProfileEnrichment{Context: map[string]string{
		"request_id": "request.request_id",
	}}
	cfg.RequiredFields = []string{"timestamp", "level", "message"}

	var buf bytes.Buffer
	logger, err := NewProfileLogger(
		cfg,
		WithProfileWriter(&buf),
		WithProfileClock(func() time.Time { return time.Unix(0, 0).UTC() }),
	)
	if err != nil {
		t.Fatalf("NewProfileLogger: %v", err)
	}

	total := defaultProfileLoggerRetainedEntries + 2
	scoped := logger.WithRequestID("req_retention")
	for i := 0; i < total; i++ {
		scoped.Info("message-" + strconv.Itoa(i))
	}

	entries := logger.Entries()
	if len(entries) != defaultProfileLoggerRetainedEntries {
		t.Fatalf("expected bounded entries length %d, got %d", defaultProfileLoggerRetainedEntries, len(entries))
	}
	if entries[0]["message"] != "message-2" {
		t.Fatalf("expected oldest retained entry after eviction, got %#v", entries[0])
	}
	newestMessage := "message-" + strconv.Itoa(total-1)
	if entries[len(entries)-1]["message"] != newestMessage {
		t.Fatalf("expected newest retained entry, got %#v", entries[len(entries)-1])
	}
	if entries[0]["request_id"] != "req_retention" {
		t.Fatalf("scoped logger should share root retention with context, got %#v", entries[0])
	}

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != total {
		t.Fatalf("writer should receive all entries independent of retention, got %d lines", len(lines))
	}
	var last map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &last); err != nil {
		t.Fatalf("parse last writer line: %v", err)
	}
	if last["message"] != newestMessage {
		t.Fatalf("writer did not receive newest entry after evictions: %#v", last)
	}

	stats := logger.GetStats()
	if stats.EntriesLogged != int64(total) {
		t.Fatalf("expected EntriesLogged=%d, got %#v", total, stats)
	}
	if stats.EntriesDropped != 2 {
		t.Fatalf("expected EntriesDropped=2, got %#v", stats)
	}
}

func apptheoryLogRecordForProfileTest() apptheory.LogRecord {
	return apptheory.LogRecord{
		Level:     "error",
		Event:     "request.completed",
		RequestID: "req_1",
		Method:    "GET",
		Path:      "/boom",
		Status:    500,
		ErrorCode: "app.internal",
	}
}

func mustProfile(t *testing.T, profile string) LoggingProfileConfig {
	t.Helper()
	cfg, err := DefaultLoggingProfile(profile)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile(%s): %v", profile, err)
	}
	return cfg
}
