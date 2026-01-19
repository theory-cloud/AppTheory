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
	case "app.bad_request", "app.validation_failed":
		return 400
	case "app.unauthorized":
		return 401
	case "app.forbidden":
		return 403
	case "app.not_found":
		return 404
	case "app.method_not_allowed":
		return 405
	case "app.conflict":
		return 409
	case "app.too_large":
		return 413
	case "app.rate_limited":
		return 429
	case "app.overloaded":
		return 503
	case "app.internal":
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

	body, _ := json.Marshal(map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})

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
	body, _ := json.Marshal(map[string]any{
		"error": errBody,
	})

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
	return errorResponse("app.internal", "internal error", nil)
}

func responseForErrorWithRequestID(err error, requestID string) Response {
	var appErr *AppError
	if errors.As(err, &appErr) {
		return errorResponseWithRequestID(appErr.Code, appErr.Message, nil, requestID)
	}
	return errorResponseWithRequestID("app.internal", "internal error", nil, requestID)
}
