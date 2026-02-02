package apptheory

import (
	"errors"
	"fmt"
	"time"
)

// AppTheoryError is a portable, client-safe error with optional metadata for observability and debugging.
type AppTheoryError struct {
	Code       string
	Message    string
	StatusCode int
	Details    map[string]any
	RequestID  string
	TraceID    string
	Timestamp  time.Time
	StackTrace string
	Cause      error
}

func NewAppTheoryError(code, message string) *AppTheoryError {
	return &AppTheoryError{Code: code, Message: message}
}

func AppTheoryErrorFromAppError(err *AppError) *AppTheoryError {
	if err == nil {
		return nil
	}
	return NewAppTheoryError(err.Code, err.Message)
}

func (e *AppTheoryError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *AppTheoryError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func AsAppTheoryError(err error) (*AppTheoryError, bool) {
	var appErr *AppTheoryError
	if errors.As(err, &appErr) {
		return appErr, true
	}
	return nil, false
}

func (e *AppTheoryError) WithDetails(details map[string]any) *AppTheoryError {
	if e == nil {
		return nil
	}
	e.Details = details
	return e
}

func (e *AppTheoryError) WithRequestID(requestID string) *AppTheoryError {
	if e == nil {
		return nil
	}
	e.RequestID = requestID
	return e
}

func (e *AppTheoryError) WithTraceID(traceID string) *AppTheoryError {
	if e == nil {
		return nil
	}
	e.TraceID = traceID
	return e
}

func (e *AppTheoryError) WithTimestamp(timestamp time.Time) *AppTheoryError {
	if e == nil {
		return nil
	}
	e.Timestamp = timestamp
	return e
}

func (e *AppTheoryError) WithStackTrace(stackTrace string) *AppTheoryError {
	if e == nil {
		return nil
	}
	e.StackTrace = stackTrace
	return e
}

func (e *AppTheoryError) WithStatusCode(statusCode int) *AppTheoryError {
	if e == nil {
		return nil
	}
	e.StatusCode = statusCode
	return e
}

func (e *AppTheoryError) WithCause(err error) *AppTheoryError {
	if e == nil {
		return nil
	}
	e.Cause = err
	return e
}
