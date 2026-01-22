package main

import (
	"errors"
	"testing"
)

func TestAppError_Error_IncludesCodeAndMessage(t *testing.T) {
	err := (&AppError{Code: "app.test", Message: "boom"}).Error()
	if err != "app.test: boom" {
		t.Fatalf("unexpected Error(): %q", err)
	}
}

func TestMissingRouteResponse_ReturnsNotFoundWhenNoAllowedMethods(t *testing.T) {
	resp, code := missingRouteResponse(nil, "req-1")
	if resp.Status != 404 || code != appErrorNotFound {
		t.Fatalf("expected 404/app.not_found, got %d/%s", resp.Status, code)
	}
}

func TestMissingRouteResponse_ReturnsMethodNotAllowedWithAllowHeader(t *testing.T) {
	resp, code := missingRouteResponse([]string{"get", "POST", "GET", ""}, "req-1")
	if resp.Status != 405 || code != appErrorMethodNotAllowed {
		t.Fatalf("expected 405/app.method_not_allowed, got %d/%s", resp.Status, code)
	}
	if got := firstHeaderValue(resp.Headers, "allow"); got != "GET, POST" {
		t.Fatalf("expected allow header to be canonicalized, got %q", got)
	}
}

func TestResponseForHandlerError_UsesAppErrorCode(t *testing.T) {
	resp, code := responseForHandlerError(&AppError{Code: appErrorBadRequest, Message: msgInvalidJSON}, "req-1")
	if code != appErrorBadRequest || resp.Status != 400 {
		t.Fatalf("expected 400/app.bad_request, got %d/%s", resp.Status, code)
	}
}

func TestResponseForHandlerError_MapsUnknownErrorToInternal(t *testing.T) {
	resp, code := responseForHandlerError(errors.New("boom"), "req-1")
	if code != appErrorInternal || resp.Status != 500 {
		t.Fatalf("expected 500/app.internal, got %d/%s", resp.Status, code)
	}
}

func TestJSONContentType_DetectsApplicationJSON(t *testing.T) {
	if jsonContentType(map[string][]string{"content-type": {"application/json; charset=utf-8"}}) != true {
		t.Fatal("expected json content type")
	}
	if jsonContentType(map[string][]string{"content-type": {"text/plain"}}) != false {
		t.Fatal("did not expect json content type")
	}
}
