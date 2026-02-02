package apptheory

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// AppError is a portable, client-safe error with a stable error code.
type AppError struct {
	Code    string
	Message string
}

func (e *AppError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func statusForErrorCode(code string) int {
	switch code {
	case errorCodeBadRequest, errorCodeValidationFailed:
		return 400
	case errorCodeUnauthorized:
		return 401
	case errorCodeForbidden:
		return 403
	case errorCodeNotFound:
		return 404
	case errorCodeMethodNotAllowed:
		return 405
	case errorCodeConflict:
		return 409
	case errorCodeTooLarge:
		return 413
	case errorCodeTimeout:
		return 408
	case errorCodeRateLimited:
		return 429
	case errorCodeOverloaded:
		return 503
	case errorCodeInternal:
		return 500
	default:
		return 500
	}
}

func errorResponse(code, message string, headers map[string][]string) Response {
	headers = canonicalizeHeaders(headers)
	headers["content-type"] = []string{"application/json; charset=utf-8"}

	body, err := json.Marshal(map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
	if err != nil {
		body = []byte(`{"error":{"code":"app.internal","message":"internal error"}}`)
	}

	return Response{
		Status:   statusForErrorCode(code),
		Headers:  headers,
		Cookies:  nil,
		Body:     body,
		IsBase64: false,
	}
}

func errorResponseFromAppTheoryError(err *AppTheoryError, headers map[string][]string, requestID string) Response {
	headers = canonicalizeHeaders(headers)
	headers["content-type"] = []string{"application/json; charset=utf-8"}

	code := err.Code
	if code == "" {
		code = errorCodeInternal
	}

	status := err.StatusCode
	if status == 0 {
		status = statusForErrorCode(code)
	}

	errBody := map[string]any{
		"code":    code,
		"message": err.Message,
	}
	if err.StatusCode != 0 {
		errBody["status_code"] = err.StatusCode
	}
	if len(err.Details) > 0 {
		errBody["details"] = err.Details
	}
	if err.RequestID != "" {
		errBody["request_id"] = err.RequestID
	} else if requestID != "" {
		errBody["request_id"] = requestID
	}
	if err.TraceID != "" {
		errBody["trace_id"] = err.TraceID
	}
	if !err.Timestamp.IsZero() {
		errBody["timestamp"] = err.Timestamp.UTC().Format(time.RFC3339Nano)
	}
	if err.StackTrace != "" {
		errBody["stack_trace"] = err.StackTrace
	}

	body, jsonErr := json.Marshal(map[string]any{
		"error": errBody,
	})
	if jsonErr != nil {
		body = []byte(`{"error":{"code":"app.internal","message":"internal error"}}`)
	}

	return Response{
		Status:   status,
		Headers:  headers,
		Cookies:  nil,
		Body:     body,
		IsBase64: false,
	}
}

func errorResponseWithRequestID(code, message string, headers map[string][]string, requestID string) Response {
	headers = canonicalizeHeaders(headers)
	headers["content-type"] = []string{"application/json; charset=utf-8"}

	errBody := map[string]any{
		"code":    code,
		"message": message,
	}
	if requestID != "" {
		errBody["request_id"] = requestID
	}
	body, err := json.Marshal(map[string]any{
		"error": errBody,
	})
	if err != nil {
		body = []byte(`{"error":{"code":"app.internal","message":"internal error"}}`)
	}

	return Response{
		Status:   statusForErrorCode(code),
		Headers:  headers,
		Cookies:  nil,
		Body:     body,
		IsBase64: false,
	}
}

func responseForError(err error) Response {
	var portableErr *AppTheoryError
	if errors.As(err, &portableErr) {
		return errorResponseFromAppTheoryError(portableErr, nil, "")
	}
	var appErr *AppError
	if errors.As(err, &appErr) {
		return errorResponse(appErr.Code, appErr.Message, nil)
	}
	return errorResponse(errorCodeInternal, errorMessageInternal, nil)
}

func responseForErrorWithRequestID(err error, requestID string) Response {
	var portableErr *AppTheoryError
	if errors.As(err, &portableErr) {
		return errorResponseFromAppTheoryError(portableErr, nil, requestID)
	}
	var appErr *AppError
	if errors.As(err, &appErr) {
		return errorResponseWithRequestID(appErr.Code, appErr.Message, nil, requestID)
	}
	return errorResponseWithRequestID(errorCodeInternal, errorMessageInternal, nil, requestID)
}
