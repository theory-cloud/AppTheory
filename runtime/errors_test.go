package apptheory

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestStatusForErrorCode(t *testing.T) {
	tests := map[string]int{
		errorCodeBadRequest:       400,
		errorCodeValidationFailed: 400,
		errorCodeUnauthorized:     401,
		errorCodeForbidden:        403,
		errorCodeNotFound:         404,
		errorCodeMethodNotAllowed: 405,
		errorCodeConflict:         409,
		errorCodeTooLarge:         413,
		errorCodeTimeout:          408,
		errorCodeRateLimited:      429,
		errorCodeOverloaded:       503,
		errorCodeInternal:         500,
		"unknown":                 500,
	}

	for code, want := range tests {
		if got := statusForErrorCode(code); got != want {
			t.Fatalf("statusForErrorCode(%q) = %d, want %d", code, got, want)
		}
	}
}

func TestErrorResponseWithRequestID(t *testing.T) {
	resp := errorResponseWithRequestID(errorCodeNotFound, errorMessageNotFound, map[string][]string{"X-Test": {"a"}}, "req_123")
	if resp.Status != 404 {
		t.Fatalf("expected status 404, got %d", resp.Status)
	}
	if ct := resp.Headers["content-type"]; len(ct) != 1 || ct[0] != "application/json; charset=utf-8" {
		t.Fatalf("unexpected content-type: %v", ct)
	}
	if got := resp.Headers["x-test"]; len(got) != 1 || got[0] != "a" {
		t.Fatalf("expected canonicalized header x-test=a, got %v", got)
	}

	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	errObj, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("unexpected error shape: %v", body["error"])
	}
	if errObj["code"] != errorCodeNotFound || errObj["message"] != errorMessageNotFound || errObj["request_id"] != "req_123" {
		t.Fatalf("unexpected error body: %v", errObj)
	}
}

func TestResponseForError(t *testing.T) {
	out := responseForError(&AppError{Code: errorCodeForbidden, Message: errorMessageForbidden})
	if out.Status != 403 {
		t.Fatalf("expected 403, got %d", out.Status)
	}

	out = responseForError(errors.New("boom"))
	if out.Status != 500 {
		t.Fatalf("expected 500, got %d", out.Status)
	}
}
