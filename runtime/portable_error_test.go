package apptheory

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestAppTheoryError_PortableHelpersAndChaining(t *testing.T) {
	t.Parallel()

	base := NewAppTheoryError("app.test", "something happened")
	require.Equal(t, "app.test", base.Code)
	require.Equal(t, "something happened", base.Message)
	require.Equal(t, "app.test: something happened", base.Error())

	// nil receivers are safe.
	var nilErr *AppTheoryError
	require.Equal(t, "", nilErr.Error())
	require.Nil(t, nilErr.Unwrap())
	require.Nil(t, nilErr.WithDetails(map[string]any{"x": 1}))
	require.Nil(t, nilErr.WithRequestID("req"))
	require.Nil(t, nilErr.WithTraceID("trace"))
	require.Nil(t, nilErr.WithTimestamp(time.Now()))
	require.Nil(t, nilErr.WithStackTrace("stack"))
	require.Nil(t, nilErr.WithStatusCode(418))
	require.Nil(t, nilErr.WithCause(errors.New("boom")))

	now := time.Unix(123, 0).UTC()
	cause := errors.New("boom")

	got := base.
		WithDetails(map[string]any{"ok": true}).
		WithRequestID("req_1").
		WithTraceID("trace_1").
		WithTimestamp(now).
		WithStackTrace("stack").
		WithStatusCode(418).
		WithCause(cause)

	require.Same(t, base, got)
	require.Equal(t, map[string]any{"ok": true}, got.Details)
	require.Equal(t, "req_1", got.RequestID)
	require.Equal(t, "trace_1", got.TraceID)
	require.Equal(t, now, got.Timestamp)
	require.Equal(t, "stack", got.StackTrace)
	require.Equal(t, 418, got.StatusCode)
	require.Same(t, cause, got.Unwrap())

	// errors.As support.
	wrapped := fmt.Errorf("wrap: %w", got)
	as, ok := AsAppTheoryError(wrapped)
	require.True(t, ok)
	require.Same(t, got, as)

	// AppTheoryErrorFromAppError should keep the stable code/message.
	require.Nil(t, AppTheoryErrorFromAppError(nil))
	fromApp := AppTheoryErrorFromAppError(&AppError{Code: "app.bad", Message: "bad"})
	require.Equal(t, "app.bad", fromApp.Code)
	require.Equal(t, "bad", fromApp.Message)
}
