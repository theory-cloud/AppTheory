package apptheory

import (
	"strconv"
	"strings"
	"time"
)

const (
	logLevelInfo               = "info"
	logLevelError              = "error"
	eventTriggerEventBridge    = "eventbridge"
	eventTriggerDynamoDBStream = "dynamodb_stream"
)

type LogRecord struct {
	Level      string
	Event      string
	RequestID  string
	TraceID    string
	TenantID   string
	Method     string
	Path       string
	Status     int
	ErrorCode  string
	DurationMS int

	Trigger       string
	CorrelationID string
	Source        string
	DetailType    string
	TableName     string
	EventID       string
	EventName     string
}

type MetricRecord struct {
	Name       string
	Value      int
	DurationMS int
	Tags       map[string]string
}

type SpanRecord struct {
	Name       string
	Attributes map[string]string
}

type ObservabilityHooks struct {
	Log    func(LogRecord)
	Metric func(MetricRecord)
	Span   func(SpanRecord)
}

// unmatchedRouteTemplate is the bounded route label recorded for a request that
// did not match a registered route template (an unknown path, a method mismatch,
// an adapter decode failure). It keeps the metric route dimension finite even
// though the concrete request path is attacker-controlled.
const unmatchedRouteTemplate = "unmatched"

func (a *App) recordObservability(method, path, route, requestID, traceID, tenantID string, status int, errorCode string, durationMS int) {
	if a == nil {
		return
	}
	if durationMS < 0 {
		durationMS = 0
	}

	level := logLevelInfo
	if status >= 500 {
		level = logLevelError
	} else if status >= 400 {
		level = "warn"
	}

	if a.obs.Log != nil {
		a.obs.Log(LogRecord{
			Level:      level,
			Event:      "request.completed",
			RequestID:  requestID,
			TraceID:    traceID,
			TenantID:   tenantID,
			Method:     method,
			Path:       path,
			Status:     status,
			ErrorCode:  errorCode,
			DurationMS: durationMS,
		})
	}

	if a.obs.Metric != nil {
		a.obs.Metric(MetricRecord{
			Name:       "apptheory.request",
			Value:      1,
			DurationMS: durationMS,
			Tags: map[string]string{
				"method": method,
				"path":   path,
				// route and status_class are the bounded metric dimensions: the
				// concrete path and raw status stay available on the log and
				// span records, while a first-party metric sink dimensions only
				// on these finite values so attacker-selected paths (or tenant
				// hints) cannot mint unbounded CloudWatch metric series.
				"route":        routeTemplateOrUnmatched(route),
				"status":       strconv.Itoa(status),
				"status_class": statusClass(status),
				"error_code":   errorCode,
				"tenant_id":    tenantID,
			},
		})
	}

	if a.obs.Span != nil {
		attrs := map[string]string{
			"http.method":      method,
			"http.route":       path,
			"http.status_code": strconv.Itoa(status),
			"request.id":       requestID,
			"tenant.id":        tenantID,
			"error.code":       errorCode,
		}
		if traceID = strings.TrimSpace(traceID); traceID != "" {
			attrs["trace.id"] = traceID
		}
		a.obs.Span(SpanRecord{
			Name:       "http " + method + " " + path,
			Attributes: attrs,
		})
	}
}

// routeTemplateOrUnmatched returns the bounded route label for a metric: the
// matched route template when one was matched, or the unmatched sentinel.
func routeTemplateOrUnmatched(route string) string {
	route = strings.TrimSpace(route)
	if route == "" {
		return unmatchedRouteTemplate
	}
	return route
}

// statusClass maps an HTTP status code to its finite class label (1xx..5xx), so
// a metric sink dims on the class rather than the raw code.
func statusClass(status int) string {
	switch {
	case status >= 100 && status < 200:
		return "1xx"
	case status >= 200 && status < 300:
		return "2xx"
	case status >= 300 && status < 400:
		return "3xx"
	case status >= 400 && status < 500:
		return "4xx"
	case status >= 500 && status < 600:
		return "5xx"
	default:
		return "unknown"
	}
}

type eventObservation struct {
	Trigger       string
	RequestID     string
	CorrelationID string
	Source        string
	DetailType    string
	TableName     string
	EventID       string
	EventName     string
}

// recordAdapterDecodeError routes an adapter-level request decode failure
// through the observability hooks without changing admission behavior. The
// portable path records observability only after a request decodes
// successfully, so a decode failure (for example an invalid query string in an
// HTTP API v2 or Function URL event) previously produced an error response with
// no Log/Metric/Span record. The hook fires for the same P2 tier that the
// portable path observes, using the error's code and the response status.
// adapterEntryTime captures the adapter entry timestamp used to measure the
// decode-failure observability duration. It is nil-safe like the record call
// itself: a nil app yields a zero time, which durationMS reports as 0.
func adapterEntryTime(a *App) time.Time {
	if a == nil {
		return time.Time{}
	}
	return clockNow(a.clock)
}

func (a *App) recordAdapterDecodeError(startedAt time.Time, method, path string, err error, status int) {
	if a == nil || a.tier != TierP2 {
		return
	}
	a.recordObservability(method, path, unmatchedRouteTemplate, "", "", "", status, errorCodeForError(err), durationMS(startedAt, clockNow(a.clock)))
}

func (a *App) recordEventObservability(observation eventObservation, outcome string, errorCode string) {
	if a == nil {
		return
	}

	level := logLevelInfo
	if errorCode != "" || outcome == logLevelError {
		level = logLevelError
	}

	if a.obs.Log != nil {
		a.obs.Log(LogRecord{
			Level:         level,
			Event:         "event.completed",
			RequestID:     observation.RequestID,
			ErrorCode:     errorCode,
			Trigger:       observation.Trigger,
			CorrelationID: observation.CorrelationID,
			Source:        observation.Source,
			DetailType:    observation.DetailType,
			TableName:     observation.TableName,
			EventID:       observation.EventID,
			EventName:     observation.EventName,
		})
	}

	if a.obs.Metric != nil {
		a.obs.Metric(MetricRecord{
			Name:  "apptheory.event",
			Value: 1,
			Tags:  eventMetricTags(observation, outcome, errorCode),
		})
	}

	if a.obs.Span != nil {
		a.obs.Span(SpanRecord{
			Name:       eventSpanName(observation),
			Attributes: eventSpanAttributes(observation, outcome, errorCode),
		})
	}
}

func eventMetricTags(observation eventObservation, outcome string, errorCode string) map[string]string {
	tags := map[string]string{
		"correlation_id": observation.CorrelationID,
		"error_code":     errorCode,
		"outcome":        outcome,
		"trigger":        observation.Trigger,
	}
	switch observation.Trigger {
	case eventTriggerEventBridge:
		tags["detail_type"] = observation.DetailType
		tags["source"] = observation.Source
	case eventTriggerDynamoDBStream:
		tags["event_name"] = observation.EventName
		tags["table_name"] = observation.TableName
	}
	return tags
}

func eventSpanName(observation eventObservation) string {
	switch observation.Trigger {
	case eventTriggerEventBridge:
		return eventTriggerEventBridge + " " + observation.Source + " " + observation.DetailType
	case eventTriggerDynamoDBStream:
		return eventTriggerDynamoDBStream + " " + observation.TableName + " " + observation.EventName
	default:
		return observation.Trigger
	}
}

func eventSpanAttributes(observation eventObservation, outcome string, errorCode string) map[string]string {
	attrs := map[string]string{
		"correlation.id": observation.CorrelationID,
		"error.code":     errorCode,
		"outcome":        outcome,
		"trigger":        observation.Trigger,
	}
	switch observation.Trigger {
	case eventTriggerEventBridge:
		attrs["event.detail_type"] = observation.DetailType
		attrs["event.source"] = observation.Source
	case eventTriggerDynamoDBStream:
		attrs["dynamodb.event_id"] = observation.EventID
		attrs["dynamodb.event_name"] = observation.EventName
		attrs["dynamodb.table_name"] = observation.TableName
	}
	return attrs
}
