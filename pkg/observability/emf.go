package observability

import (
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v5/runtime"
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
//
// The CloudWatch dimension tuple is bounded to service, method, route template,
// status class, and error code. The concrete request path, raw status code, and
// any client-supplied tenant hint are deliberately excluded: they are
// attacker-influenced and would let unauthenticated requests mint unbounded
// custom metric series (and billing) for every unique value. Those concrete
// values remain available on the framework's request log and span records, which
// carry no metric-cardinality cost; an authenticated, bounded tenant identity
// could be added as a dimension later, but no such binding is invented here.
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
					Dimensions: [][]string{{"service", "method", "route", "status_class", "error_code"}},
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
		Route:           emfRouteTemplate(record.Tags["route"]),
		StatusClass:     emfStatusClass(status, record.Tags["status_class"]),
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

// emfUnmatchedRoute is the bounded route dimension value used when a metric
// carries no matched route template.
const emfUnmatchedRoute = "unmatched"

func emfRouteTemplate(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return emfUnmatchedRoute
	}
	return value
}

// emfStatusClass prefers the explicit status_class tag the runtime supplies and
// otherwise derives the finite class from the raw status tag, so a metric never
// dimensions on a raw or unknown-arbitrary code.
func emfStatusClass(statusValue string, classValue string) string {
	if class := strings.TrimSpace(classValue); class != "" {
		return class
	}
	code, err := strconv.Atoi(strings.TrimSpace(statusValue))
	if err != nil {
		return "unknown"
	}
	switch {
	case code >= 100 && code < 200:
		return "1xx"
	case code >= 200 && code < 300:
		return "2xx"
	case code >= 300 && code < 400:
		return "3xx"
	case code >= 400 && code < 500:
		return "4xx"
	case code >= 500 && code < 600:
		return "5xx"
	default:
		return "unknown"
	}
}

type emfRequestEnvelope struct {
	AWS             emfAWSMetadata `json:"_aws"`
	Service         string         `json:"service"`
	Method          string         `json:"method"`
	Route           string         `json:"route"`
	StatusClass     string         `json:"status_class"`
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
