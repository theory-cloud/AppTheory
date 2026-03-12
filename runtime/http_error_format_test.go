package apptheory

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/stretchr/testify/require"
)

func TestServe_LegacyHTTPErrorShape_UsesFlatPortableErrorBody(t *testing.T) {
	t.Parallel()

	now := time.Unix(123, 456).UTC()
	app := New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDs{id: "req_generated"}),
		WithLegacyHTTPErrorShape(),
	)
	app.Get("/portable", func(_ *Context) (*Response, error) {
		return nil, NewAppTheoryError("VALIDATION_ERROR", "bad input").
			WithStatusCode(422).
			WithDetails(map[string]any{"field": "config_type"}).
			WithTraceID("trace_1").
			WithTimestamp(now).
			WithRequestID("req_from_error")
	})

	resp := app.Serve(context.Background(), Request{
		Method:  "GET",
		Path:    "/portable",
		Headers: map[string][]string{"x-request-id": {"req_incoming"}},
	})

	require.Equal(t, 422, resp.Status)
	require.Equal(t, []string{"req_incoming"}, resp.Headers["x-request-id"])

	var body map[string]any
	require.NoError(t, json.Unmarshal(resp.Body, &body))
	require.NotContains(t, body, "error")
	require.Equal(t, "VALIDATION_ERROR", body["code"])
	require.Equal(t, "bad input", body["message"])
	require.Equal(t, map[string]any{"field": "config_type"}, body["details"])
	require.NotContains(t, body, "status_code")
	require.NotContains(t, body, "request_id")
	require.NotContains(t, body, "trace_id")
	require.NotContains(t, body, "timestamp")
}

func TestServe_LegacyHTTPErrorShape_AppliesToFrameworkErrors(t *testing.T) {
	t.Parallel()

	app := New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDs{id: "req_generated"}),
		WithLegacyHTTPErrorShape(),
	)

	resp := app.Serve(context.Background(), Request{
		Method:  "GET",
		Path:    "/missing",
		Headers: map[string][]string{"x-request-id": {"req_123"}},
	})

	require.Equal(t, 404, resp.Status)
	require.Equal(t, []string{"req_123"}, resp.Headers["x-request-id"])

	var body map[string]any
	require.NoError(t, json.Unmarshal(resp.Body, &body))
	require.Equal(t, map[string]any{
		"code":    errorCodeNotFound,
		"message": errorMessageNotFound,
	}, body)
}

func TestServeAPIGatewayV2_LegacyHTTPErrorShape_AppliesToAdapterParseErrors(t *testing.T) {
	t.Parallel()

	app := New(WithLegacyHTTPErrorShape())
	out := app.ServeAPIGatewayV2(context.Background(), events.APIGatewayV2HTTPRequest{
		RawQueryString: "%zz",
	})

	require.Equal(t, 400, out.StatusCode)

	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(out.Body), &body))
	require.Equal(t, errorCodeBadRequest, body["code"])
	require.Equal(t, errorMessageInvalidQueryString, body["message"])
	require.NotContains(t, body, "error")
}
