package mcp

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestResponseForProtocolAddsCompleteOnlyFor20260728(t *testing.T) {
	t.Parallel()

	modern := responseForProtocol(NewResultResponse("modern", map[string]any{"ok": true}), ProtocolVersion20260728)
	modernBody, err := MarshalResponse(modern)
	if err != nil {
		t.Fatalf("marshal modern response: %v", err)
	}
	assertJSONEqual(t, modernBody, []byte(
		`{"jsonrpc":"2.0","id":"modern","result":{"ok":true,"resultType":"complete"}}`,
	))

	legacy := responseForProtocol(NewResultResponse("legacy", map[string]any{"ok": true}), protocolVersion)
	legacyBody, err := MarshalResponse(legacy)
	if err != nil {
		t.Fatalf("marshal legacy response: %v", err)
	}
	assertJSONEqual(t, legacyBody, []byte(
		`{"jsonrpc":"2.0","id":"legacy","result":{"ok":true}}`,
	))
}

func TestResponseForProtocolBuildsInputRequiredResult(t *testing.T) {
	t.Parallel()

	resp := responseForProtocol(NewResultResponse("input", &ToolResult{
		ResultType: ResultTypeInputRequired,
		InputRequests: map[string]InputRequest{
			"confirmation": {
				Method: "elicitation/create",
				Params: map[string]any{"message": "Confirm"},
			},
		},
		RequestState: "confirm-contract",
	}), ProtocolVersion20260728)

	body, err := MarshalResponse(resp)
	if err != nil {
		t.Fatalf("marshal input_required response: %v", err)
	}
	assertJSONEqual(t, body, []byte(
		`{"jsonrpc":"2.0","id":"input","result":{"inputRequests":{"confirmation":{"method":"elicitation/create","params":{"message":"Confirm"}}},"requestState":"confirm-contract","resultType":"input_required"}}`,
	))
}

func TestResponseForProtocolRejectsInputRequiredForSessionfulClient(t *testing.T) {
	t.Parallel()

	resp := responseForProtocol(NewResultResponse("legacy", &ToolResult{
		ResultType:   ResultTypeInputRequired,
		RequestState: "state",
	}), protocolVersion)

	if resp.Error == nil {
		t.Fatal("expected error response")
	}
	if resp.Error.Code != CodeInvalidRequest {
		t.Fatalf("error code = %d, want %d", resp.Error.Code, CodeInvalidRequest)
	}
}

func TestResponseForProtocolAcceptsInputRequiredResultForms(t *testing.T) {
	t.Parallel()

	for name, result := range map[string]any{
		"value": InputRequiredResult{RequestState: "value-state"},
		"pointer": &InputRequiredResult{
			InputRequests: map[string]InputRequest{
				"confirmation": {Method: "elicitation/create"},
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			resp := responseForProtocol(NewResultResponse(name, result), ProtocolVersion20260728)
			if resp.Error != nil {
				t.Fatalf("unexpected error response: %#v", resp.Error)
			}
			prepared, ok := resp.Result.(InputRequiredResult)
			if !ok {
				t.Fatalf("result type = %T, want InputRequiredResult", resp.Result)
			}
			if prepared.ResultType != ResultTypeInputRequired {
				t.Fatalf("resultType = %q, want %q", prepared.ResultType, ResultTypeInputRequired)
			}
		})
	}
}

func TestResponseForProtocolRejectsInvalidResultStates(t *testing.T) {
	t.Parallel()

	tests := map[string]any{
		"nil tool result":        (*ToolResult)(nil),
		"nil input result":       (*InputRequiredResult)(nil),
		"complete with requests": &ToolResult{InputRequests: map[string]InputRequest{"input": {Method: "elicitation/create"}}},
		"unknown result type":    &ToolResult{ResultType: ResultType("pending")},
		"empty input required":   InputRequiredResult{},
	}
	for name, result := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			resp := responseForProtocol(NewResultResponse(name, result), ProtocolVersion20260728)
			if resp.Error == nil {
				t.Fatal("expected error response")
			}
			if resp.Error.Code != CodeInternalError {
				t.Fatalf("error code = %d, want %d", resp.Error.Code, CodeInternalError)
			}
		})
	}
}

func TestResultWithTypeRejectsNonObjectResults(t *testing.T) {
	t.Parallel()

	tests := map[string]any{
		"scalar": "not-an-object",
		"null":   nil,
		"marshal error": map[string]any{
			"unsupported": make(chan struct{}),
		},
	}
	for name, result := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := marshalResultWithType(result, ResultTypeComplete); err == nil {
				t.Fatal("expected marshal error")
			}
		})
	}
}

func TestToolInputFromContextReturnsCopy(t *testing.T) {
	t.Parallel()

	ctx := withToolInput(context.Background(), ToolInput{
		InputResponses: map[string]any{"confirmation": map[string]any{"action": "accept"}},
		RequestState:   "confirm-contract",
	})
	input := ToolInputFromContext(ctx)
	if input.RequestState != "confirm-contract" {
		t.Fatalf("request state = %q", input.RequestState)
	}
	input.InputResponses["changed"] = true
	again := ToolInputFromContext(ctx)
	if _, ok := again.InputResponses["changed"]; ok {
		t.Fatal("ToolInputFromContext returned mutable stored map")
	}
}

func TestToolInputFromContextReturnsZeroWithoutInput(t *testing.T) {
	t.Parallel()

	for name, ctx := range map[string]context.Context{
		"nil":        nil,
		"background": context.Background(),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			input := ToolInputFromContext(ctx)
			if input.RequestState != "" || input.InputResponses != nil {
				t.Fatalf("input = %#v, want zero value", input)
			}
		})
	}
}

func assertJSONEqual(t *testing.T, actual []byte, expected []byte) {
	t.Helper()
	var actualValue any
	if err := json.Unmarshal(actual, &actualValue); err != nil {
		t.Fatalf("unmarshal actual JSON: %v", err)
	}
	var expectedValue any
	if err := json.Unmarshal(expected, &expectedValue); err != nil {
		t.Fatalf("unmarshal expected JSON: %v", err)
	}
	if !reflect.DeepEqual(actualValue, expectedValue) {
		t.Fatalf("JSON mismatch:\nactual:   %#v\nexpected: %#v", actualValue, expectedValue)
	}
}
