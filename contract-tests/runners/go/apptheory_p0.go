package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory/pkg/naming"
	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/testkit"
)

func runFixtureP0(f Fixture) error {
	var app *apptheory.App
	setupErr := captureSetupError(func() error {
		app = apptheory.New(
			apptheory.WithTier(apptheory.TierP0),
			apptheory.WithHTTPErrorFormat(apptheory.HTTPErrorFormat(f.Setup.HTTPErrorFormat)),
		)
		return registerAppTheoryFixtureRoutes(app, f.Setup.Routes)
	})

	if expectsSetupError(f) {
		return compareExpectedSetupError(f, setupErr)
	}
	if setupErr != nil {
		return fmt.Errorf("setup app: %w", setupErr)
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
	case "alb":
		var event events.ALBTargetGroupRequest
		if err := json.Unmarshal(awsEvent.Event, &event); err != nil {
			return apptheory.Response{}, fmt.Errorf("parse alb event: %w", err)
		}
		out := app.ServeALB(context.Background(), event)
		return responseFromALBTargetGroup(out)
	default:
		return apptheory.Response{}, fmt.Errorf("unknown aws_event source %q", awsEvent.Source)
	}
}

func printFailureP0(f Fixture) {
	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP0),
		apptheory.WithHTTPErrorFormat(apptheory.HTTPErrorFormat(f.Setup.HTTPErrorFormat)),
	)
	if err := registerAppTheoryFixtureRoutes(app, f.Setup.Routes); err != nil {
		fmt.Fprintf(os.Stderr, "  got: <unavailable>\n")
		printExpected(f)
		return
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

func responseFromALBTargetGroup(resp events.ALBTargetGroupResponse) (apptheory.Response, error) {
	body := []byte(resp.Body)
	if resp.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(resp.Body)
		if err != nil {
			return apptheory.Response{}, fmt.Errorf("decode alb response body: %w", err)
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

	headers = canonicalizeHeaders(headers)
	cookies := append([]string(nil), headers["set-cookie"]...)
	delete(headers, "set-cookie")

	return apptheory.Response{
		Status:   resp.StatusCode,
		Headers:  headers,
		Cookies:  cookies,
		Body:     body,
		IsBase64: resp.IsBase64Encoded,
	}, nil
}

type bindQueryCountRequest struct {
	Count int `query:"count"`
}

type bindAllSourcesRequest struct {
	Name      string        `json:"name"`
	Tenant    string        `path:"tenant"`
	RequestID string        `header:"x-request-id"`
	Limit     int           `query:"limit"`
	Enabled   bool          `query:"enabled"`
	Ratio     float64       `query:"ratio"`
	Tags      []string      `query:"tag"`
	TTL       time.Duration `query:"ttl"`
}

type bindDurationEdgesRequest struct {
	Half     time.Duration `query:"half"`
	Micro    time.Duration `query:"micro"`
	Boundary time.Duration `query:"boundary"`
	Combined time.Duration `query:"combined"`
	Negative time.Duration `query:"negative"`
}

type bindNumericEdgesRequest struct {
	Count int     `query:"count"`
	Ratio float64 `query:"ratio"`
}

type bindStrictQueryOnlyRequest struct {
	Count int `query:"count"`
}

type bindStrictNestedRequest struct {
	Profile string         `json:"profile"`
	Nested  map[string]any `json:"nested"`
}

type bindBodyNameRequest struct {
	Name string `json:"name"`
}

type validateProfileRequest struct {
	Name     string `json:"name" validate:"required"`
	Age      int    `json:"age" validate:"min=18"`
	Score    int    `json:"score" validate:"max=10"`
	Nickname string `json:"nickname" validate:"min_length=2"`
	Bio      string `json:"bio" validate:"max_length=5"`
	Email    string `json:"email" validate:"pattern=^[^@]+@[^@]+\\.[^@]+$"`
	Role     string `json:"role" validate:"enum=admin|member"`
}

type validateProfileQueryRequest struct {
	Name string `json:"name" validate:"required"`
	Age  int    `query:"age" validate:"min=18"`
}

type validateWireNamesRequest struct {
	AccountID string `path:"account_id" validate:"pattern=^acct_"`
	PageSize  int    `query:"page-size" validate:"min=10"`
	Role      string `header:"x-role" validate:"enum=admin|member"`
	Name      string `json:"name" validate:"required"`
}

type validateInvalidRulesRequest struct {
	Email string `json:"email" validate:"pattern=["`
	Age   int    `json:"age" validate:"min=abc"`
	Name  string `json:"name" validate:"required=unexpected"`
	Role  string `json:"role" validate:"typo=1"`
}

type validateRequiredPresenceRequest struct {
	Count  int            `json:"count" validate:"required"`
	Active bool           `json:"active" validate:"required"`
	Name   string         `json:"name" validate:"required"`
	Tags   []string       `json:"tags" validate:"required"`
	Meta   map[string]any `json:"meta" validate:"required"`
}

func registerAppTheoryFixtureRoutes(app *apptheory.App, routes []FixtureRoute) error {
	for _, r := range routes {
		name := strings.TrimSpace(r.Handler)
		var handler apptheory.Handler
		if name != "" {
			handler = builtInAppTheoryHandler(name)
			if handler == nil {
				return fmt.Errorf("unknown handler %q", r.Handler)
			}
		}
		var opts []apptheory.RouteOption
		if r.AuthRequired {
			opts = append(opts, apptheory.RequireAuth())
		}
		app.Handle(r.Method, r.Path, handler, opts...)
	}
	return nil
}

func captureSetupError(setup func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			if recoveredErr, ok := r.(error); ok {
				err = recoveredErr
				return
			}
			err = fmt.Errorf("%v", r)
		}
	}()
	return setup()
}

func expectsSetupError(f Fixture) bool {
	return f.Expect.Error != nil && f.Expect.Response == nil && len(f.Expect.Output) == 0 && f.Input.Request == nil && f.Input.AWSEvent == nil
}

func compareExpectedSetupError(f Fixture, err error) error {
	if err == nil {
		return fmt.Errorf("expected setup error, got none")
	}
	actual := fixtureErrorFromError(err)
	expected := f.Expect.Error
	if strings.TrimSpace(expected.Code) != "" && actual.Code != strings.TrimSpace(expected.Code) {
		return fmt.Errorf("setup error code: expected %q, got %q", expected.Code, actual.Code)
	}
	if expected.StatusCode != 0 && actual.StatusCode != expected.StatusCode {
		return fmt.Errorf("setup error status_code: expected %d, got %d", expected.StatusCode, actual.StatusCode)
	}
	if expected.Message != "" && !strings.Contains(actual.Message, expected.Message) {
		return fmt.Errorf("setup error message: expected %q, got %q", expected.Message, actual.Message)
	}
	return nil
}

func fixtureErrorFromError(err error) FixtureError {
	if err == nil {
		return FixtureError{}
	}
	var appTheoryErr *apptheory.AppTheoryError
	if errors.As(err, &appTheoryErr) {
		return FixtureError{Code: strings.TrimSpace(appTheoryErr.Code), Message: appTheoryErr.Message, StatusCode: appTheoryErr.StatusCode}
	}
	//nolint:staticcheck // Setup comparison preserves legacy AppError compatibility.
	var appErr *apptheory.AppError
	if errors.As(err, &appErr) {
		return FixtureError{Code: strings.TrimSpace(appErr.Code), Message: appErr.Message}
	}
	return FixtureError{Message: err.Error()}
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
	"json_required_echo": apptheory.JSONHandler(func(_ *apptheory.Context, req map[string]any) (map[string]any, error) { //nolint:staticcheck // Fixture exercises deprecated Lift-compatible JSONHandler codes.
		return req, nil
	}),
	"bind_query_count": apptheory.BindHandler(
		apptheory.BindConfig[bindQueryCountRequest]{Query: true},
		func(_ *apptheory.Context, req bindQueryCountRequest) (map[string]any, error) {
			return map[string]any{"count": req.Count}, nil
		},
	),
	"bind_all_sources": apptheory.BindHandler(
		apptheory.BindConfig[bindAllSourcesRequest]{Body: true, Query: true, Path: true, Headers: true},
		func(_ *apptheory.Context, req bindAllSourcesRequest) (map[string]any, error) {
			return map[string]any{
				"name":       req.Name,
				"tenant":     req.Tenant,
				"request_id": req.RequestID,
				"limit":      req.Limit,
				"enabled":    req.Enabled,
				"ratio":      req.Ratio,
				"tags":       req.Tags,
				"ttl":        req.TTL.String(),
			}, nil
		},
	),
	"bind_all_sources_strict": apptheory.BindHandler(
		apptheory.BindConfig[bindAllSourcesRequest]{
			Body:       true,
			Query:      true,
			Path:       true,
			Headers:    true,
			StrictJSON: true,
		},
		func(_ *apptheory.Context, req bindAllSourcesRequest) (map[string]any, error) {
			return map[string]any{
				"name":       req.Name,
				"tenant":     req.Tenant,
				"request_id": req.RequestID,
				"limit":      req.Limit,
			}, nil
		},
	),
	"bind_duration_edges": apptheory.BindHandler(
		apptheory.BindConfig[bindDurationEdgesRequest]{Query: true},
		func(_ *apptheory.Context, req bindDurationEdgesRequest) (map[string]any, error) {
			return map[string]any{
				"half":     req.Half.String(),
				"micro":    req.Micro.String(),
				"boundary": req.Boundary.String(),
				"combined": req.Combined.String(),
				"negative": req.Negative.String(),
			}, nil
		},
	),
	"bind_numeric_edges": apptheory.BindHandler(
		apptheory.BindConfig[bindNumericEdgesRequest]{Query: true},
		func(_ *apptheory.Context, req bindNumericEdgesRequest) (map[string]any, error) {
			return map[string]any{"count": req.Count, "ratio": req.Ratio}, nil
		},
	),
	"bind_strict_query_only": apptheory.BindHandler(
		apptheory.BindConfig[bindStrictQueryOnlyRequest]{
			Body:       true,
			Query:      true,
			StrictJSON: true,
		},
		func(_ *apptheory.Context, req bindStrictQueryOnlyRequest) (map[string]any, error) {
			return map[string]any{"count": req.Count}, nil
		},
	),
	"bind_strict_nested": apptheory.BindHandler(
		apptheory.BindConfig[bindStrictNestedRequest]{
			Body:       true,
			StrictJSON: true,
		},
		func(_ *apptheory.Context, req bindStrictNestedRequest) (map[string]any, error) {
			return map[string]any{"profile_name": req.Profile}, nil
		},
	),
	"bind_body_name": apptheory.BindHandler(
		apptheory.BindConfig[bindBodyNameRequest]{Body: true},
		func(_ *apptheory.Context, req bindBodyNameRequest) (map[string]any, error) {
			return map[string]any{"name": req.Name}, nil
		},
	),
	"bind_strict_name": apptheory.BindHandler(
		apptheory.BindConfig[bindBodyNameRequest]{
			Body:       true,
			StrictJSON: true,
		},
		func(_ *apptheory.Context, req bindBodyNameRequest) (map[string]any, error) {
			return map[string]any{"name": req.Name}, nil
		},
	),
	"validate_profile": apptheory.BindHandler(
		apptheory.BindConfig[validateProfileRequest]{Body: true},
		func(_ *apptheory.Context, req validateProfileRequest) (map[string]any, error) {
			return map[string]any{
				"name":     req.Name,
				"age":      req.Age,
				"score":    req.Score,
				"nickname": req.Nickname,
				"bio":      req.Bio,
				"email":    req.Email,
				"role":     req.Role,
			}, nil
		},
	),
	"validate_profile_query": apptheory.BindHandler(
		apptheory.BindConfig[validateProfileQueryRequest]{Body: true, Query: true},
		func(_ *apptheory.Context, req validateProfileQueryRequest) (map[string]any, error) {
			return map[string]any{"name": req.Name, "age": req.Age}, nil
		},
	),
	"validate_wire_names": apptheory.BindHandler(
		apptheory.BindConfig[validateWireNamesRequest]{Body: true, Query: true, Path: true, Headers: true},
		func(_ *apptheory.Context, req validateWireNamesRequest) (map[string]any, error) {
			return map[string]any{
				"account_id": req.AccountID,
				"name":       req.Name,
				"page_size":  req.PageSize,
				"role":       req.Role,
			}, nil
		},
	),
	"validate_invalid_rules": apptheory.BindHandler(
		apptheory.BindConfig[validateInvalidRulesRequest]{Body: true},
		func(_ *apptheory.Context, req validateInvalidRulesRequest) (map[string]any, error) {
			return map[string]any{
				"age":   req.Age,
				"email": req.Email,
				"name":  req.Name,
				"role":  req.Role,
			}, nil
		},
	),
	"validate_required_presence": apptheory.BindHandler(
		apptheory.BindConfig[validateRequiredPresenceRequest]{Body: true},
		func(_ *apptheory.Context, req validateRequiredPresenceRequest) (map[string]any, error) {
			return map[string]any{
				"active": req.Active,
				"count":  req.Count,
				"meta":   req.Meta,
				"name":   req.Name,
				"tags":   req.Tags,
			}, nil
		},
	),
	"echo_appsync_context": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		appsync := ctx.AsAppSync()
		if appsync == nil {
			return apptheory.JSON(200, map[string]any{"appsync": nil})
		}
		return apptheory.JSON(200, map[string]any{
			"field_name":          appsync.FieldName,
			"parent_type_name":    appsync.ParentTypeName,
			"arguments":           appsync.Arguments,
			"identity":            appsync.Identity,
			"source":              appsync.Source,
			"variables":           appsync.Variables,
			"stash":               appsync.Stash,
			"prev":                appsync.Prev,
			"request_headers":     appsync.RequestHeaders,
			"raw_event_field":     appsync.RawEvent.Info.FieldName,
			"ctx_trigger_type":    ctx.Get("apptheory.trigger_type"),
			"ctx_field_name":      ctx.Get("apptheory.appsync.field_name"),
			"ctx_parent_type":     ctx.Get("apptheory.appsync.parent_type_name"),
			"ctx_request_headers": ctx.Get("apptheory.appsync.request_headers"),
		})
	},
	"panic": func(_ *apptheory.Context) (*apptheory.Response, error) {
		panic("boom")
	},
	"unexpected_error": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return nil, errors.New("boom")
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
		return nil, apptheory.NewAppTheoryError("app.unauthorized", "unauthorized")
	},
	"validation_failed": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return nil, apptheory.NewAppTheoryError("app.validation_failed", "validation failed")
	},
	"portable_error": func(_ *apptheory.Context) (*apptheory.Response, error) {
		err := apptheory.NewAppTheoryError("app.conflict", "conflict").
			WithStatusCode(409).
			WithDetails(map[string]any{
				"field":     "email",
				"retryable": false,
			}).
			WithTraceID("trace_456").
			WithTimestamp(time.Date(2024, time.January, 2, 3, 4, 5, 0, time.UTC)).
			WithStackTrace("stack:line")
		return nil, err
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
	"sse_heartbeat_keepalive": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type":  {"text/event-stream"},
				"cache-control": {"no-cache"},
				"connection":    {"keep-alive"},
			},
			Body:     []byte(": keep-alive\n\nid: 1\nevent: message\ndata: {\"ok\":true}\n\n"),
			IsBase64: false,
		}, nil
	},
	"sse_client_disconnect_mid_stream": func(_ *apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type":  {"text/event-stream"},
				"cache-control": {"no-cache"},
				"connection":    {"keep-alive"},
			},
			BodyStream: apptheory.StreamBytes([]byte("id: 1\nevent: message\ndata: before-disconnect\n\n")),
			IsBase64:   false,
		}, nil
	},
	"sse_late_error_after_first_byte": func(_ *apptheory.Context) (*apptheory.Response, error) {
		resp := &apptheory.Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type":  {"text/event-stream"},
				"cache-control": {"no-cache"},
				"connection":    {"keep-alive"},
			},
			Body:     nil,
			IsBase64: false,
		}
		ch := make(chan apptheory.StreamChunk, 2)
		resp.BodyStream = ch
		go func() {
			defer close(ch)
			ch <- apptheory.StreamChunk{Bytes: []byte("data: hello\n\n")}
			ch <- apptheory.StreamChunk{Err: apptheory.NewAppTheoryError("app.internal", "boom")}
		}()
		return resp, nil
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

		// Use an unbuffered channel so the first send blocks until the runtime starts
		// consuming the stream. This prevents a race where the goroutine mutates
		// headers/cookies before the response is normalized (flake in CI).
		ch := make(chan apptheory.StreamChunk)
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
			ch <- apptheory.StreamChunk{Err: apptheory.NewAppTheoryError("app.internal", "boom")}
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
	"source_provenance": func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.JSON(200, map[string]any{
			"source_ip":         ctx.SourceIP(),
			"source_provenance": ctx.SourceProvenance(),
		})
	},
	"stepfunctions_task_token_helpers": func(_ *apptheory.Context) (*apptheory.Response, error) {
		built := testkit.StepFunctionsTaskTokenEvent(testkit.StepFunctionsTaskTokenEventOptions{
			TaskToken: " tok-built ",
			Payload: map[string]any{
				"foo":       "bar",
				"taskToken": "ignored",
			},
		})

		return apptheory.JSON(200, map[string]any{
			"from_taskToken":  apptheory.StepFunctionsTaskToken(map[string]any{"taskToken": " tok-a "}),
			"from_TaskToken":  apptheory.StepFunctionsTaskToken(map[string]any{"TaskToken": " tok-b "}),
			"from_task_token": apptheory.StepFunctionsTaskToken(map[string]any{"task_token": " tok-c "}),
			"from_precedence": apptheory.StepFunctionsTaskToken(map[string]any{
				"TaskToken":  " tok-b ",
				"task_token": " tok-c ",
				"taskToken":  " tok-a ",
			}),
			"built": built,
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

func compareFixtureResponse(f Fixture, actual apptheory.Response, logs []FixtureLogRecord, metrics []FixtureMetricRecord, spans []FixtureSpanRecord, emfLogInputs ...[]string) error {
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

	emfLogs := []string(nil)
	if len(emfLogInputs) > 0 {
		emfLogs = emfLogInputs[0]
	}
	return compareFixtureSideEffects(f.Expect, logs, metrics, spans, emfLogs)
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

func compareFixtureSideEffects(expected FixtureExpect, logs []FixtureLogRecord, metrics []FixtureMetricRecord, spans []FixtureSpanRecord, emfLogInputs ...[]string) error {
	if !reflect.DeepEqual(expected.Logs, logs) {
		return fmt.Errorf("logs mismatch")
	}
	if !reflect.DeepEqual(expected.Metrics, metrics) {
		return fmt.Errorf("metrics mismatch")
	}
	if !reflect.DeepEqual(expected.Spans, spans) {
		return fmt.Errorf("spans mismatch")
	}
	if expected.EMFLogs != nil {
		emfLogs := []string(nil)
		if len(emfLogInputs) > 0 {
			emfLogs = emfLogInputs[0]
		}
		if !reflect.DeepEqual(expected.EMFLogs, emfLogs) {
			return fmt.Errorf("emf_logs mismatch")
		}
	}
	return nil
}
