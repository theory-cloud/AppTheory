package apptheory

import (
	"encoding/json"
	"testing"
)

func TestStepFunctionsTaskToken(t *testing.T) {
	if StepFunctionsTaskToken(nil) != "" {
		t.Fatal("expected empty token for nil input")
	}

	if StepFunctionsTaskToken(map[string]any{"taskToken": "  a "}) != "a" {
		t.Fatal("expected taskToken to be extracted from map[string]any")
	}
	if StepFunctionsTaskToken(map[string]string{"TaskToken": "b"}) != "b" {
		t.Fatal("expected TaskToken to be extracted from map[string]string")
	}

	raw := json.RawMessage(`{"task_token":" c "}`)
	if StepFunctionsTaskToken(raw) != "c" {
		t.Fatal("expected task_token to be extracted from json.RawMessage")
	}

	if StepFunctionsTaskToken([]byte(`{"taskToken":"d"}`)) != "d" {
		t.Fatal("expected taskToken to be extracted from []byte")
	}

	type payload struct {
		TaskToken string `json:"taskToken"`
	}
	if StepFunctionsTaskToken(payload{TaskToken: "e"}) != "e" {
		t.Fatal("expected token to be extracted from struct via marshal/unmarshal")
	}
}
