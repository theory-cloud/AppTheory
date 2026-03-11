package apptheory

import (
	"context"
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
