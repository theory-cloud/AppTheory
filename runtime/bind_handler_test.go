package apptheory

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestBindHandler_BindsAcrossRequestSources(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name      string        `json:"name"`
		Limit     int           `query:"limit"`
		Actor     string        `path:"actor"`
		RequestID string        `header:"x-request-id"`
		Tags      []string      `query:"tag"`
		TTL       time.Duration `query:"ttl"`
	}
	type responseModel struct {
		Name      string   `json:"name"`
		Limit     int      `json:"limit"`
		Actor     string   `json:"actor"`
		RequestID string   `json:"request_id"`
		Tags      []string `json:"tags"`
		TTL       string   `json:"ttl"`
	}

	handler := BindHandler(BindConfig[requestModel]{
		Body:    true,
		Query:   true,
		Path:    true,
		Headers: true,
	}, func(_ *Context, req requestModel) (responseModel, error) {
		return responseModel{
			Name:      req.Name,
			Limit:     req.Limit,
			Actor:     req.Actor,
			RequestID: req.RequestID,
			Tags:      req.Tags,
			TTL:       req.TTL.String(),
		}, nil
	})

	resp, err := handler(&Context{
		Request: Request{
			Body: []byte(`{"name":"bob"}`),
			Query: map[string][]string{
				"limit": {"7"},
				"tag":   {"alpha", "beta"},
				"ttl":   {"2m"},
			},
			Headers: map[string][]string{
				"x-request-id": {"req_1"},
			},
		},
		Params: map[string]string{
			"actor": "Arch",
		},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("expected 200, got %d", resp.Status)
	}

	var parsed responseModel
	if err := json.Unmarshal(resp.Body, &parsed); err != nil {
		t.Fatalf("expected valid json response, got %v", err)
	}
	if parsed.Name != "bob" || parsed.Limit != 7 || parsed.Actor != "Arch" || parsed.RequestID != "req_1" {
		t.Fatalf("unexpected bound response: %#v", parsed)
	}
	if len(parsed.Tags) != 2 || parsed.Tags[0] != "alpha" || parsed.Tags[1] != "beta" {
		t.Fatalf("unexpected tags: %#v", parsed.Tags)
	}
	if parsed.TTL != "2m0s" {
		t.Fatalf("expected ttl 2m0s, got %q", parsed.TTL)
	}
}

func TestBindHandlerContext_UsesStdContextAndCustomStatus(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name string `json:"name"`
	}
	type responseModel struct {
		Value string `json:"value"`
	}

	type ctxKey struct{}
	key := ctxKey{}
	baseCtx := context.WithValue(context.Background(), key, "ctx")

	handler := BindHandlerContext(BindConfig[requestModel]{
		Body:          true,
		SuccessStatus: 201,
	}, func(ctx context.Context, req requestModel) (responseModel, error) {
		value, ok := ctx.Value(key).(string)
		if !ok {
			return responseModel{}, errors.New("missing bound context value")
		}
		return responseModel{Value: value + ":" + req.Name}, nil
	})

	resp, err := handler(&Context{
		ctx: baseCtx,
		Request: Request{
			Body: []byte(`{"name":"bob"}`),
		},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if resp.Status != 201 {
		t.Fatalf("expected 201, got %d", resp.Status)
	}

	var parsed responseModel
	if err := json.Unmarshal(resp.Body, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if parsed.Value != "ctx:bob" {
		t.Fatalf("unexpected response: %#v", parsed)
	}
}

func TestBindRequest_StrictJSONRejectsUnknownFields(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name string `json:"name"`
	}

	_, err := BindRequest(&Context{
		Request: Request{
			Body: []byte(`{"name":"bob","extra":true}`),
		},
	}, BindConfig[requestModel]{
		Body:       true,
		StrictJSON: true,
	})
	if err == nil {
		t.Fatal("expected error")
	}

	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != errorCodeBadRequest || appErr.StatusCode != 400 {
		t.Fatalf("unexpected error payload: %#v", appErr)
	}
	if appErr.Cause == nil {
		t.Fatal("expected strict json failure to preserve cause")
	}
}

func TestBindRequest_StrictJSONRejectsTrailingValues(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name string `json:"name"`
	}

	_, err := BindRequest(&Context{
		Request: Request{
			Body: []byte(`{"name":"bob"}{"admin":true}`),
		},
	}, BindConfig[requestModel]{
		Body:       true,
		StrictJSON: true,
	})
	if err == nil {
		t.Fatal("expected trailing json value error")
	}

	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != errorCodeBadRequest || appErr.StatusCode != 400 {
		t.Fatalf("unexpected error payload: %#v", appErr)
	}
}

func TestBindRequest_InvalidQueryBindingReturnsBadRequest(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Limit int `query:"limit"`
	}

	_, err := BindRequest(&Context{
		Request: Request{
			Query: map[string][]string{
				"limit": {"oops"},
			},
		},
	}, BindConfig[requestModel]{
		Query: true,
	})
	if err == nil {
		t.Fatal("expected error")
	}

	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != errorCodeBadRequest || appErr.StatusCode != 400 {
		t.Fatalf("unexpected error payload: %#v", appErr)
	}
}

func TestBindRequest_ValidateMapsToValidationFailed(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name string `json:"name"`
	}

	_, err := BindRequest(&Context{
		Request: Request{
			Body: []byte(`{"name":"bob"}`),
		},
	}, BindConfig[requestModel]{
		Body: true,
		Validate: func(_ *Context, _ requestModel) error {
			return errors.New("bad input")
		},
	})
	if err == nil {
		t.Fatal("expected error")
	}

	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != errorCodeValidationFailed || appErr.StatusCode != 422 {
		t.Fatalf("unexpected validation payload: %#v", appErr)
	}
	if appErr.Cause == nil {
		t.Fatal("expected validation failure to preserve cause")
	}
}

func TestBindRequest_DeclarativeValidationReturnsCanonicalFieldErrors(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name string `json:"name" validate:"required"`
		Age  int    `json:"age" validate:"min=18"`
	}

	_, err := BindRequest(&Context{
		Request: Request{
			Body: []byte(`{"name":"","age":17}`),
		},
	}, BindConfig[requestModel]{
		Body: true,
	})
	if err == nil {
		t.Fatal("expected validation error")
	}

	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != errorCodeValidationFailed || appErr.StatusCode != 422 {
		t.Fatalf("unexpected validation payload: %#v", appErr)
	}
	errorsValue, ok := appErr.Details["errors"].([]ValidationFieldError)
	if !ok {
		t.Fatalf("expected validation field errors, got %#v", appErr.Details["errors"])
	}
	if len(errorsValue) != 2 {
		t.Fatalf("expected 2 field errors, got %#v", errorsValue)
	}
	if errorsValue[0] != (ValidationFieldError{Field: "name", Rule: ValidationRuleRequired, Message: "name is required"}) {
		t.Fatalf("unexpected required field error: %#v", errorsValue[0])
	}
	if errorsValue[1] != (ValidationFieldError{Field: "age", Rule: ValidationRuleMin, Message: "age must be >= 18"}) {
		t.Fatalf("unexpected min field error: %#v", errorsValue[1])
	}
}

func TestBindRequest_QueryBindingRequiresStructTarget(t *testing.T) {
	t.Parallel()

	_, err := BindRequest(&Context{
		Request: Request{
			Query: map[string][]string{
				"name": {"bob"},
			},
		},
	}, BindConfig[string]{
		Query: true,
	})
	if err == nil {
		t.Fatal("expected error")
	}

	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != errorCodeBadRequest || appErr.StatusCode != 400 {
		t.Fatalf("unexpected error payload: %#v", appErr)
	}
}

type bindTextValue string

func (v *bindTextValue) UnmarshalText(raw []byte) error {
	*v = bindTextValue("text:" + string(raw))
	return nil
}

func TestBindRequest_BindsPointerEmbeddedAndScalarTypes(t *testing.T) {
	t.Parallel()

	type EmbeddedModel struct {
		Enabled bool `query:"enabled"`
	}
	type requestModel struct {
		*EmbeddedModel
		Name   *string       `query:"name"`
		Count  uint16        `query:"count"`
		Ratio  float64       `query:"ratio"`
		Custom bindTextValue `query:"custom"`
	}

	out, err := BindRequest(&Context{
		Request: Request{
			Query: map[string][]string{
				"enabled": {"true"},
				"name":    {"alice"},
				"count":   {"42"},
				"ratio":   {"1.5"},
				"custom":  {"value"},
			},
		},
	}, BindConfig[requestModel]{Query: true})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if out.EmbeddedModel == nil || !out.Enabled {
		t.Fatalf("expected embedded pointer to be allocated and bound, got %#v", out.EmbeddedModel)
	}
	if out.Name == nil || *out.Name != "alice" {
		t.Fatalf("expected pointer string to bind, got %#v", out.Name)
	}
	if out.Count != 42 || out.Ratio != 1.5 || out.Custom != "text:value" {
		t.Fatalf("unexpected scalar bindings: %#v", out)
	}
}

func TestBindRequest_ValidationPreservesAppTheoryAndAppErrors(t *testing.T) {
	t.Parallel()

	type requestModel struct {
		Name string `json:"name"`
	}

	appTheoryCause := NewAppTheoryError(errorCodeForbidden, "denied").WithStatusCode(403)
	_, err := BindRequest(&Context{Request: Request{Body: []byte(`{"name":"bob"}`)}}, BindConfig[requestModel]{
		Body: true,
		Validate: func(_ *Context, _ requestModel) error {
			return appTheoryCause
		},
	})
	if err != appTheoryCause {
		t.Fatalf("expected AppTheoryError to be returned as-is, got %#v", err)
	}

	_, err = BindRequest(&Context{Request: Request{Body: []byte(`{"name":"bob"}`)}}, BindConfig[requestModel]{
		Body: true,
		Validate: func(_ *Context, _ requestModel) error {
			return &AppError{Code: errorCodeConflict, Message: "conflict"}
		},
	})
	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	if appErr.Code != errorCodeConflict || appErr.StatusCode != 409 {
		t.Fatalf("unexpected mapped AppError: %#v", appErr)
	}
}

func TestValidateBoundRequest_RuleVocabularyAggregates(t *testing.T) {
	t.Parallel()

	type embeddedModel struct {
		Code string `json:"code" validate:"pattern=^[A-Z]+$"`
	}
	type requestModel struct {
		embeddedModel
		Title    string            `json:"title" validate:"min_length=3,max_length=5"`
		Quantity int               `json:"quantity" validate:"max=10"`
		Level    int               `json:"level" validate:"enum=1|2"`
		State    string            `json:"state" validate:"enum=open|closed"`
		Tags     []string          `json:"tags" validate:"min_length=2"`
		Labels   map[string]string `json:"labels" validate:"max_length=1"`
		Ptr      *int              `json:"ptr" validate:"required"`
	}

	err := validateBoundRequest(requestModel{
		embeddedModel: embeddedModel{Code: "abc"},
		Title:         "xx",
		Quantity:      11,
		Level:         3,
		State:         "pending",
		Tags:          []string{"one"},
		Labels:        map[string]string{"a": "1", "b": "2"},
	})
	if err == nil {
		t.Fatal("expected validation error")
	}

	appErr, ok := err.(*AppTheoryError)
	if !ok {
		t.Fatalf("expected AppTheoryError, got %T", err)
	}
	got, ok := appErr.Details["errors"].([]ValidationFieldError)
	if !ok {
		t.Fatalf("expected validation field errors, got %#v", appErr.Details["errors"])
	}
	want := []ValidationFieldError{
		{Field: "code", Rule: ValidationRulePattern, Message: "code must match pattern"},
		{Field: "title", Rule: ValidationRuleMinLength, Message: "title length must be >= 3"},
		{Field: "quantity", Rule: ValidationRuleMax, Message: "quantity must be <= 10"},
		{Field: "level", Rule: ValidationRuleEnum, Message: "level must be one of 1, 2"},
		{Field: "state", Rule: ValidationRuleEnum, Message: "state must be one of open, closed"},
		{Field: "tags", Rule: ValidationRuleMinLength, Message: "tags length must be >= 2"},
		{Field: "labels", Rule: ValidationRuleMaxLength, Message: "labels length must be <= 1"},
		{Field: "ptr", Rule: ValidationRuleRequired, Message: "ptr is required"},
	}
	if len(got) != len(want) {
		t.Fatalf("expected %d errors, got %#v", len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("error %d: expected %#v, got %#v", i, want[i], got[i])
		}
	}
}

func TestValidateBoundRequest_PassesRulesAndIgnoresMalformedRules(t *testing.T) {
	t.Parallel()

	value := 3
	type requestModel struct {
		Name   string  `json:"name" validate:"required,min_length=2,max_length=5,unknown=1"`
		Count  uint    `query:"count" validate:"min=2,max=4"`
		Ratio  float64 `path:"ratio" validate:"min=1.5"`
		State  string  `header:"x-state" validate:"enum=open|closed"`
		Labels []int   `json:"labels" validate:"min_length=1,max_length=2"`
		Value  *int    `json:"value" validate:"required"`
		Loose  string  `json:"loose" validate:"min=bad,max=bad,min_length=bad,max_length=bad,pattern=["`
		Empty  string  `json:"empty" validate:"enum="`
	}

	err := validateBoundRequest(requestModel{
		Name:   "bob",
		Count:  3,
		Ratio:  1.5,
		State:  "closed",
		Labels: []int{1, 2},
		Value:  &value,
	})
	if err != nil {
		t.Fatalf("expected valid model to pass, got %v", err)
	}
	if err := validateBoundRequest("not a struct"); err != nil {
		t.Fatalf("expected non-struct validation to no-op, got %v", err)
	}
	if err := validateBoundRequest(nil); err != nil {
		t.Fatalf("expected nil validation to no-op, got %v", err)
	}
}
