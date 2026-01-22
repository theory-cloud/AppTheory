package apptheory

import (
	"context"
	"encoding/json"
	"testing"
)

func TestMiddleware_ContextValueBag(t *testing.T) {
	app := New(WithTier(TierP0))

	app.Use(func(next Handler) Handler {
		return func(ctx *Context) (*Response, error) {
			ctx.Set("foo", "bar")
			return next(ctx)
		}
	})

	app.Get("/", func(ctx *Context) (*Response, error) {
		return MustJSON(200, map[string]any{"foo": ctx.Get("foo")}), nil
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/"})

	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal response body: %v", err)
	}
	if body["foo"] != "bar" {
		t.Fatalf("expected foo=bar, got %v", body["foo"])
	}
}

func TestMiddleware_OrderIsDeterministic(t *testing.T) {
	app := New(WithTier(TierP0))

	app.Use(func(next Handler) Handler {
		return func(ctx *Context) (*Response, error) {
			trace := traceFromContext(ctx)
			ctx.Set("trace", append(trace, "m1"))
			return next(ctx)
		}
	})

	app.Use(func(next Handler) Handler {
		return func(ctx *Context) (*Response, error) {
			trace := traceFromContext(ctx)
			ctx.Set("trace", append(trace, "m2"))
			return next(ctx)
		}
	})

	app.Get("/", func(ctx *Context) (*Response, error) {
		trace := traceFromContext(ctx)
		return MustJSON(200, map[string]any{"trace": append(trace, "handler")}), nil
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/"})

	var body struct {
		Trace []string `json:"trace"`
	}
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal response body: %v", err)
	}
	want := []string{"m1", "m2", "handler"}
	if len(body.Trace) != len(want) {
		t.Fatalf("unexpected trace length: got=%v want=%v", body.Trace, want)
	}
	for i := range want {
		if body.Trace[i] != want[i] {
			t.Fatalf("unexpected trace: got=%v want=%v", body.Trace, want)
		}
	}
}

func traceFromContext(ctx *Context) []string {
	if ctx == nil {
		return nil
	}
	value := ctx.Get("trace")
	trace, ok := value.([]string)
	if !ok {
		return nil
	}
	return trace
}
