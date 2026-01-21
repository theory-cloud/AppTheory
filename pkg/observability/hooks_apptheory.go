package observability

import "github.com/theory-cloud/apptheory/runtime"

func HooksFromLogger(logger StructuredLogger) apptheory.ObservabilityHooks {
	if logger == nil {
		return apptheory.ObservabilityHooks{}
	}

	return apptheory.ObservabilityHooks{
		Log: func(record apptheory.LogRecord) {
			fields := map[string]any{
				"event":      record.Event,
				"method":     record.Method,
				"path":       record.Path,
				"status":     record.Status,
				"error_code": record.ErrorCode,
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
