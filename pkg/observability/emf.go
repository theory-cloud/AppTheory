package observability

import (
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
)

const (
	defaultEMFNamespace = "AppTheory"
	defaultEMFService   = "apptheory"
)

type EMFMetricSinkOption func(*EMFMetricSink)

// EMFMetricSink writes AppTheory request metrics in the blessed CloudWatch EMF JSON-line format.
type EMFMetricSink struct {
	namespace string
	service   string
	writer    io.Writer
	clock     func() time.Time
}

// NewEMFMetricSink creates a first-party CloudWatch Embedded Metric Format sink.
func NewEMFMetricSink(options ...EMFMetricSinkOption) *EMFMetricSink {
	sink := &EMFMetricSink{
		namespace: defaultEMFNamespace,
		service:   defaultEMFService,
		writer:    os.Stdout,
		clock:     time.Now,
	}
	for _, opt := range options {
		if opt != nil {
			opt(sink)
		}
	}
	if strings.TrimSpace(sink.namespace) == "" {
		sink.namespace = defaultEMFNamespace
	}
	if strings.TrimSpace(sink.service) == "" {
		sink.service = defaultEMFService
	}
	if sink.writer == nil {
		sink.writer = io.Discard
	}
	if sink.clock == nil {
		sink.clock = time.Now
	}
	return sink
}

// WithEMFNamespace sets the CloudWatch metric namespace. Empty values restore the AppTheory default.
func WithEMFNamespace(namespace string) EMFMetricSinkOption {
	return func(sink *EMFMetricSink) {
		if sink != nil {
			sink.namespace = strings.TrimSpace(namespace)
		}
	}
}

// WithEMFService sets the service dimension value. Empty values restore the AppTheory default.
func WithEMFService(service string) EMFMetricSinkOption {
	return func(sink *EMFMetricSink) {
		if sink != nil {
			sink.service = strings.TrimSpace(service)
		}
	}
}

// WithEMFWriter sets the JSON-line writer. Nil discards output.
func WithEMFWriter(writer io.Writer) EMFMetricSinkOption {
	return func(sink *EMFMetricSink) {
		if sink != nil {
			sink.writer = writer
		}
	}
}

// WithEMFClock sets the clock used for the required EMF Timestamp.
func WithEMFClock(clock func() time.Time) EMFMetricSinkOption {
	return func(sink *EMFMetricSink) {
		if sink != nil {
			sink.clock = clock
		}
	}
}

// RecordMetric records one AppTheory request metric as one EMF JSON log line.
func (sink *EMFMetricSink) RecordMetric(record apptheory.MetricRecord) {
	if sink == nil || strings.TrimSpace(record.Name) != "apptheory.request" {
		return
	}
	line, err := sink.EncodeMetric(record)
	if err != nil {
		return
	}
	if _, writeErr := sink.writer.Write(append(line, '\n')); writeErr != nil {
		return
	}
}

// EncodeMetric returns the exact JSON log line for an AppTheory request metric.
func (sink *EMFMetricSink) EncodeMetric(record apptheory.MetricRecord) ([]byte, error) {
	if sink == nil {
		sink = NewEMFMetricSink(WithEMFWriter(io.Discard))
	}
	status := strings.TrimSpace(record.Tags["status"])
	errorCode := strings.TrimSpace(record.Tags["error_code"])
	envelope := emfRequestEnvelope{
		AWS: emfAWSMetadata{
			Timestamp: sink.clock().UTC().UnixMilli(),
			CloudWatchMetrics: []emfCloudWatchMetrics{
				{
					Namespace:  strings.TrimSpace(sink.namespace),
					Dimensions: [][]string{{"service", "method", "path", "status", "tenant_id", "error_code"}},
					Metrics: []emfMetricDefinition{
						{Name: "RequestCount", Unit: "Count"},
						{Name: "RequestDuration", Unit: "Milliseconds"},
						{Name: "RequestErrors", Unit: "Count"},
					},
				},
			},
		},
		Service:         strings.TrimSpace(sink.service),
		Method:          strings.TrimSpace(record.Tags["method"]),
		Path:            strings.TrimSpace(record.Tags["path"]),
		Status:          status,
		TenantID:        strings.TrimSpace(record.Tags["tenant_id"]),
		ErrorCode:       errorCode,
		RequestCount:    record.Value,
		RequestDuration: nonNegativeInt(record.DurationMS),
		RequestErrors:   requestErrorMetricValue(status, errorCode),
	}
	if len(envelope.AWS.CloudWatchMetrics) > 0 && envelope.AWS.CloudWatchMetrics[0].Namespace == "" {
		envelope.AWS.CloudWatchMetrics[0].Namespace = defaultEMFNamespace
	}
	if envelope.Service == "" {
		envelope.Service = defaultEMFService
	}
	return json.Marshal(envelope)
}

type emfRequestEnvelope struct {
	AWS             emfAWSMetadata `json:"_aws"`
	Service         string         `json:"service"`
	Method          string         `json:"method"`
	Path            string         `json:"path"`
	Status          string         `json:"status"`
	TenantID        string         `json:"tenant_id"`
	ErrorCode       string         `json:"error_code"`
	RequestCount    int            `json:"RequestCount"`
	RequestDuration int            `json:"RequestDuration"`
	RequestErrors   int            `json:"RequestErrors"`
}

type emfAWSMetadata struct {
	Timestamp         int64                  `json:"Timestamp"`
	CloudWatchMetrics []emfCloudWatchMetrics `json:"CloudWatchMetrics"`
}

type emfCloudWatchMetrics struct {
	Namespace  string                `json:"Namespace"`
	Dimensions [][]string            `json:"Dimensions"`
	Metrics    []emfMetricDefinition `json:"Metrics"`
}

type emfMetricDefinition struct {
	Name string `json:"Name"`
	Unit string `json:"Unit"`
}

func nonNegativeInt(value int) int {
	if value < 0 {
		return 0
	}
	return value
}

func requestErrorMetricValue(status string, errorCode string) int {
	if strings.TrimSpace(errorCode) != "" {
		return 1
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(status))
	if err == nil && parsed >= 400 {
		return 1
	}
	return 0
}
