package apptheory

import (
	"context"
	"encoding/json"
	"testing"
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
