package apptheory

import (
	"context"
	"testing"
)

func TestEventMiddleware_OrderIsDeterministic(t *testing.T) {
	app := New()
	app.UseEvents(func(next EventHandler) EventHandler {
		return func(ctx *EventContext, event any) (any, error) {
			ctx.Set("trace", append(eventTrace(ctx), "m1"))
			return next(ctx, event)
		}
	})
	app.UseEvents(func(next EventHandler) EventHandler {
		return func(ctx *EventContext, event any) (any, error) {
			ctx.Set("trace", append(eventTrace(ctx), "m2"))
			return next(ctx, event)
		}
	})

	handler := app.applyEventMiddlewares(func(ctx *EventContext, _ any) (any, error) {
		ctx.Set("trace", append(eventTrace(ctx), "handler"))
		return nil, nil
	})
	evtCtx := app.eventContext(context.Background())
	if _, err := handler(evtCtx, "event"); err != nil {
		t.Fatalf("handler returned error: %v", err)
	}

	want := []string{"m1", "m2", "handler"}
	got := eventTrace(evtCtx)
	if len(got) != len(want) {
		t.Fatalf("unexpected trace: got=%v want=%v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unexpected trace: got=%v want=%v", got, want)
		}
	}
}

func eventTrace(ctx *EventContext) []string {
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
