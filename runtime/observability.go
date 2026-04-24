package apptheory

import "strconv"

const (
	logLevelInfo               = "info"
	logLevelError              = "error"
	eventTriggerEventBridge    = "eventbridge"
	eventTriggerDynamoDBStream = "dynamodb_stream"
)

type LogRecord struct {
	Level     string
	Event     string
	RequestID string
	TenantID  string
	Method    string
	Path      string
	Status    int
	ErrorCode string

	Trigger       string
	CorrelationID string
	Source        string
	DetailType    string
	TableName     string
	EventID       string
	EventName     string
}

type MetricRecord struct {
	Name  string
	Value int
	Tags  map[string]string
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

func (a *App) recordObservability(method, path, requestID, tenantID string, status int, errorCode string) {
	if a == nil {
		return
	}

	level := logLevelInfo
	if status >= 500 {
		level = logLevelError
	} else if status >= 400 {
		level = "warn"
	}

	if a.obs.Log != nil {
		a.obs.Log(LogRecord{
			Level:     level,
			Event:     "request.completed",
			RequestID: requestID,
			TenantID:  tenantID,
			Method:    method,
			Path:      path,
			Status:    status,
			ErrorCode: errorCode,
		})
	}

	if a.obs.Metric != nil {
		a.obs.Metric(MetricRecord{
			Name:  "apptheory.request",
			Value: 1,
			Tags: map[string]string{
				"method":     method,
				"path":       path,
				"status":     strconv.Itoa(status),
				"error_code": errorCode,
				"tenant_id":  tenantID,
			},
		})
	}

	if a.obs.Span != nil {
		a.obs.Span(SpanRecord{
			Name: "http " + method + " " + path,
			Attributes: map[string]string{
				"http.method":      method,
				"http.route":       path,
				"http.status_code": strconv.Itoa(status),
				"request.id":       requestID,
				"tenant.id":        tenantID,
				"error.code":       errorCode,
			},
		})
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

func (a *App) recordEventObservability(observation eventObservation, outcome string, errorCode string) {
	if a == nil {
		return
	}

	level := logLevelInfo
	if errorCode != "" || outcome == "error" {
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
