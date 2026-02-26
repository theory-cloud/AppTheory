package jobs

import (
	"errors"

	"github.com/theory-cloud/apptheory/pkg/sanitization"
)

// SanitizeLogString removes control characters that could enable log forging.
func SanitizeLogString(value string) string {
	return sanitization.SanitizeLogString(value)
}

// SanitizeFields returns a sanitized copy of the provided map suitable for logging or durable storage.
//
// This is safe-by-default for known sensitive keys (PAN/SSN/password/token, etc).
func SanitizeFields(fields map[string]any) map[string]any {
	if len(fields) == 0 {
		return nil
	}

	out := make(map[string]any, len(fields))
	for k, v := range fields {
		out[k] = sanitization.SanitizeFieldValue(k, v)
	}
	return out
}

type ErrorEnvelope struct {
	Type      string         `json:"type,omitempty"`
	Code      string         `json:"code,omitempty"`
	Message   string         `json:"message"`
	Retryable bool           `json:"retryable,omitempty"`
	Fields    map[string]any `json:"fields,omitempty"`
}

func NewErrorEnvelope(message string, fields map[string]any) *ErrorEnvelope {
	message = SanitizeLogString(message)
	if message == "" {
		message = "unknown error"
	}
	return &ErrorEnvelope{
		Message: message,
		Fields:  SanitizeFields(fields),
	}
}

func ErrorEnvelopeFromError(err error, fields map[string]any) *ErrorEnvelope {
	if err == nil {
		return nil
	}
	env := NewErrorEnvelope(err.Error(), fields)

	var typed *Error
	if errors.As(err, &typed) && typed != nil {
		env.Type = string(typed.Type)
	}

	return env
}
