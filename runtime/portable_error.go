package apptheory

import (
	"errors"
	"fmt"
	"time"
)

// AppTheoryError is the canonical AppTheory portable, client-safe error.
//
// Return AppTheoryError from framework and application code when the runtime
// should preserve status, details, request, trace, timestamp, stack, or cause
// metadata in the AppTheory error envelope.
//
// Headers carries a bounded caller-supplied response header set. The HTTP
// error renderer merges them (canonicalized) into the error response, so a
// SecureApp principal resolver can attach a WWW-Authenticate challenge to a
// 401/403 denial. The existing response vocabulary is unchanged: a nil or
// empty Headers renders byte-identical to today.
type AppTheoryError struct {
	Code       string
	Message    string
	StatusCode int
	Details    map[string]any
	RequestID  string
	TraceID    string
	Timestamp  time.Time
	StackTrace string
	Headers    map[string][]string
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

// WithHeaders sets the caller-supplied response headers rendered on the HTTP
// error response, for example a WWW-Authenticate challenge on a 401 denial.
func (e *AppTheoryError) WithHeaders(headers map[string][]string) *AppTheoryError {
	if e == nil {
		return nil
	}
	e.Headers = headers
	return e
}

func (e *AppTheoryError) WithCause(err error) *AppTheoryError {
	if e == nil {
		return nil
	}
	e.Cause = err
	return e
}
