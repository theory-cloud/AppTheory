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
