package observability

import apptheory "github.com/theory-cloud/apptheory/v2/runtime"

func HooksFromLogger(logger StructuredLogger) apptheory.ObservabilityHooks {
	if logger == nil {
		return apptheory.ObservabilityHooks{}
	}

	return apptheory.ObservabilityHooks{
		Log: func(record apptheory.LogRecord) {
			fields := map[string]any{
				"event":       record.Event,
				"method":      record.Method,
				"path":        record.Path,
				"status":      record.Status,
				"error_code":  record.ErrorCode,
				"duration_ms": record.DurationMS,
			}

			scoped := logger.
				WithRequestID(record.RequestID).
				WithTenantID(record.TenantID)

			switch record.Level {
			case "error":
				scoped.Error(record.Event, fields)
			case "warn":
				scoped.Warn(record.Event, fields)
			case "debug":
				scoped.Debug(record.Event, fields)
			default:
				scoped.Info(record.Event, fields)
			}
		},
	}
}

// HooksFromEMFMetricSink bridges AppTheory metric hooks to the first-party EMF sink.
func HooksFromEMFMetricSink(sink *EMFMetricSink) apptheory.ObservabilityHooks {
	if sink == nil {
		return apptheory.ObservabilityHooks{}
	}
	return apptheory.ObservabilityHooks{
		Metric: sink.RecordMetric,
	}
}

// HooksFromLoggerAndEMFMetricSink bridges AppTheory logs to a StructuredLogger and metrics to EMF.
func HooksFromLoggerAndEMFMetricSink(logger StructuredLogger, sink *EMFMetricSink) apptheory.ObservabilityHooks {
	hooks := HooksFromLogger(logger)
	if sink != nil {
		hooks.Metric = sink.RecordMetric
	}
	return hooks
}
