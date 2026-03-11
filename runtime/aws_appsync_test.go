package apptheory

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/lambdacontext"
)

func TestServeAppSync_AdaptsMutationAndProjectsJSON(t *testing.T) {
	app := New(WithTier(TierP2))
	app.Post("/createThing", func(ctx *Context) (*Response, error) {
		if ctx.Request.Method != "POST" {
			t.Fatalf("expected POST method, got %q", ctx.Request.Method)
		}
		if ctx.Request.Path != "/createThing" {
			t.Fatalf("expected /createThing path, got %q", ctx.Request.Path)
		}
		if got := firstHeaderValue(ctx.Request.Headers, "x-test-header"); got != "present" {
			t.Fatalf("expected request header to be preserved, got %q", got)
		}

		value, err := ctx.JSONValue()
		if err != nil {
			t.Fatalf("JSONValue returned error: %v", err)
		}

		return MustJSON(200, map[string]any{
			"method":    ctx.Request.Method,
			"arguments": value,
		}), nil
	})

	out := app.ServeAppSync(context.Background(), AppSyncResolverEvent{
		Arguments: map[string]any{
			"id":   "thing_123",
			"name": "example",
		},
		Request: AppSyncResolverRequest{
			Headers: map[string]string{
				"x-test-header": "present",
			},
		},
		Info: AppSyncResolverInfo{
			FieldName:      "createThing",
			ParentTypeName: "Mutation",
		},
	})

	payload, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("expected projected JSON payload, got %T", out)
	}
	if payload["method"] != "POST" {
		t.Fatalf("expected projected method POST, got %#v", payload["method"])
	}
	args, ok := payload["arguments"].(map[string]any)
	if !ok {
		t.Fatalf("expected projected arguments object, got %#v", payload["arguments"])
	}
	if args["id"] != "thing_123" || args["name"] != "example" {
		t.Fatalf("unexpected projected arguments: %#v", args)
	}
}

func TestServeAppSync_AdaptsQueryAndProjectsText(t *testing.T) {
	app := New(WithTier(TierP2))
	app.Get("/getThing", func(ctx *Context) (*Response, error) {
		if ctx.Request.Method != "GET" {
			t.Fatalf("expected GET method, got %q", ctx.Request.Method)
		}
		return Text(200, "ok"), nil
	})

	out := app.ServeAppSync(context.Background(), AppSyncResolverEvent{
		Arguments: map[string]any{},
		Info: AppSyncResolverInfo{
			FieldName:      "getThing",
			ParentTypeName: "Query",
		},
	})

	text, ok := out.(string)
	if !ok {
		t.Fatalf("expected projected text payload, got %T", out)
	}
	if text != "ok" {
		t.Fatalf("expected text payload ok, got %q", text)
	}
}

func TestServeAppSync_ProjectsEmptyBodyToNil(t *testing.T) {
	app := New(WithTier(TierP2))
	app.Get("/emptyThing", func(_ *Context) (*Response, error) {
		return &Response{Status: 204, Headers: map[string][]string{}, Body: nil}, nil
	})

	out := app.ServeAppSync(context.Background(), AppSyncResolverEvent{
		Arguments: map[string]any{},
		Info: AppSyncResolverInfo{
			FieldName:      "emptyThing",
			ParentTypeName: "Query",
		},
	})

	if out != nil {
		t.Fatalf("expected nil payload for empty response body, got %#v", out)
	}
}

func TestAppSyncPayloadFromResponse_RejectsBinaryBody(t *testing.T) {
	_, err := appSyncPayloadFromResponse(Response{
		Status:   200,
		Headers:  map[string][]string{},
		Body:     []byte("abc"),
		IsBase64: true,
	})
	if err == nil {
		t.Fatal("expected binary response projection to fail")
	}

	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != errorCodeInternal || appErr.Message != appSyncProjectionMessage {
		t.Fatalf("unexpected error: %#v", appErr)
	}
	if got := appErr.Details["reason"]; got != appSyncProjectionBinaryReason {
		t.Fatalf("expected binary projection reason, got %#v", got)
	}
}

func TestAppSyncPayloadFromResponse_RejectsStreamingBody(t *testing.T) {
	_, err := appSyncPayloadFromResponse(Response{
		Status:     200,
		Headers:    map[string][]string{},
		Body:       nil,
		BodyStream: StreamBytes([]byte("chunk")),
	})
	if err == nil {
		t.Fatal("expected streaming response projection to fail")
	}

	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != errorCodeInternal || appErr.Message != appSyncProjectionMessage {
		t.Fatalf("unexpected error: %#v", appErr)
	}
	if got := appErr.Details["reason"]; got != appSyncProjectionStreamReason {
		t.Fatalf("expected streaming projection reason, got %#v", got)
	}
}

func TestHandleLambda_AppSyncDispatchPreservesMetadata(t *testing.T) {
	app := New(WithTier(TierP2))
	app.Post("/createThing", func(ctx *Context) (*Response, error) {
		if got := ctx.Get(contextKeyTriggerType); got != "appsync" {
			t.Fatalf("expected appsync trigger type, got %#v", got)
		}
		if got := ctx.Get(contextKeyAppSyncFieldName); got != "createThing" {
			t.Fatalf("expected field name, got %#v", got)
		}
		if got := ctx.Get(contextKeyAppSyncParentTypeName); got != "Mutation" {
			t.Fatalf("expected parent type, got %#v", got)
		}
		if got, ok := ctx.Get(contextKeyAppSyncIdentity).(map[string]any); !ok || got["username"] != "user_1" {
			t.Fatalf("expected identity metadata, got %#v", ctx.Get(contextKeyAppSyncIdentity))
		}
		if got, ok := ctx.Get(contextKeyAppSyncSource).(map[string]any); !ok || got["id"] != "parent_1" {
			t.Fatalf("expected source metadata, got %#v", ctx.Get(contextKeyAppSyncSource))
		}
		if got, ok := ctx.Get(contextKeyAppSyncVariables).(map[string]any); !ok || got["tenantId"] != "tenant_1" {
			t.Fatalf("expected variables metadata, got %#v", ctx.Get(contextKeyAppSyncVariables))
		}
		if got := ctx.Get(contextKeyAppSyncPrev); got != "prev_value" {
			t.Fatalf("expected prev metadata, got %#v", got)
		}
		if got, ok := ctx.Get(contextKeyAppSyncStash).(map[string]any); !ok || got["trace"] != "abc123" {
			t.Fatalf("expected stash metadata, got %#v", ctx.Get(contextKeyAppSyncStash))
		}
		if got, ok := ctx.Get(contextKeyAppSyncRequestHeaders).(map[string]string); !ok || got["x-appsync"] != "yes" {
			t.Fatalf("expected request headers metadata, got %#v", ctx.Get(contextKeyAppSyncRequestHeaders))
		}
		if got, ok := ctx.Get(contextKeyAppSyncRawEvent).(AppSyncResolverEvent); !ok || got.Info.FieldName != "createThing" {
			t.Fatalf("expected raw event metadata, got %#v", ctx.Get(contextKeyAppSyncRawEvent))
		}

		value, err := ctx.JSONValue()
		if err != nil {
			t.Fatalf("JSONValue returned error: %v", err)
		}

		return MustJSON(200, map[string]any{
			"arguments": value,
		}), nil
	})

	rawEvent, err := json.Marshal(AppSyncResolverEvent{
		Arguments: map[string]any{
			"id": "thing_123",
		},
		Identity: map[string]any{
			"username": "user_1",
		},
		Source: map[string]any{
			"id": "parent_1",
		},
		Request: AppSyncResolverRequest{
			Headers: map[string]string{
				"x-appsync": "yes",
			},
		},
		Info: AppSyncResolverInfo{
			FieldName:      "createThing",
			ParentTypeName: "Mutation",
			Variables: map[string]any{
				"tenantId": "tenant_1",
			},
		},
		Prev: "prev_value",
		Stash: map[string]any{
			"trace": "abc123",
		},
	})
	if err != nil {
		t.Fatalf("marshal appsync event: %v", err)
	}

	out, err := app.HandleLambda(context.Background(), rawEvent)
	if err != nil {
		t.Fatalf("HandleLambda(appsync) error: %v", err)
	}

	payload, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("expected projected JSON payload, got %T", out)
	}
	args, ok := payload["arguments"].(map[string]any)
	if !ok || args["id"] != "thing_123" {
		t.Fatalf("unexpected projected arguments: %#v", payload["arguments"])
	}
}

func TestHandleLambda_AppSyncRequiresNonEmptyFieldName(t *testing.T) {
	app := New(WithTier(TierP2))

	rawEvent := json.RawMessage(`{"arguments":{},"info":{"fieldName":" ","parentTypeName":"Mutation"}}`)
	if _, err := app.HandleLambda(context.Background(), rawEvent); err == nil {
		t.Fatal("expected non-appsync event to remain unrecognized when fieldName is blank")
	}
}

func TestServeAppSync_PopulatesTypedContext(t *testing.T) {
	app := New(WithTier(TierP2))
	app.Post("/createThing", func(ctx *Context) (*Response, error) {
		appsync := ctx.AsAppSync()
		if appsync == nil {
			t.Fatal("expected appsync context")
		}
		if appsync.FieldName != "createThing" || appsync.ParentTypeName != "Mutation" {
			t.Fatalf("unexpected typed context route info: %#v", appsync)
		}
		if appsync.Arguments["id"] != "thing_123" {
			t.Fatalf("unexpected typed context arguments: %#v", appsync.Arguments)
		}
		if appsync.Identity["username"] != "user_1" {
			t.Fatalf("unexpected typed context identity: %#v", appsync.Identity)
		}
		if appsync.Source["id"] != "parent_1" {
			t.Fatalf("unexpected typed context source: %#v", appsync.Source)
		}
		if appsync.Variables["tenantId"] != "tenant_1" {
			t.Fatalf("unexpected typed context variables: %#v", appsync.Variables)
		}
		if appsync.Stash["trace"] != "abc123" {
			t.Fatalf("unexpected typed context stash: %#v", appsync.Stash)
		}
		if appsync.Prev != "prev_value" {
			t.Fatalf("unexpected typed context prev: %#v", appsync.Prev)
		}
		if appsync.RequestHeaders["x-appsync"] != "yes" {
			t.Fatalf("unexpected typed context request headers: %#v", appsync.RequestHeaders)
		}
		if appsync.RawEvent.Info.FieldName != "createThing" {
			t.Fatalf("unexpected typed context raw event: %#v", appsync.RawEvent)
		}

		return MustJSON(200, map[string]any{"ok": true}), nil
	})

	out := app.ServeAppSync(context.Background(), AppSyncResolverEvent{
		Arguments: map[string]any{
			"id": "thing_123",
		},
		Identity: map[string]any{
			"username": "user_1",
		},
		Source: map[string]any{
			"id": "parent_1",
		},
		Request: AppSyncResolverRequest{
			Headers: map[string]string{
				"x-appsync": "yes",
			},
		},
		Info: AppSyncResolverInfo{
			FieldName:      "createThing",
			ParentTypeName: "Mutation",
			Variables: map[string]any{
				"tenantId": "tenant_1",
			},
		},
		Prev: "prev_value",
		Stash: map[string]any{
			"trace": "abc123",
		},
	})

	payload, ok := out.(map[string]any)
	if !ok || payload["ok"] != true {
		t.Fatalf("unexpected payload: %#v (%T)", out, out)
	}
}

func TestServeAppSync_FormatsPortableErrors(t *testing.T) {
	app := New(WithTier(TierP2))
	app.Post("/createThing", func(_ *Context) (*Response, error) {
		return nil, NewAppTheoryError(errorCodeValidationFailed, "bad input").
			WithStatusCode(422).
			WithDetails(map[string]any{"field": "name"}).
			WithTraceID("trace_1").
			WithTimestamp(time.Date(2026, time.March, 11, 15, 4, 5, 0, time.UTC))
	})

	lc := &lambdacontext.LambdaContext{AwsRequestID: "aws_req_1"}
	out := app.ServeAppSync(lambdacontext.NewContext(context.Background(), lc), AppSyncResolverEvent{
		Arguments: map[string]any{"id": "thing_123"},
		Info: AppSyncResolverInfo{
			FieldName:      "createThing",
			ParentTypeName: "Mutation",
		},
	})

	payload, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("expected appsync error payload, got %T", out)
	}
	if payload["pay_theory_error"] != true || payload["error_message"] != "bad input" || payload["error_type"] != appSyncErrorTypeClient {
		t.Fatalf("unexpected appsync portable error payload: %#v", payload)
	}

	errorData, ok := payload["error_data"].(map[string]any)
	if !ok {
		t.Fatalf("expected error_data object, got %#v", payload["error_data"])
	}
	if errorData["status_code"] != float64(422) && errorData["status_code"] != 422 {
		t.Fatalf("expected 422 status code, got %#v", errorData["status_code"])
	}
	if errorData["request_id"] != "aws_req_1" || errorData["trace_id"] != "trace_1" {
		t.Fatalf("unexpected appsync error_data: %#v", errorData)
	}
	if errorData["timestamp"] != "2026-03-11T15:04:05Z" {
		t.Fatalf("unexpected appsync timestamp: %#v", errorData["timestamp"])
	}

	errorInfo, ok := payload["error_info"].(map[string]any)
	if !ok {
		t.Fatalf("expected error_info object, got %#v", payload["error_info"])
	}
	if errorInfo["code"] != errorCodeValidationFailed || errorInfo["path"] != "/createThing" || errorInfo["method"] != "POST" || errorInfo["trigger_type"] != "appsync" {
		t.Fatalf("unexpected appsync error_info: %#v", errorInfo)
	}
	if details, ok := errorInfo["details"].(map[string]any); !ok || details["field"] != "name" {
		t.Fatalf("unexpected appsync error details: %#v", errorInfo["details"])
	}
}

func TestServeAppSync_FormatsAppErrors(t *testing.T) {
	app := New(WithTier(TierP2))
	app.Post("/createThing", func(_ *Context) (*Response, error) {
		return nil, &AppError{Code: errorCodeForbidden, Message: errorMessageForbidden}
	})

	lc := &lambdacontext.LambdaContext{AwsRequestID: "aws_req_2"}
	out := app.ServeAppSync(lambdacontext.NewContext(context.Background(), lc), AppSyncResolverEvent{
		Arguments: map[string]any{"id": "thing_123"},
		Info: AppSyncResolverInfo{
			FieldName:      "createThing",
			ParentTypeName: "Mutation",
		},
	})

	payload, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("expected appsync error payload, got %T", out)
	}
	if payload["pay_theory_error"] != true || payload["error_message"] != errorMessageForbidden || payload["error_type"] != appSyncErrorTypeClient {
		t.Fatalf("unexpected appsync app error payload: %#v", payload)
	}

	errorData, ok := payload["error_data"].(map[string]any)
	if !ok || errorData["status_code"] != float64(403) && errorData["status_code"] != 403 {
		t.Fatalf("unexpected appsync app error_data: %#v", payload["error_data"])
	}
	if errorData["request_id"] != "aws_req_2" {
		t.Fatalf("expected propagated request_id, got %#v", errorData["request_id"])
	}

	errorInfo, ok := payload["error_info"].(map[string]any)
	if !ok || errorInfo["code"] != errorCodeForbidden || errorInfo["path"] != "/createThing" || errorInfo["method"] != "POST" || errorInfo["trigger_type"] != "appsync" {
		t.Fatalf("unexpected appsync app error_info: %#v", payload["error_info"])
	}
}

func TestServeAppSync_FormatsUnexpectedErrors(t *testing.T) {
	app := New(WithTier(TierP2))
	app.Post("/createThing", func(_ *Context) (*Response, error) {
		return nil, errors.New("boom")
	})

	out := app.ServeAppSync(context.Background(), AppSyncResolverEvent{
		Arguments: map[string]any{"id": "thing_123"},
		Info: AppSyncResolverInfo{
			FieldName:      "createThing",
			ParentTypeName: "Mutation",
		},
	})

	payload, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("expected appsync error payload, got %T", out)
	}
	if payload["pay_theory_error"] != true || payload["error_message"] != "boom" || payload["error_type"] != appSyncErrorTypeSystem {
		t.Fatalf("unexpected appsync unexpected-error payload: %#v", payload)
	}
	if errorData, ok := payload["error_data"].(map[string]any); !ok || len(errorData) != 0 {
		t.Fatalf("expected empty error_data for unexpected errors, got %#v", payload["error_data"])
	}
	if errorInfo, ok := payload["error_info"].(map[string]any); !ok || len(errorInfo) != 0 {
		t.Fatalf("expected empty error_info for unexpected errors, got %#v", payload["error_info"])
	}
}
