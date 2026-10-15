package apptheory

import (
	"encoding/json"
	"errors"
	"testing"
)

// statusCodeFromNestedBody returns the numeric error.status_code in a nested
// envelope body, or (-1, false) when the key is absent or not a number.
func statusCodeFromNestedBody(t *testing.T, body []byte) (int, bool) {
	t.Helper()
	var payload struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("unmarshal nested error body %q: %v", string(body), err)
	}
	raw, ok := payload.Error["status_code"]
	if !ok {
		return 0, false
	}
	number, ok := raw.(float64)
	if !ok {
		t.Fatalf("error.status_code is %T, want a number", raw)
	}
	return int(number), true
}

// TestNestedErrorEnvelopeCarriesTheStatusCodeOfTheResponseItIsSentWith pins the
// issue #1161 invariant for every renderer that can emit a nested envelope: the
// nested body always carries error.status_code, and it always equals the HTTP
// status of the response the runtime actually sends.
func TestNestedErrorEnvelopeCarriesTheStatusCodeOfTheResponseItIsSentWith(t *testing.T) {
	legacyAppError := &AppError{Code: errorCodeTooLarge, Message: errorMessageRequestTooLarge}
	unresolvedPortable := NewAppTheoryError(errorCodeNotFound, errorMessageNotFound)
	resolvedPortable := NewAppTheoryError(errorCodeForbidden, errorMessageForbidden).WithStatusCode(418)

	tests := []struct {
		name string
		resp Response
	}{
		{name: "framework not found", resp: errorResponseWithFormat(HTTPErrorFormatNested, errorCodeNotFound, errorMessageNotFound, nil)},
		{name: "framework method not allowed", resp: errorResponseWithFormat(HTTPErrorFormatNested, errorCodeMethodNotAllowed, errorMessageMethodNotAllowed, nil)},
		{name: "framework request too large", resp: errorResponseWithFormat(HTTPErrorFormatNested, errorCodeTooLarge, errorMessageRequestTooLarge, nil)},
		{name: "framework rate limited", resp: errorResponseWithFormat(HTTPErrorFormatNested, errorCodeRateLimited, "rate limited", nil)},
		{name: "framework overloaded", resp: errorResponseWithFormat(HTTPErrorFormatNested, errorCodeOverloaded, "overloaded", nil)},
		{name: "framework internal", resp: errorResponseWithFormat(HTTPErrorFormatNested, errorCodeInternal, errorMessageInternal, nil)},
		{name: "framework internal alias", resp: errorResponseWithFormat(HTTPErrorFormatNested, "EMPTY_BODY", "request body is empty", nil)},
		{name: "request id trace id", resp: errorResponseWithRequestIDTraceIDAndFormat(HTTPErrorFormatNested, errorCodeInternal, errorMessageInternal, nil, "req_1", "trace_1")},
		{name: "portable error without status", resp: errorResponseFromAppTheoryErrorWithFormat(HTTPErrorFormatNested, unresolvedPortable, nil, "")},
		{name: "portable error with status", resp: errorResponseFromAppTheoryErrorWithFormat(HTTPErrorFormatNested, resolvedPortable, nil, "")},
		{name: "legacy AppError", resp: responseForErrorWithFormat(HTTPErrorFormatNested, legacyAppError)},
		{name: "unknown error", resp: responseForErrorWithFormat(HTTPErrorFormatNested, errors.New("boom"))},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			status, ok := statusCodeFromNestedBody(t, tc.resp.Body)
			if !ok {
				t.Fatalf("nested body %q has no error.status_code", string(tc.resp.Body))
			}
			if status != tc.resp.Status {
				t.Fatalf("error.status_code = %d, response status = %d (body %q)", status, tc.resp.Status, string(tc.resp.Body))
			}
		})
	}
}

// TestNestedErrorFallbackBodyCarriesStatusCode pins the marshal-failure fallback:
// the nested fallback body is still the AppTheory envelope, so it carries the 500
// it is sent with.
func TestNestedErrorFallbackBodyCarriesStatusCode(t *testing.T) {
	body := fallbackHTTPErrorBody(HTTPErrorFormatNested)
	status, ok := statusCodeFromNestedBody(t, body)
	if !ok {
		t.Fatalf("fallback nested body %q has no error.status_code", string(body))
	}
	if status != 500 {
		t.Fatalf("fallback nested body status_code = %d, want 500", status)
	}
}

// TestFlatLegacyErrorEnvelopeOmitsStatusCode pins the additive boundary: the
// flat-legacy format is byte-identical to before, so it carries no status_code.
func TestFlatLegacyErrorEnvelopeOmitsStatusCode(t *testing.T) {
	responses := []Response{
		errorResponseWithFormat(HTTPErrorFormatFlatLegacy, errorCodeNotFound, errorMessageNotFound, nil),
		errorResponseWithRequestIDTraceIDAndFormat(HTTPErrorFormatFlatLegacy, errorCodeInternal, errorMessageInternal, nil, "req_1", "trace_1"),
		errorResponseFromAppTheoryErrorWithFormat(
			HTTPErrorFormatFlatLegacy,
			NewAppTheoryError(errorCodeForbidden, errorMessageForbidden).WithStatusCode(418),
			nil,
			"",
		),
	}

	for _, resp := range responses {
		var payload map[string]any
		if err := json.Unmarshal(resp.Body, &payload); err != nil {
			t.Fatalf("unmarshal flat-legacy body %q: %v", string(resp.Body), err)
		}
		if _, ok := payload["error"]; ok {
			t.Fatalf("flat-legacy body %q must not be nested", string(resp.Body))
		}
		if _, ok := payload["status_code"]; ok {
			t.Fatalf("flat-legacy body %q must not carry status_code", string(resp.Body))
		}
	}
}
