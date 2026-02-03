package apptheory

import (
	"context"
	"encoding/json"
	"testing"
)

func TestJSONHandler_SuccessWithAppContext(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name string `json:"name"`
	}
	type responseModel struct {
		Greeting string `json:"greeting"`
	}

	ctx := &Context{
		Request: Request{
			Body: []byte(`{"name":"bob"}`),
		},
	}

	handler := JSONHandler(func(_ *Context, req requestModel) (responseModel, error) {
		return responseModel{Greeting: "hi " + req.Name}, nil
	})

	resp, err := handler(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}
	if got := resp.Headers["content-type"]; len(got) == 0 || got[0] != "application/json; charset=utf-8" {
		t.Fatalf("expected json content-type, got %#v", resp.Headers["content-type"])
	}

	var parsed responseModel
	if err := json.Unmarshal(resp.Body, &parsed); err != nil {
		t.Fatalf("expected valid json, got %v", err)
	}
	if parsed.Greeting != "hi bob" {
		t.Fatalf("expected greeting, got %#v", parsed)
	}
}

func TestJSONHandler_SuccessWithStdContext(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name string `json:"name"`
	}
	type responseModel struct {
		Seen string `json:"seen"`
	}

	key := struct{}{}
	baseCtx := context.WithValue(context.Background(), key, "ok")
	ctx := &Context{
		ctx: baseCtx,
		Request: Request{
			Body: []byte(`{"name":"bob"}`),
		},
	}

	handler := JSONHandlerContext(func(ctx context.Context, req requestModel) (responseModel, error) {
		value, _ := ctx.Value(key).(string)
		return responseModel{Seen: value + ":" + req.Name}, nil
	})

	resp, err := handler(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	var parsed responseModel
	if err := json.Unmarshal(resp.Body, &parsed); err != nil {
		t.Fatalf("expected valid json, got %v", err)
	}
	if parsed.Seen != "ok:bob" {
		t.Fatalf("expected context value, got %#v", parsed)
	}
}

func TestJSONHandler_EmptyBody(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name string `json:"name"`
	}
	type responseModel struct {
		Ok bool `json:"ok"`
	}

	ctx := &Context{
		Request: Request{},
	}

	handler := JSONHandler(func(_ *Context, _ requestModel) (responseModel, error) {
		return responseModel{Ok: true}, nil
	})

	_, err := handler(ctx)
	if err == nil {
		t.Fatal("expected error")
	}
	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != jsonHandlerErrorCodeEmptyBody || appErr.Message != jsonHandlerErrorMessageEmptyBody {
		t.Fatalf("unexpected error payload: %#v", appErr)
	}
	if appErr.StatusCode != 400 {
		t.Fatalf("expected status 400, got %d", appErr.StatusCode)
	}
}

func TestJSONHandler_InvalidJSON(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name string `json:"name"`
	}
	type responseModel struct {
		Ok bool `json:"ok"`
	}

	ctx := &Context{
		Request: Request{
			Body: []byte("{bad-json}"),
		},
	}

	handler := JSONHandler(func(_ *Context, _ requestModel) (responseModel, error) {
		return responseModel{Ok: true}, nil
	})

	_, err := handler(ctx)
	if err == nil {
		t.Fatal("expected error")
	}
	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != jsonHandlerErrorCodeInvalidJSON || appErr.Message != jsonHandlerErrorMessageInvalidJSON {
		t.Fatalf("unexpected error payload: %#v", appErr)
	}
	if appErr.StatusCode != 400 {
		t.Fatalf("expected status 400, got %d", appErr.StatusCode)
	}
	if appErr.Cause == nil {
		t.Fatal("expected cause to be set")
	}
}
