package observability

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
)

func TestEMFMetricSink_EncodesRequestMetric(t *testing.T) {
	var buf bytes.Buffer
	sink := NewEMFMetricSink(
		WithEMFWriter(&buf),
		WithEMFClock(func() time.Time { return time.Unix(0, 25*int64(time.Millisecond)).UTC() }),
	)

	sink.RecordMetric(apptheory.MetricRecord{
		Name:       "apptheory.request",
		Value:      1,
		DurationMS: 25,
		Tags: map[string]string{
			"method":     "GET",
			"path":       "/duration",
			"status":     "200",
			"error_code": "",
			"tenant_id":  "tenant_dur",
		},
	})

	want := `{"_aws":{"Timestamp":25,"CloudWatchMetrics":[{"Namespace":"AppTheory","Dimensions":[["service","method","path","status","tenant_id","error_code"]],"Metrics":[{"Name":"RequestCount","Unit":"Count"},{"Name":"RequestDuration","Unit":"Milliseconds"},{"Name":"RequestErrors","Unit":"Count"}]}]},"service":"apptheory","method":"GET","path":"/duration","status":"200","tenant_id":"tenant_dur","error_code":"","RequestCount":1,"RequestDuration":25,"RequestErrors":0}`
	if got := strings.TrimSpace(buf.String()); got != want {
		t.Fatalf("EMF line mismatch:\nwant %s\n got %s", want, got)
	}
}

func TestHooksFromLoggerAndEMFMetricSink_PopulatesMetricHook(t *testing.T) {
	logger := NewTestLogger()
	var buf bytes.Buffer
	sink := NewEMFMetricSink(
		WithEMFWriter(&buf),
		WithEMFClock(func() time.Time { return time.Unix(0, 13*int64(time.Millisecond)).UTC() }),
	)
	hooks := HooksFromLoggerAndEMFMetricSink(logger, sink)
	if hooks.Log == nil || hooks.Metric == nil {
		t.Fatal("expected log and metric hooks")
	}

	hooks.Log(apptheory.LogRecord{Level: "info", Event: "request.completed", RequestID: "req", TenantID: "tenant", Method: "GET", Path: "/x", Status: 200, DurationMS: 13})
	hooks.Metric(apptheory.MetricRecord{Name: "apptheory.request", Value: 1, DurationMS: 13, Tags: map[string]string{"method": "GET", "path": "/x", "status": "500", "tenant_id": "tenant", "error_code": "app.internal"}})

	if len(logger.Entries()) != 1 {
		t.Fatalf("expected one structured log entry, got %d", len(logger.Entries()))
	}
	if !strings.Contains(buf.String(), `"RequestErrors":1`) || !strings.Contains(buf.String(), `"RequestDuration":13`) {
		t.Fatalf("expected EMF metric line to include error and duration metrics, got %q", buf.String())
	}
}

func TestEMFMetricSink_OptionsDefaultsAndEdgeCases(t *testing.T) {
	var buf bytes.Buffer
	sink := NewEMFMetricSink(
		WithEMFNamespace(" Custom/Namespace "),
		WithEMFService(" custom-service "),
		WithEMFWriter(&buf),
		WithEMFClock(func() time.Time { return time.Unix(0, 7*int64(time.Millisecond)).UTC() }),
	)

	line, err := sink.EncodeMetric(apptheory.MetricRecord{
		Name:       "apptheory.request",
		Value:      1,
		DurationMS: -5,
		Tags: map[string]string{
			"method": "POST",
			"path":   "/edge",
			"status": "404",
		},
	})
	if err != nil {
		t.Fatalf("EncodeMetric returned error: %v", err)
	}
	got := string(line)
	for _, want := range []string{
		`"Namespace":"Custom/Namespace"`,
		`"service":"custom-service"`,
		`"RequestDuration":0`,
		`"RequestErrors":1`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in %s", want, got)
		}
	}

	sink.RecordMetric(apptheory.MetricRecord{Name: "ignored.metric", Value: 1})
	if buf.Len() != 0 {
		t.Fatalf("expected non-request metric to be ignored, got %q", buf.String())
	}

	defaulted := NewEMFMetricSink(
		WithEMFNamespace(" "),
		WithEMFService(" "),
		WithEMFWriter(nil),
		WithEMFClock(nil),
	)
	defaultLine, err := defaulted.EncodeMetric(apptheory.MetricRecord{
		Name: "apptheory.request",
		Tags: map[string]string{"status": "200"},
	})
	if err != nil {
		t.Fatalf("EncodeMetric with defaulted options returned error: %v", err)
	}
	if got := string(defaultLine); !strings.Contains(got, `"Namespace":"AppTheory"`) || !strings.Contains(got, `"service":"apptheory"`) {
		t.Fatalf("expected default namespace/service in %s", got)
	}

	var nilSink *EMFMetricSink
	nilSink.RecordMetric(apptheory.MetricRecord{Name: "apptheory.request"})
	nilLine, err := nilSink.EncodeMetric(apptheory.MetricRecord{Name: "apptheory.request"})
	if err != nil {
		t.Fatalf("EncodeMetric on nil sink returned error: %v", err)
	}
	if got := string(nilLine); !strings.Contains(got, `"Namespace":"AppTheory"`) {
		t.Fatalf("expected nil sink to use defaults in %s", got)
	}

	WithEMFNamespace("noop")(nil)
	WithEMFService("noop")(nil)
	WithEMFWriter(&buf)(nil)
	WithEMFClock(time.Now)(nil)

	errSink := NewEMFMetricSink(WithEMFWriter(errorWriter{}))
	errSink.RecordMetric(apptheory.MetricRecord{Name: "apptheory.request", Value: 1, Tags: map[string]string{"status": "200"}})
}

type errorWriter struct{}

func (errorWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}
