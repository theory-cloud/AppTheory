package apptheory

import "testing"

func TestRecordObservability_EmitsAllHooks(t *testing.T) {
	var gotLog *LogRecord
	var gotMetric *MetricRecord
	var gotSpan *SpanRecord

	app := New(WithObservability(ObservabilityHooks{
		Log: func(r LogRecord) {
			copy := r
			gotLog = &copy
		},
		Metric: func(r MetricRecord) {
			copy := r
			gotMetric = &copy
		},
		Span: func(r SpanRecord) {
			copy := r
			gotSpan = &copy
		},
	}))

	app.recordObservability("GET", "/x", "req_1", "tenant_1", 503, errorCodeOverloaded)

	if gotLog == nil || gotMetric == nil || gotSpan == nil {
		t.Fatalf("expected all hooks to be invoked (log=%v metric=%v span=%v)", gotLog, gotMetric, gotSpan)
	}
	if gotLog.Level != "error" {
		t.Fatalf("expected error log level for 5xx, got %q", gotLog.Level)
	}
	if gotMetric.Tags["status"] != "503" || gotMetric.Tags["tenant_id"] != "tenant_1" {
		t.Fatalf("unexpected metric tags: %v", gotMetric.Tags)
	}
	if gotSpan.Attributes["http.status_code"] != "503" || gotSpan.Attributes["error.code"] != errorCodeOverloaded {
		t.Fatalf("unexpected span attributes: %v", gotSpan.Attributes)
	}
}
