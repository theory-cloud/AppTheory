package apptheory

import (
	"context"
	"testing"
	"time"
)

type testFixedClock struct {
	now time.Time
}

func (c testFixedClock) Now() time.Time { return c.now }

func TestContext_Basics_SetGetParamAndJSONValue(t *testing.T) {
	t.Parallel()

	if got := (*Context)(nil).Context(); got == nil {
		t.Fatal("expected nil Context().Context() to return a non-nil context")
	}
	if got := (*Context)(nil).Param("x"); got != "" {
		t.Fatalf("expected nil Context().Param() to return empty string, got %q", got)
	}
	if got := (*Context)(nil).AsWebSocket(); got != nil {
		t.Fatalf("expected nil Context().AsWebSocket() to return nil, got %#v", got)
	}

	fixedNow := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c := &Context{
		ctx:   context.Background(),
		clock: testFixedClock{now: fixedNow},
		ids:   fixedIDGenerator("id_1"),
		Params: map[string]string{
			"p": "v",
		},
		ws: &WebSocketContext{},
	}

	if got := c.Now(); !got.Equal(fixedNow) {
		t.Fatalf("expected fixed Now, got %v", got)
	}
	if got := c.NewID(); got != "id_1" {
		t.Fatalf("expected fixed NewID, got %q", got)
	}
	if got := c.Param("p"); got != "v" {
		t.Fatalf("expected Param(p)=v, got %q", got)
	}
	if got := c.AsWebSocket(); got == nil {
		t.Fatal("expected AsWebSocket() to return websocket context")
	}

	c.Set("  ", "ignored")
	if got := c.Get("  "); got != nil {
		t.Fatalf("expected Get(blank) to return nil, got %#v", got)
	}
	c.Set("k", "v")
	if got := c.Get("k"); got != "v" {
		t.Fatalf("expected Get(k)=v, got %#v", got)
	}

	// JSONValue: nil context.
	if _, err := (*Context)(nil).JSONValue(); err == nil {
		t.Fatal("expected JSONValue() to fail for nil context")
	}

	// JSONValue: wrong content-type.
	c.Request = Request{
		Headers: map[string][]string{"content-type": {"text/plain"}},
		Body:    []byte(`{"ok":true}`),
	}
	if _, err := c.JSONValue(); err == nil {
		t.Fatal("expected JSONValue() to fail for non-json content-type")
	}

	// JSONValue: empty body.
	c.Request = Request{
		Headers: map[string][]string{"content-type": {"application/json"}},
		Body:    nil,
	}
	if v, err := c.JSONValue(); err != nil || v != nil {
		t.Fatalf("expected JSONValue() to return (nil,nil) for empty body, got (%#v,%v)", v, err)
	}

	// JSONValue: invalid json.
	c.Request.Body = []byte(`{`)
	if _, err := c.JSONValue(); err == nil {
		t.Fatal("expected JSONValue() to fail for invalid json")
	}

	// JSONValue: valid json.
	c.Request.Body = []byte(`{"a":1}`)
	v, err := c.JSONValue()
	if err != nil {
		t.Fatalf("JSONValue() returned error: %v", err)
	}
	m, ok := v.(map[string]any)
	if !ok || m["a"] == nil {
		t.Fatalf("expected JSONValue() to return object with key a, got %#v (%T)", v, v)
	}
}
