package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory"
)

func runFixtureP0(f Fixture) error {
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))

	for _, r := range f.Setup.Routes {
		handler := builtInAppTheoryHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown handler %q", r.Handler)
		}
		app.Handle(r.Method, r.Path, handler)
	}

	actual, err := serveFixtureP0(app, f)
	if err != nil {
		return err
	}
	return compareFixtureResponse(f, actual, nil, nil, nil)
}

func serveFixtureP0(app *apptheory.App, f Fixture) (apptheory.Response, error) {
	if f.Input.AWSEvent != nil {
		return serveFixtureP0AWS(app, f.Input.AWSEvent)
	}

	bodyBytes, err := decodeFixtureBody(f.Input.Request.Body)
	if err != nil {
		return apptheory.Response{}, fmt.Errorf("decode request body: %w", err)
	}

	req := apptheory.Request{
		Method:   f.Input.Request.Method,
		Path:     f.Input.Request.Path,
		Query:    f.Input.Request.Query,
		Headers:  f.Input.Request.Headers,
		Body:     bodyBytes,
		IsBase64: f.Input.Request.IsBase64,
	}

	return app.Serve(context.Background(), req), nil
}

func serveFixtureP0AWS(app *apptheory.App, awsEvent *FixtureAWSEvent) (apptheory.Response, error) {
	source := strings.ToLower(strings.TrimSpace(awsEvent.Source))
	switch source {
	case "apigw_v2":
		var event events.APIGatewayV2HTTPRequest
		if err := json.Unmarshal(awsEvent.Event, &event); err != nil {
			return apptheory.Response{}, fmt.Errorf("parse apigw_v2 event: %w", err)
		}
		out := app.ServeAPIGatewayV2(context.Background(), event)
		return responseFromAPIGatewayV2(out)
	case "lambda_function_url":
		var event events.LambdaFunctionURLRequest
		if err := json.Unmarshal(awsEvent.Event, &event); err != nil {
			return apptheory.Response{}, fmt.Errorf("parse lambda_function_url event: %w", err)
		}
		out := app.ServeLambdaFunctionURL(context.Background(), event)
		return responseFromLambdaFunctionURL(out)
	default:
		return apptheory.Response{}, fmt.Errorf("unknown aws_event source %q", awsEvent.Source)
	}
}

func printFailureP0(f Fixture) {
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
	for _, r := range f.Setup.Routes {
		handler := builtInAppTheoryHandler(r.Handler)
		if handler == nil {
			fmt.Fprintf(os.Stderr, "  got: <unavailable>\n")
			printExpected(f)
			return
		}
		app.Handle(r.Method, r.Path, handler)
	}

	actual, err := serveFixtureP0(app, f)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  got: <unavailable>\n")
		printExpected(f)
		return
	}
	actual.Headers = canonicalizeHeaders(actual.Headers)

	debug := actualResponseForCompare{
		Status:   actual.Status,
		Headers:  actual.Headers,
		Cookies:  actual.Cookies,
		IsBase64: actual.IsBase64,
	}

	if len(f.Expect.Response.BodyJSON) > 0 {
		var actualJSON any
		if json.Unmarshal(actual.Body, &actualJSON) == nil {
			debug.BodyJSON = actualJSON
		} else {
			debug.Body = &FixtureBody{Encoding: "base64", Value: base64.StdEncoding.EncodeToString(actual.Body)}
		}
	} else {
		debug.Body = &FixtureBody{Encoding: "base64", Value: base64.StdEncoding.EncodeToString(actual.Body)}
	}

	b := marshalIndentOrPlaceholder(debug)
	fmt.Fprintf(os.Stderr, "  got: %s\n", string(b))

	logs := marshalIndentOrPlaceholder([]FixtureLogRecord(nil))
	metrics := marshalIndentOrPlaceholder([]FixtureMetricRecord(nil))
	spans := marshalIndentOrPlaceholder([]FixtureSpanRecord(nil))
	fmt.Fprintf(os.Stderr, "  got.logs: %s\n", string(logs))
	fmt.Fprintf(os.Stderr, "  got.metrics: %s\n", string(metrics))
	fmt.Fprintf(os.Stderr, "  got.spans: %s\n", string(spans))

	printExpected(f)
}

func printExpected(f Fixture) {
	expected := f.Expect.Response
	expected.Headers = canonicalizeHeaders(expected.Headers)
	b := marshalIndentOrPlaceholder(expected)
	fmt.Fprintf(os.Stderr, "  expected: %s\n", string(b))

	logs := marshalIndentOrPlaceholder(f.Expect.Logs)
	metrics := marshalIndentOrPlaceholder(f.Expect.Metrics)
	spans := marshalIndentOrPlaceholder(f.Expect.Spans)
	fmt.Fprintf(os.Stderr, "  expected.logs: %s\n", string(logs))
	fmt.Fprintf(os.Stderr, "  expected.metrics: %s\n", string(metrics))
	fmt.Fprintf(os.Stderr, "  expected.spans: %s\n", string(spans))
}

func responseFromAPIGatewayV2(resp events.APIGatewayV2HTTPResponse) (apptheory.Response, error) {
	body := []byte(resp.Body)
	if resp.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(resp.Body)
		if err != nil {
			return apptheory.Response{}, fmt.Errorf("decode apigw_v2 response body: %w", err)
		}
		body = decoded
	}

	headers := map[string][]string{}
	if len(resp.MultiValueHeaders) > 0 {
		for key, values := range resp.MultiValueHeaders {
			headers[key] = append([]string(nil), values...)
		}
	} else {
		for key, value := range resp.Headers {
			headers[key] = []string{value}
		}
	}

	return apptheory.Response{
		Status:   resp.StatusCode,
		Headers:  headers,
		Cookies:  append([]string(nil), resp.Cookies...),
		Body:     body,
		IsBase64: resp.IsBase64Encoded,
	}, nil
}

func responseFromLambdaFunctionURL(resp events.LambdaFunctionURLResponse) (apptheory.Response, error) {
	body := []byte(resp.Body)
	if resp.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(resp.Body)
		if err != nil {
			return apptheory.Response{}, fmt.Errorf("decode lambda_function_url response body: %w", err)
		}
		body = decoded
	}

	headers := map[string][]string{}
	for key, value := range resp.Headers {
		headers[key] = []string{value}
	}

	return apptheory.Response{
		Status:   resp.StatusCode,
		Headers:  headers,
		Cookies:  append([]string(nil), resp.Cookies...),
		Body:     body,
		IsBase64: resp.IsBase64Encoded,
	}, nil
}

func builtInAppTheoryHandler(name string) apptheory.Handler {
	switch name {
	case "static_pong":
		return func(_ *apptheory.Context) (*apptheory.Response, error) {
			return apptheory.Text(200, "pong"), nil
		}
	case "echo_path_params":
		return func(ctx *apptheory.Context) (*apptheory.Response, error) {
			return apptheory.JSON(200, map[string]any{
				"params": ctx.Params,
			})
		}
	case "echo_request":
		return func(ctx *apptheory.Context) (*apptheory.Response, error) {
			return apptheory.JSON(200, map[string]any{
				"method":    ctx.Request.Method,
				"path":      ctx.Request.Path,
				"query":     ctx.Request.Query,
				"headers":   ctx.Request.Headers,
				"cookies":   ctx.Request.Cookies,
				"body_b64":  base64.StdEncoding.EncodeToString(ctx.Request.Body),
				"is_base64": ctx.Request.IsBase64,
			})
		}
	case "parse_json_echo":
		return func(ctx *apptheory.Context) (*apptheory.Response, error) {
			value, err := ctx.JSONValue()
			if err != nil {
				return nil, err
			}
			return apptheory.JSON(200, value)
		}
	case "panic":
		return func(_ *apptheory.Context) (*apptheory.Response, error) {
			panic("boom")
		}
	case "binary_body":
		return func(_ *apptheory.Context) (*apptheory.Response, error) {
			return apptheory.Binary(200, []byte{0x00, 0x01, 0x02}, "application/octet-stream"), nil
		}
	case "echo_context":
		return func(ctx *apptheory.Context) (*apptheory.Response, error) {
			return apptheory.JSON(200, map[string]any{
				"request_id":    ctx.RequestID,
				"tenant_id":     ctx.TenantID,
				"auth_identity": ctx.AuthIdentity,
				"remaining_ms":  ctx.RemainingMS,
			})
		}
	case "echo_middleware_trace":
		return func(ctx *apptheory.Context) (*apptheory.Response, error) {
			return apptheory.JSON(200, map[string]any{
				"trace": ctx.MiddlewareTrace,
			})
		}
	case "unauthorized":
		return func(_ *apptheory.Context) (*apptheory.Response, error) {
			return nil, &apptheory.AppError{Code: "app.unauthorized", Message: "unauthorized"}
		}
	case "validation_failed":
		return func(_ *apptheory.Context) (*apptheory.Response, error) {
			return nil, &apptheory.AppError{Code: "app.validation_failed", Message: "validation failed"}
		}
	case "large_response":
		return func(_ *apptheory.Context) (*apptheory.Response, error) {
			return apptheory.Text(200, "12345"), nil
		}
	default:
		return nil
	}
}

func compareFixtureResponse(f Fixture, actual apptheory.Response, logs []FixtureLogRecord, metrics []FixtureMetricRecord, spans []FixtureSpanRecord) error {
	expected := f.Expect.Response

	expectedHeaders := canonicalizeHeaders(expected.Headers)
	actualHeaders := canonicalizeHeaders(actual.Headers)

	if err := compareFixtureResponseMeta(expected, actual, expectedHeaders, actualHeaders); err != nil {
		return err
	}

	if err := compareFixtureResponseBody(expected, actual); err != nil {
		return err
	}

	return compareFixtureSideEffects(f.Expect, logs, metrics, spans)
}

func compareFixtureResponseMeta(expected FixtureResponse, actual apptheory.Response, expectedHeaders, actualHeaders map[string][]string) error {
	if expected.Status != actual.Status {
		return fmt.Errorf("status: expected %d, got %d", expected.Status, actual.Status)
	}
	if expected.IsBase64 != actual.IsBase64 {
		return fmt.Errorf("is_base64: expected %v, got %v", expected.IsBase64, actual.IsBase64)
	}
	if !equalStringSlices(expected.Cookies, actual.Cookies) {
		return fmt.Errorf("cookies mismatch")
	}
	if !equalHeaders(expectedHeaders, actualHeaders) {
		return fmt.Errorf("headers mismatch")
	}
	return nil
}

func compareFixtureResponseBody(expected FixtureResponse, actual apptheory.Response) error {
	if len(expected.BodyJSON) > 0 {
		var expectedJSON any
		if err := json.Unmarshal(expected.BodyJSON, &expectedJSON); err != nil {
			return fmt.Errorf("parse expected body_json: %w", err)
		}
		var actualJSON any
		if err := json.Unmarshal(actual.Body, &actualJSON); err != nil {
			return fmt.Errorf("parse actual response body as json: %w", err)
		}
		if !jsonEqual(expectedJSON, actualJSON) {
			return fmt.Errorf("body_json mismatch")
		}
		return nil
	}

	var expectedBodyBytes []byte
	if expected.Body != nil {
		var err error
		expectedBodyBytes, err = decodeFixtureBody(*expected.Body)
		if err != nil {
			return fmt.Errorf("decode expected body: %w", err)
		}
	}
	if !equalBytes(expectedBodyBytes, actual.Body) {
		return fmt.Errorf("body mismatch")
	}
	return nil
}

func compareFixtureSideEffects(expected FixtureExpect, logs []FixtureLogRecord, metrics []FixtureMetricRecord, spans []FixtureSpanRecord) error {
	if !reflect.DeepEqual(expected.Logs, logs) {
		return fmt.Errorf("logs mismatch")
	}
	if !reflect.DeepEqual(expected.Metrics, metrics) {
		return fmt.Errorf("metrics mismatch")
	}
	if !reflect.DeepEqual(expected.Spans, spans) {
		return fmt.Errorf("spans mismatch")
	}
	return nil
}
