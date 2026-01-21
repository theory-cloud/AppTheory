package apptheory

import "strconv"

type LogRecord struct {
	Level     string
	Event     string
	RequestID string
	TenantID  string
	Method    string
	Path      string
	Status    int
	ErrorCode string
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

	level := "info"
	if status >= 500 {
		level = "error"
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
