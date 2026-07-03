package apptheory

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// AppError is a legacy portable, client-safe error with a stable error code.
//
// Deprecated: return AppTheoryError from new code so status, request, trace,
// timestamp, details, and cause metadata use the canonical AppTheory error path.
type AppError struct {
	Code    string
	Message string
}

func (e *AppError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func statusForErrorCode(code string) int {
	switch code {
	case errorCodeBadRequest:
		return 400
	case errorCodeValidationFailed:
		return 422
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

func canonicalHTTPErrorFields(format HTTPErrorFormat, code, message string) (string, string) {
	if normalizeHTTPErrorFormat(format) == HTTPErrorFormatFlatLegacy {
		return code, message
	}
	switch code {
	case jsonHandlerErrorCodeEmptyBody:
		return errorCodeBadRequest, "request body is empty"
	case jsonHandlerErrorCodeInvalidJSON:
		return errorCodeBadRequest, errorMessageInvalidJSON
	default:
		return code, message
	}
}

func canonicalRuntimeErrorCode(code string) string {
	switch code {
	case jsonHandlerErrorCodeEmptyBody, jsonHandlerErrorCodeInvalidJSON:
		return errorCodeBadRequest
	default:
		return code
	}
}

func errorResponse(code, message string, headers map[string][]string) Response {
	return errorResponseWithFormat(HTTPErrorFormatNested, code, message, headers)
}

func errorResponseWithFormat(format HTTPErrorFormat, code, message string, headers map[string][]string) Response {
	headers = canonicalizeHeaders(headers)
	headers["content-type"] = []string{"application/json; charset=utf-8"}

	bodyCode, bodyMessage := canonicalHTTPErrorFields(format, code, message)
	body, err := marshalHTTPErrorBody(format, map[string]any{
		"code":    bodyCode,
		"message": bodyMessage,
	})
	if err != nil {
		body = fallbackHTTPErrorBody(format)
	}

	return Response{
		Status:   statusForErrorCode(canonicalRuntimeErrorCode(code)),
		Headers:  headers,
		Cookies:  nil,
		Body:     body,
		IsBase64: false,
	}
}

func errorResponseFromAppTheoryError(err *AppTheoryError, headers map[string][]string, requestID string) Response {
	return errorResponseFromAppTheoryErrorWithFormat(HTTPErrorFormatNested, err, headers, requestID)
}

func errorResponseFromAppTheoryErrorWithFormat(
	format HTTPErrorFormat,
	err *AppTheoryError,
	headers map[string][]string,
	requestID string,
) Response {
	headers = canonicalizeHeaders(headers)
	headers["content-type"] = []string{"application/json; charset=utf-8"}

	code := err.Code
	if code == "" {
		code = errorCodeInternal
	}
	bodyCode, bodyMessage := canonicalHTTPErrorFields(format, code, err.Message)

	status := err.StatusCode
	if status == 0 {
		status = statusForErrorCode(bodyCode)
	}

	errBody := map[string]any{
		"code":    bodyCode,
		"message": bodyMessage,
	}
	if normalizeHTTPErrorFormat(format) == HTTPErrorFormatNested && err.StatusCode != 0 {
		errBody["status_code"] = err.StatusCode
	}
	if len(err.Details) > 0 {
		errBody["details"] = err.Details
	}
	if normalizeHTTPErrorFormat(format) == HTTPErrorFormatNested {
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
	}

	body, jsonErr := marshalHTTPErrorBody(format, errBody)
	if jsonErr != nil {
		body = fallbackHTTPErrorBody(format)
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
	return errorResponseWithRequestIDAndFormat(HTTPErrorFormatNested, code, message, headers, requestID)
}

func errorResponseWithRequestIDAndFormat(
	format HTTPErrorFormat,
	code, message string,
	headers map[string][]string,
	requestID string,
) Response {
	headers = canonicalizeHeaders(headers)
	headers["content-type"] = []string{"application/json; charset=utf-8"}

	bodyCode, bodyMessage := canonicalHTTPErrorFields(format, code, message)
	errBody := map[string]any{
		"code":    bodyCode,
		"message": bodyMessage,
	}
	if normalizeHTTPErrorFormat(format) == HTTPErrorFormatNested && requestID != "" {
		errBody["request_id"] = requestID
	}
	body, err := marshalHTTPErrorBody(format, errBody)
	if err != nil {
		body = fallbackHTTPErrorBody(format)
	}

	return Response{
		Status:   statusForErrorCode(canonicalRuntimeErrorCode(code)),
		Headers:  headers,
		Cookies:  nil,
		Body:     body,
		IsBase64: false,
	}
}

func responseForError(err error) Response {
	return responseForErrorWithFormat(HTTPErrorFormatNested, err)
}

func responseForErrorWithFormat(format HTTPErrorFormat, err error) Response {
	var portableErr *AppTheoryError
	if errors.As(err, &portableErr) {
		return errorResponseFromAppTheoryErrorWithFormat(format, portableErr, nil, "")
	}
	var appErr *AppError
	if errors.As(err, &appErr) {
		return errorResponseWithFormat(format, appErr.Code, appErr.Message, nil)
	}
	return errorResponseWithFormat(format, errorCodeInternal, errorMessageInternal, nil)
}

func responseForErrorWithRequestID(err error, requestID string) Response {
	return responseForErrorWithRequestIDAndFormat(HTTPErrorFormatNested, err, requestID)
}

func responseForErrorWithRequestIDAndFormat(format HTTPErrorFormat, err error, requestID string) Response {
	var portableErr *AppTheoryError
	if errors.As(err, &portableErr) {
		return errorResponseFromAppTheoryErrorWithFormat(format, portableErr, nil, requestID)
	}
	var appErr *AppError
	if errors.As(err, &appErr) {
		return errorResponseWithRequestIDAndFormat(format, appErr.Code, appErr.Message, nil, requestID)
	}
	return errorResponseWithRequestIDAndFormat(format, errorCodeInternal, errorMessageInternal, nil, requestID)
}

func marshalHTTPErrorBody(format HTTPErrorFormat, errBody map[string]any) ([]byte, error) {
	if normalizeHTTPErrorFormat(format) == HTTPErrorFormatFlatLegacy {
		return json.Marshal(errBody)
	}
	return json.Marshal(map[string]any{
		"error": errBody,
	})
}

func fallbackHTTPErrorBody(format HTTPErrorFormat) []byte {
	if normalizeHTTPErrorFormat(format) == HTTPErrorFormatFlatLegacy {
		return []byte(`{"code":"app.internal","message":"internal error"}`)
	}
	return []byte(`{"error":{"code":"app.internal","message":"internal error"}}`)
}
