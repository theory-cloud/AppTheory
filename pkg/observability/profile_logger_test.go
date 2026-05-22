package observability

import (
	"bytes"
	"encoding/json"
	"reflect"
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
