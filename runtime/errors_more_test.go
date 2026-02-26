package apptheory

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestErrorResponseFromAppTheoryError_IncludesPortableFields(t *testing.T) {
	t.Parallel()

	now := time.Unix(123, 456).UTC()

	err := NewAppTheoryError(errorCodeNotFound, errorMessageNotFound).
		WithDetails(map[string]any{"nested": map[string]any{"ok": true}}).
		WithRequestID("req_err").
		WithTraceID("trace_1").
		WithTimestamp(now).
		WithStackTrace("stack")

	resp := errorResponseFromAppTheoryError(err, map[string][]string{"X-Test": {"a"}}, "req_fallback")
	require.Equal(t, 404, resp.Status)
	require.Equal(t, []string{"application/json; charset=utf-8"}, resp.Headers["content-type"])
	require.Equal(t, []string{"a"}, resp.Headers["x-test"])

	var body map[string]any
	require.NoError(t, json.Unmarshal(resp.Body, &body))

	errObj, ok := body["error"].(map[string]any)
	require.True(t, ok, "expected body.error to be an object")
	require.Equal(t, errorCodeNotFound, errObj["code"])
	require.Equal(t, errorMessageNotFound, errObj["message"])
	require.Equal(t, "req_err", errObj["request_id"])
	require.Equal(t, "trace_1", errObj["trace_id"])
	require.Equal(t, "stack", errObj["stack_trace"])
	require.Equal(t, now.Format(time.RFC3339Nano), errObj["timestamp"])
	require.Equal(t, map[string]any{"nested": map[string]any{"ok": true}}, errObj["details"])
}

func TestErrorResponseFromAppTheoryError_UsesProvidedStatusAndFallbackRequestID(t *testing.T) {
	t.Parallel()

	err := NewAppTheoryError("", "no code").
		WithStatusCode(418)

	resp := errorResponseFromAppTheoryError(err, nil, "req_fallback")
	require.Equal(t, 418, resp.Status)

	var body map[string]any
	require.NoError(t, json.Unmarshal(resp.Body, &body))
	errObj, ok := body["error"].(map[string]any)
	require.True(t, ok, "expected body.error to be an object")

	// Code defaults to internal when empty.
	require.Equal(t, errorCodeInternal, errObj["code"])
	require.Equal(t, "no code", errObj["message"])
	require.Equal(t, float64(418), errObj["status_code"])
	require.Equal(t, "req_fallback", errObj["request_id"])
}

func TestErrorResponseFromAppTheoryError_FallsBackWhenMarshalFails(t *testing.T) {
	t.Parallel()

	// details contains a function -> json.Marshal should fail.
	err := NewAppTheoryError("app.test", "bad").
		WithDetails(map[string]any{"fn": func() {}})

	resp := errorResponseFromAppTheoryError(err, nil, "")
	require.Equal(t, 500, resp.Status)
	require.Contains(t, string(resp.Body), `"code":"app.internal"`)
	require.Contains(t, string(resp.Body), `"message":"internal error"`)
}

func TestResponseForErrorWithRequestID_PrefersPortableError(t *testing.T) {
	t.Parallel()

	portable := NewAppTheoryError(errorCodeForbidden, errorMessageForbidden).WithRequestID("req_1")
	out := responseForErrorWithRequestID(portable, "req_fallback")
	require.Equal(t, 403, out.Status)

	var body map[string]any
	require.NoError(t, json.Unmarshal(out.Body, &body))
	errObj, ok := body["error"].(map[string]any)
	require.True(t, ok, "expected body.error to be an object")
	require.Equal(t, "req_1", errObj["request_id"])
}

func TestResponseForErrorWithRequestID_UsesFallbackForAppErrorAndUnknown(t *testing.T) {
	t.Parallel()

	out := responseForErrorWithRequestID(&AppError{Code: errorCodeForbidden, Message: errorMessageForbidden}, "req_2")
	require.Equal(t, 403, out.Status)
	require.Contains(t, string(out.Body), `"request_id":"req_2"`)

	out = responseForErrorWithRequestID(errors.New("boom"), "req_3")
	require.Equal(t, 500, out.Status)
	require.Contains(t, string(out.Body), `"request_id":"req_3"`)
}
