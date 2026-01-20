package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory"
	"github.com/theory-cloud/apptheory/pkg/naming"
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

	if f.Input.Request == nil {
		return apptheory.Response{}, fmt.Errorf("fixture missing input.request")
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

	if f.Expect.Response != nil && len(f.Expect.Response.BodyJSON) > 0 {
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
	if f.Expect.Response != nil {
		expected := *f.Expect.Response
		expected.Headers = canonicalizeHeaders(expected.Headers)
		b := marshalIndentOrPlaceholder(expected)
		fmt.Fprintf(os.Stderr, "  expected: %s\n", string(b))
	} else {
		fmt.Fprintf(os.Stderr, "  expected: <unavailable>\n")
	}

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

var builtInAppTheoryHandlers = map[string]apptheory.Handler{
	"static_pong": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(200, "pong"), nil
	},
	"sleep_50ms": func(_ *apptheory.Context) (*apptheory.Response, error) {
		time.Sleep(50 * time.Millisecond)
		return apptheory.Text(200, "done"), nil
	},
	"echo_path_params": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(200, map[string]any{
			"params": ctx.Params,
		})
	},
	"echo_request": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(200, map[string]any{
			"method":    ctx.Request.Method,
			"path":      ctx.Request.Path,
			"query":     ctx.Request.Query,
			"headers":   ctx.Request.Headers,
			"cookies":   ctx.Request.Cookies,
			"body_b64":  base64.StdEncoding.EncodeToString(ctx.Request.Body),
			"is_base64": ctx.Request.IsBase64,
		})
	},
	"parse_json_echo": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		value, err := ctx.JSONValue()
		if err != nil {
			return nil, err
		}
		return apptheory.JSON(200, value)
	},
	"panic": func(_ *apptheory.Context) (*apptheory.Response, error) {
		panic("boom")
	},
	"binary_body": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Binary(200, []byte{0x00, 0x01, 0x02}, "application/octet-stream"), nil
	},
	"echo_context": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(200, map[string]any{
			"request_id":    ctx.RequestID,
			"tenant_id":     ctx.TenantID,
			"auth_identity": ctx.AuthIdentity,
			"remaining_ms":  ctx.RemainingMS,
		})
	},
	"echo_middleware_trace": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(200, map[string]any{
			"trace": ctx.MiddlewareTrace,
		})
	},
	"echo_ctx_value_and_trace": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(200, map[string]any{
			"mw":    ctx.Get("mw"),
			"trace": ctx.MiddlewareTrace,
		})
	},
	"naming_helpers": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(200, map[string]any{
			"normalized": map[string]string{
				"prod":   naming.NormalizeStage("prod"),
				"stg":    naming.NormalizeStage("stg"),
				"custom": naming.NormalizeStage("  Foo_Bar  "),
			},
			"base":     naming.BaseName("Pay Theory", "prod", "Tenant_1"),
			"resource": naming.ResourceName("Pay Theory", "WS Api", "prod", "Tenant_1"),
		})
	},
	"unauthorized": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return nil, &apptheory.AppError{Code: "app.unauthorized", Message: "unauthorized"}
	},
	"validation_failed": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return nil, &apptheory.AppError{Code: "app.validation_failed", Message: "validation failed"}
	},
	"large_response": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(200, "12345"), nil
	},
	"sse_single_event": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.SSEResponse(200, apptheory.SSEEvent{
			ID:    "1",
			Event: "message",
			Data:  map[string]any{"ok": true},
		})
	},
	"sse_stream_three_events": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		events := make(chan apptheory.SSEEvent, 3)
		events <- apptheory.SSEEvent{ID: "1", Event: "message", Data: map[string]any{"a": 1, "b": 2}}
		events <- apptheory.SSEEvent{Event: "note", Data: "hello\nworld"}
		events <- apptheory.SSEEvent{ID: "3", Data: ""}
		close(events)
		return apptheory.SSEStreamResponse(ctx.Context(), 200, events)
	},
	"stream_mutate_headers_after_first_chunk": func(_ *apptheory.Context) (*apptheory.Response, error) {
		resp := &apptheory.Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"text/plain; charset=utf-8"},
				"x-phase":      {"before"},
			},
			Cookies:  []string{"a=b; Path=/"},
			Body:     nil,
			IsBase64: false,
		}

		ch := make(chan apptheory.StreamChunk, 2)
		resp.BodyStream = ch
		go func() {
			defer close(ch)
			ch <- apptheory.StreamChunk{Bytes: []byte("a")}
			resp.Headers["x-phase"] = []string{"after"}
			resp.Cookies = append(resp.Cookies, "c=d; Path=/")
			ch <- apptheory.StreamChunk{Bytes: []byte("b")}
		}()
		return resp, nil
	},
	"stream_error_after_first_chunk": func(_ *apptheory.Context) (*apptheory.Response, error) {
		resp := &apptheory.Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"text/plain; charset=utf-8"},
			},
			Cookies:  nil,
			Body:     nil,
			IsBase64: false,
		}

		ch := make(chan apptheory.StreamChunk, 2)
		resp.BodyStream = ch
		go func() {
			defer close(ch)
			ch <- apptheory.StreamChunk{Bytes: []byte("hello")}
			ch <- apptheory.StreamChunk{Err: &apptheory.AppError{Code: "app.internal", Message: "boom"}}
		}()
		return resp, nil
	},
	"html_basic": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.HTML(200, "<h1>Hello</h1>"), nil
	},
	"html_stream_two_chunks": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.HTMLStream(200, apptheory.StreamBytes([]byte("<h1>"), []byte("Hello</h1>"))), nil
	},
	"safe_json_for_html": func(_ *apptheory.Context) (*apptheory.Response, error) {
		out, err := apptheory.SafeJSONForHTML(map[string]any{
			"html": "</script><div>&</div><",
			"amp":  "a&b",
			"ls":   "line\u2028sep",
			"ps":   "para\u2029sep",
		})
		if err != nil {
			return nil, err
		}
		return apptheory.Text(200, out), nil
	},
	"cookies_from_set_cookie_header": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"text/plain; charset=utf-8"},
				"set-cookie":   {"a=b; Path=/", "c=d; Path=/"},
			},
			Cookies:  []string{"e=f; Path=/"},
			Body:     []byte("ok"),
			IsBase64: false,
		}, nil
	},
	"header_multivalue": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"text/plain; charset=utf-8"},
				"x-multi":      {"a", "b"},
			},
			Cookies:  nil,
			Body:     []byte("ok"),
			IsBase64: false,
		}, nil
	},
	"cache_helpers": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		tag := apptheory.ETag([]byte("hello"))
		return apptheory.JSON(200, map[string]any{
			"cache_control_ssr": apptheory.CacheControlSSR(),
			"cache_control_ssg": apptheory.CacheControlSSG(),
			"cache_control_isr": apptheory.CacheControlISR(60, 30),
			"etag":              tag,
			"if_none_match_hit": apptheory.MatchesIfNoneMatch(ctx.Request.Headers, tag),
			"vary":              apptheory.Vary([]string{"origin"}, "accept-encoding", "Origin"),
		})
	},
	"cloudfront_helpers": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(200, map[string]any{
			"origin_url": apptheory.OriginURL(ctx.Request.Headers),
			"client_ip":  apptheory.ClientIP(ctx.Request.Headers),
		})
	},
}

func builtInAppTheoryHandler(name string) apptheory.Handler {
	key := strings.TrimSpace(name)
	if key == "" {
		return nil
	}
	return builtInAppTheoryHandlers[key]
}

func compareFixtureResponse(f Fixture, actual apptheory.Response, logs []FixtureLogRecord, metrics []FixtureMetricRecord, spans []FixtureSpanRecord) error {
	if f.Expect.Response == nil {
		return fmt.Errorf("fixture missing expect.response")
	}
	expected := *f.Expect.Response

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
