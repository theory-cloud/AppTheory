package apptheory

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/lambdacontext"
)

func TestWithRequestIDSource_NormalizesUnknownToDefault(t *testing.T) {
	cases := []struct {
		name  string
		input RequestIDSource
		want  RequestIDSource
	}{
		{name: "empty", input: "", want: RequestIDSourceDefault},
		{name: "default", input: RequestIDSourceDefault, want: RequestIDSourceDefault},
		{name: "server", input: RequestIDSourceServer, want: RequestIDSourceServer},
		{name: "unknown", input: "SERVER", want: RequestIDSourceDefault},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := New(WithRequestIDSource(tc.input)).requestIDSource; got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

func portableRequestWithClientRequestID(requestID string) Request {
	return Request{
		Method:  "GET",
		Path:    "/context",
		Headers: map[string][]string{"x-request-id": {requestID}},
	}
}

func TestServe_RequestIDSourceDefault_HonorsClientHeader(t *testing.T) {
	app := New(WithTier(TierP1), WithIDGenerator(fixedIDGenerator("req_server_issued")))
	app.Get("/context", func(ctx *Context) (*Response, error) {
		return JSON(200, map[string]any{"request_id": ctx.RequestID})
	})

	resp := app.Serve(context.Background(), portableRequestWithClientRequestID("req_client_supplied"))
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_client_supplied" {
		t.Fatalf("expected the client request id on the response header, got %q", got)
	}
	if !containsString(string(resp.Body), `"request_id":"req_client_supplied"`) {
		t.Fatalf("expected the client request id in the handler context, got %s", resp.Body)
	}
}

func TestServe_RequestIDSourceServerIssued_IgnoresClientHeader(t *testing.T) {
	app := New(
		WithTier(TierP1),
		WithIDGenerator(fixedIDGenerator("req_server_issued")),
		WithRequestIDSource(RequestIDSourceServer),
	)
	app.Get("/context", func(ctx *Context) (*Response, error) {
		return JSON(200, map[string]any{"request_id": ctx.RequestID})
	})

	resp := app.Serve(context.Background(), portableRequestWithClientRequestID("req_client_forged"))
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_server_issued" {
		t.Fatalf("expected the server-issued request id on the response header, got %q", got)
	}
	if !containsString(string(resp.Body), `"request_id":"req_server_issued"`) {
		t.Fatalf("expected the server-issued request id in the handler context, got %s", resp.Body)
	}
	if containsString(string(resp.Body), "req_client_forged") {
		t.Fatalf("client request id leaked into the handler context: %s", resp.Body)
	}
}

func TestServe_RequestIDSourceServerIssued_UsesFallbackRequestID(t *testing.T) {
	app := New(
		WithTier(TierP1),
		WithIDGenerator(fixedIDGenerator("req_server_issued")),
		WithRequestIDSource(RequestIDSourceServer),
	)
	var seen string
	app.Get("/context", func(ctx *Context) (*Response, error) {
		seen = ctx.RequestID
		return JSON(200, map[string]any{"request_id": ctx.RequestID})
	})

	resp := app.serveWithOptions(
		context.Background(),
		portableRequestWithClientRequestID("req_client_forged"),
		serveOptions{fallbackRequestID: "req_fallback"},
	)
	if seen != "req_fallback" {
		t.Fatalf("expected the fallback request id in the handler context, got %q", seen)
	}
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_fallback" {
		t.Fatalf("expected the fallback request id on the response header, got %q", got)
	}
}

func TestServe_RequestIDSourceServerIssued_ErrorEnvelopesUseServerIssuedID(t *testing.T) {
	app := New(
		WithTier(TierP1),
		WithIDGenerator(fixedIDGenerator("req_server_issued")),
		WithRequestIDSource(RequestIDSourceServer),
	)
	app.Get("/portable-error", func(_ *Context) (*Response, error) {
		return nil, NewAppTheoryError(errorCodeForbidden, errorMessageForbidden)
	})

	cases := []struct {
		name   string
		path   string
		status int
		code   string
	}{
		{name: "handler_error", path: "/portable-error", status: 403, code: errorCodeForbidden},
		{name: "framework_not_found", path: "/missing", status: 404, code: errorCodeNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := portableRequestWithClientRequestID("req_client_forged")
			req.Path = tc.path
			resp := app.Serve(context.Background(), req)
			if resp.Status != tc.status {
				t.Fatalf("expected status %d, got %d", tc.status, resp.Status)
			}
			if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_server_issued" {
				t.Fatalf("expected the server-issued request id on the response header, got %q", got)
			}
			var body struct {
				Error struct {
					Code      string `json:"code"`
					RequestID string `json:"request_id"`
				} `json:"error"`
			}
			if err := json.Unmarshal(resp.Body, &body); err != nil {
				t.Fatalf("parse error envelope: %v", err)
			}
			if body.Error.Code != tc.code {
				t.Fatalf("expected error code %q, got %q", tc.code, body.Error.Code)
			}
			if body.Error.RequestID != "req_server_issued" {
				t.Fatalf("expected the server-issued request id in the error envelope, got %q", body.Error.RequestID)
			}
		})
	}
}

func TestServeAppSync_RequestIDSourceServerIssued_UsesLambdaFallback(t *testing.T) {
	app := New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_server_issued")),
		WithRequestIDSource(RequestIDSourceServer),
	)
	app.Post("/createThing", func(ctx *Context) (*Response, error) {
		return JSON(200, map[string]any{"request_id": ctx.RequestID})
	})

	ctx := lambdacontext.NewContext(context.Background(), &lambdacontext.LambdaContext{AwsRequestID: "aws_req_fallback"})
	out := app.ServeAppSync(ctx, AppSyncResolverEvent{
		Info:    AppSyncResolverInfo{FieldName: "createThing", ParentTypeName: "Mutation"},
		Request: AppSyncResolverRequest{Headers: map[string]string{"x-request-id": "req_client_forged"}},
	})

	payload, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal appsync payload: %v", err)
	}
	if !containsString(string(payload), `"request_id":"aws_req_fallback"`) {
		t.Fatalf("expected the Lambda fallback request id in the appsync payload, got %s", payload)
	}
}

func TestNewSecure_RequestIDSourceServerIssued_IgnoresClientHeader(t *testing.T) {
	app := NewSecure(SecureOptions{
		Tier:            TierP1,
		IDGenerator:     fixedIDGenerator("req_server_issued"),
		RequestIDSource: RequestIDSourceServer,
	})
	var seen string
	app.Handle("GET", "/public", func(ctx *Context) (*Response, error) {
		seen = ctx.RequestID
		return JSON(200, map[string]any{"request_id": ctx.RequestID})
	}, Public())

	resp := app.Serve(context.Background(), Request{
		Method:  "GET",
		Path:    "/public",
		Headers: map[string][]string{"x-request-id": {"req_client_forged"}},
	})
	if seen != "req_server_issued" {
		t.Fatalf("expected the server-issued request id in the handler context, got %q", seen)
	}
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_server_issued" {
		t.Fatalf("expected the server-issued request id on the response header, got %q", got)
	}
}

func containsString(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}

func TestMaxClientRequestIDLength_Is128(t *testing.T) {
	if MaxClientRequestIDLength != 128 {
		t.Fatalf("expected the framework limit of 128, got %d", MaxClientRequestIDLength)
	}
}

func TestIsWellFormedClientRequestID(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "empty", value: "", want: false},
		{name: "whitespace_only", value: "  \t ", want: false},
		{name: "simple", value: "req_client_wellformed", want: true},
		{name: "edge_whitespace_trimmed", value: "  req_client_wellformed\t", want: true},
		{name: "visible_ascii_bounds", value: "!~", want: true},
		{name: "boundary_128", value: strings.Repeat("a", MaxClientRequestIDLength), want: true},
		{name: "oversize_129", value: strings.Repeat("a", MaxClientRequestIDLength+1), want: false},
		{name: "embedded_carriage_return", value: "evil\r\nx-injected: 1", want: false},
		{name: "embedded_line_feed", value: "evil\nx", want: false},
		{name: "embedded_tab", value: "a\tb", want: false},
		{name: "embedded_space", value: "has space", want: false},
		{name: "embedded_nul", value: "a\x00b", want: false},
		{name: "delete_0x7f", value: "a\x7fb", want: false},
		{name: "non_ascii", value: "caf\u00e9", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsWellFormedClientRequestID(tc.value); got != tc.want {
				t.Fatalf("IsWellFormedClientRequestID(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

func newClientRequestIDApp(source RequestIDSource, seen *string, body map[string]any) *App {
	app := New(
		WithTier(TierP1),
		WithIDGenerator(fixedIDGenerator("req_generated")),
		WithRequestIDSource(source),
	)
	app.Get("/context", func(ctx *Context) (*Response, error) {
		*seen = ctx.ClientRequestID()
		payload := map[string]any{}
		for key, value := range body {
			payload[key] = value
		}
		payload["request_id"] = ctx.RequestID
		return JSON(200, payload)
	})
	return app
}

func responseRequestID(t *testing.T, body []byte) string {
	t.Helper()
	var decoded struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("parse response body: %v", err)
	}
	return decoded.RequestID
}

func TestServe_ClientRequestID_DefaultMode_ReturnsWellFormedClientValue(t *testing.T) {
	var seen string
	app := newClientRequestIDApp(RequestIDSourceDefault, &seen, map[string]any{})
	resp := app.Serve(context.Background(), portableRequestWithClientRequestID("req_client_wellformed"))
	if seen != "req_client_wellformed" {
		t.Fatalf("expected the well-formed client value on the context, got %q", seen)
	}
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_client_wellformed" {
		t.Fatalf("expected the client request id on the response header, got %q", got)
	}
}

func TestServe_ClientRequestID_DefaultMode_TrimsEdgeWhitespace(t *testing.T) {
	var seen string
	app := newClientRequestIDApp(RequestIDSourceDefault, &seen, map[string]any{})
	resp := app.Serve(context.Background(), portableRequestWithClientRequestID("  req_client_wellformed\t"))
	if seen != "req_client_wellformed" {
		t.Fatalf("expected the trimmed client value on the context, got %q", seen)
	}
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_client_wellformed" {
		t.Fatalf("expected the trimmed client request id on the response header, got %q", got)
	}
}

func TestServe_ClientRequestID_DefaultMode_AcceptsBoundaryLength(t *testing.T) {
	boundary := strings.Repeat("a", MaxClientRequestIDLength)
	var seen string
	app := newClientRequestIDApp(RequestIDSourceDefault, &seen, map[string]any{})
	resp := app.Serve(context.Background(), portableRequestWithClientRequestID(boundary))
	if seen != boundary {
		t.Fatalf("expected the 128-character boundary value on the context, got %d characters", len(seen))
	}
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got != boundary {
		t.Fatalf("expected the 128-character boundary value on the response header, got %d characters", len(got))
	}
}

func TestServe_RequestIDSourceDefault_IgnoresMalformedClientRequestID(t *testing.T) {
	malformed := map[string]string{
		"crlf":     "evil\r\nx-injected: 1",
		"oversize": strings.Repeat("a", MaxClientRequestIDLength+1),
		"space":    "has space",
		"nonascii": "caf\u00e9",
		"tab":      "a\tb",
		"nul":      "a\x00b",
	}
	for name, value := range malformed {
		t.Run(name, func(t *testing.T) {
			var seen string
			app := newClientRequestIDApp(RequestIDSourceDefault, &seen, map[string]any{})
			resp := app.Serve(context.Background(), portableRequestWithClientRequestID(value))
			if seen != "" {
				t.Fatalf("expected an empty client request id for %q, got %q", value, seen)
			}
			if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_generated" {
				t.Fatalf("expected the generated request id on the response header for %q, got %q", value, got)
			}
			if got := responseRequestID(t, resp.Body); got != "req_generated" {
				t.Fatalf("expected the generated request id in the handler context for %q, got %q", value, got)
			}
			if strings.Contains(string(resp.Body), value) {
				t.Fatalf("malformed client value leaked into the response body for %q", value)
			}
		})
	}
}

func TestServe_RequestIDSourceDefault_MalformedClientRequestIDUsesEnvelopeRequestID(t *testing.T) {
	for name, value := range map[string]string{
		"crlf":  "evil\r\nx-injected: 1",
		"space": "has space",
	} {
		t.Run(name, func(t *testing.T) {
			app := New(WithTier(TierP1), WithIDGenerator(fixedIDGenerator("req_generated")))
			app.Get("/known", func(_ *Context) (*Response, error) {
				return JSON(200, map[string]any{"ok": true})
			})
			resp := app.Serve(context.Background(), Request{
				Method:  "GET",
				Path:    "/missing",
				Headers: map[string][]string{"x-request-id": {value}},
			})
			if resp.Status != 404 {
				t.Fatalf("expected status 404, got %d", resp.Status)
			}
			var envelope struct {
				Error struct {
					RequestID string `json:"request_id"`
				} `json:"error"`
			}
			if err := json.Unmarshal(resp.Body, &envelope); err != nil {
				t.Fatalf("parse error envelope: %v", err)
			}
			if envelope.Error.RequestID != "req_generated" {
				t.Fatalf("expected the generated request id in the envelope for %q, got %q", value, envelope.Error.RequestID)
			}
			if strings.Contains(string(resp.Body), value) {
				t.Fatalf("malformed client value leaked into the error envelope for %q", value)
			}
		})
	}
}

func TestServe_RequestIDSourceDefault_MalformedClientRequestIDFallsBack(t *testing.T) {
	var seen string
	app := newClientRequestIDApp(RequestIDSourceDefault, &seen, map[string]any{})
	resp := app.serveWithOptions(
		context.Background(),
		portableRequestWithClientRequestID("evil\r\nx-injected: 1"),
		serveOptions{fallbackRequestID: "req_fallback"},
	)
	if seen != "" {
		t.Fatalf("expected an empty client request id, got %q", seen)
	}
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_fallback" {
		t.Fatalf("expected the fallback request id on the response header, got %q", got)
	}
}

func TestServe_ClientRequestID_ServerIssuedMode_ReturnsWellFormedClientValue(t *testing.T) {
	var seen string
	app := newClientRequestIDApp(RequestIDSourceServer, &seen, map[string]any{})
	resp := app.Serve(context.Background(), portableRequestWithClientRequestID("req_client_visible"))
	if seen != "req_client_visible" {
		t.Fatalf("expected the well-formed client value on the context, got %q", seen)
	}
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_generated" {
		t.Fatalf("expected the server-issued request id on the response header, got %q", got)
	}
	if got := responseRequestID(t, resp.Body); got != "req_generated" {
		t.Fatalf("expected the server-issued request id in the handler context, got %q", got)
	}
}

func TestServe_ClientRequestID_ServerIssuedMode_IgnoresMalformedClientValue(t *testing.T) {
	for name, value := range map[string]string{
		"crlf":     "evil\r\nx-injected: 1",
		"oversize": strings.Repeat("a", MaxClientRequestIDLength+1),
		"nonascii": "caf\u00e9",
	} {
		t.Run(name, func(t *testing.T) {
			var seen string
			app := newClientRequestIDApp(RequestIDSourceServer, &seen, map[string]any{})
			resp := app.Serve(context.Background(), portableRequestWithClientRequestID(value))
			if seen != "" {
				t.Fatalf("expected an empty client request id for %q, got %q", value, seen)
			}
			if strings.Contains(string(resp.Body), value) {
				t.Fatalf("malformed client value leaked into the response body for %q", value)
			}
		})
	}
}

func TestServe_ContextRequestHeadersKeepRawClientRequestID(t *testing.T) {
	var raw string
	app := New(WithTier(TierP1), WithIDGenerator(fixedIDGenerator("req_generated")))
	app.Get("/context", func(ctx *Context) (*Response, error) {
		raw = firstHeaderValue(ctx.Request.Headers, "x-request-id")
		return JSON(200, map[string]any{"request_id": ctx.RequestID})
	})
	app.Serve(context.Background(), portableRequestWithClientRequestID("evil\r\nx-injected: 1"))
	if raw != "evil\r\nx-injected: 1" {
		t.Fatalf("expected the raw request header to be preserved, got %q", raw)
	}
}

func TestServe_ClientRequestID_SecureAppPopulatesWellFormedClientValue(t *testing.T) {
	app := NewSecure(SecureOptions{Tier: TierP1, IDGenerator: fixedIDGenerator("req_generated")})
	var seen string
	app.Handle("GET", "/public", func(ctx *Context) (*Response, error) {
		seen = ctx.ClientRequestID()
		return JSON(200, map[string]any{"request_id": ctx.RequestID})
	}, Public())

	resp := app.Serve(context.Background(), Request{
		Method:  "GET",
		Path:    "/public",
		Headers: map[string][]string{"x-request-id": {"req_client_visible"}},
	})
	if seen != "req_client_visible" {
		t.Fatalf("expected the well-formed client value on the secure context, got %q", seen)
	}
	if got := firstHeaderValue(resp.Headers, "x-request-id"); got != "req_client_visible" {
		t.Fatalf("expected the client request id on the response header, got %q", got)
	}
}

func TestServeAppSync_ClientRequestID_MalformedClientHeaderUsesLambdaFallback(t *testing.T) {
	app := New(WithTier(TierP2), WithIDGenerator(fixedIDGenerator("req_generated")))
	var seen string
	app.Post("/createThing", func(ctx *Context) (*Response, error) {
		seen = ctx.ClientRequestID()
		return JSON(200, map[string]any{"request_id": ctx.RequestID})
	})

	ctx := lambdacontext.NewContext(context.Background(), &lambdacontext.LambdaContext{AwsRequestID: "aws_req_fallback"})
	out := app.ServeAppSync(ctx, AppSyncResolverEvent{
		Info:    AppSyncResolverInfo{FieldName: "createThing", ParentTypeName: "Mutation"},
		Request: AppSyncResolverRequest{Headers: map[string]string{"x-request-id": "evil\r\nx-injected: 1"}},
	})

	if seen != "" {
		t.Fatalf("expected an empty client request id on the appsync context, got %q", seen)
	}
	payload, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal appsync payload: %v", err)
	}
	if !containsString(string(payload), `"request_id":"aws_req_fallback"`) {
		t.Fatalf("expected the Lambda fallback request id in the appsync payload, got %s", payload)
	}
	if containsString(string(payload), "injected") {
		t.Fatalf("malformed client value leaked into the appsync payload: %s", payload)
	}
}
