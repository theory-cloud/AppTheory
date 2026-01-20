package apptheory

import (
	"encoding/json"
	"errors"
	"fmt"
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
	if headers == nil {
		headers = map[string][]string{}
	}
	headers = cloneHeaders(headers)
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

func errorResponseWithRequestID(code, message string, headers map[string][]string, requestID string) Response {
	if headers == nil {
		headers = map[string][]string{}
	}
	headers = cloneHeaders(headers)
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
	var appErr *AppError
	if errors.As(err, &appErr) {
		return errorResponse(appErr.Code, appErr.Message, nil)
	}
	return errorResponse(errorCodeInternal, errorMessageInternal, nil)
}

func responseForErrorWithRequestID(err error, requestID string) Response {
	var appErr *AppError
	if errors.As(err, &appErr) {
		return errorResponseWithRequestID(appErr.Code, appErr.Message, nil, requestID)
	}
	return errorResponseWithRequestID(errorCodeInternal, errorMessageInternal, nil, requestID)
}
