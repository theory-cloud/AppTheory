package refusal

import (
	"context"
	"testing"
	"time"
)

func TestEmitIsNilSafeAndContainsPanics(t *testing.T) {
	Emit(context.Background(), nil, Event{Status: 401})

	called := false
	Emit(context.Background(), func(context.Context, Event) { called = true }, Event{Status: 401})
	if !called {
		t.Fatalf("hook was not called")
	}

	Emit(context.Background(), func(context.Context, Event) { panic("hook failure") }, Event{Status: 401})
}

func TestEventCarriesOnlyRedactedIdentity(t *testing.T) {
	var got Event
	Emit(context.Background(), func(_ context.Context, event Event) { got = event }, Event{
		At:        time.Unix(1700000000, 0).UTC(),
		Class:     ClassTransport,
		Reason:    ReasonUnknownSession,
		Status:    404,
		Method:    "GET",
		Path:      "/mcp",
		ErrorCode: "app.unauthorized",
		Challenge: "resource_metadata",
	})
	if got.Class != ClassTransport || got.Reason != ReasonUnknownSession || got.Status != 404 {
		t.Fatalf("event = %+v", got)
	}
}

func TestIsRefusalStatus(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 405} {
		if !IsRefusalStatus(status) {
			t.Fatalf("status %d must be a refusal", status)
		}
	}
	for _, status := range []int{200, 202, 204, 302, 409, 429, 500, 503} {
		if IsRefusalStatus(status) {
			t.Fatalf("status %d must not be a refusal", status)
		}
	}
}
