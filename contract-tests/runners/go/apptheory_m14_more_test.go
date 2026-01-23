package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func TestStreamErrorCode_Variants(t *testing.T) {
	t.Parallel()

	if got := streamErrorCode(nil); got != "" {
		t.Fatalf("expected empty code for nil error, got %q", got)
	}
	if got := streamErrorCode(errors.New("boom")); got != "app.internal" {
		t.Fatalf("expected internal code for non-app error, got %q", got)
	}
	if got := streamErrorCode(&apptheory.AppError{Code: " app.test ", Message: "x"}); got != "app.test" {
		t.Fatalf("expected trimmed app error code, got %q", got)
	}
	if got := streamErrorCode(&apptheory.AppError{Code: "   ", Message: "x"}); got != "app.internal" {
		t.Fatalf("expected internal code for blank app error code, got %q", got)
	}
}

func TestCaptureStreamResponse_CapturesBodyReaderAndStream(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	resp := apptheory.Response{
		Status:     200,
		Body:       []byte("a"),
		BodyReader: strings.NewReader("b"),
		BodyStream: apptheory.StreamBytes([]byte("c"), []byte{}),
	}

	captured, err := captureStreamResponse(ctx, resp)
	if err != nil {
		t.Fatalf("captureStreamResponse: %v", err)
	}
	if string(captured.Response.Body) != "abc" {
		t.Fatalf("expected concatenated body abc, got %q", string(captured.Response.Body))
	}
	if captured.Response.BodyReader != nil || captured.Response.BodyStream != nil {
		t.Fatalf("expected BodyReader/BodyStream to be cleared, got %#v", captured.Response)
	}
	if len(captured.Chunks) != 4 || string(captured.Chunks[0]) != "a" || string(captured.Chunks[1]) != "b" || string(captured.Chunks[2]) != "c" {
		t.Fatalf("unexpected chunks: %#v", captured.Chunks)
	}

	captured, err = captureStreamResponse(ctx, apptheory.Response{
		Status:     200,
		BodyStream: apptheory.StreamError(&apptheory.AppError{Code: "app.stream", Message: "boom"}),
	})
	if err != nil {
		t.Fatalf("captureStreamResponse(stream error): %v", err)
	}
	if captured.StreamErrorCode != "app.stream" || captured.StreamErrorCause == nil {
		t.Fatalf("expected stream error to be captured, got %#v", captured)
	}
}

func TestCompareFixtureStreamResponse_MissingExpectedResponseAndStreamErrorMismatch(t *testing.T) {
	t.Parallel()

	if err := compareFixtureStreamResponse(Fixture{Expect: FixtureExpect{Response: nil}}, streamCapturedResponse{}, nil, nil, nil); err == nil {
		t.Fatal("expected missing expect.response error")
	}

	f := Fixture{
		Expect: FixtureExpect{
			Response: &FixtureResponse{Status: 200, StreamErrorCode: "app.expected"},
		},
	}
	actual := streamCapturedResponse{
		Response:        apptheory.Response{Status: 200},
		StreamErrorCode: "app.actual",
	}
	if err := compareFixtureStreamResponse(f, actual, nil, nil, nil); err == nil || !strings.Contains(err.Error(), "stream_error_code") {
		t.Fatalf("expected stream error mismatch error, got %v", err)
	}

	f.Expect.Response.StreamErrorCode = ""
	if err := compareFixtureStreamResponse(f, actual, nil, nil, nil); err == nil || !strings.Contains(err.Error(), "expected empty") {
		t.Fatalf("expected unexpected stream error code error, got %v", err)
	}
}

func TestCompareFixtureStreamResponseBodyJSON_ErrorsAndMismatchAndMatch(t *testing.T) {
	t.Parallel()

	if err := compareFixtureStreamResponseBodyJSON([]byte(`{`), []byte(`{}`)); err == nil {
		t.Fatal("expected parse expected body_json error")
	}
	if err := compareFixtureStreamResponseBodyJSON([]byte(`{"ok":true}`), []byte(`{`)); err == nil {
		t.Fatal("expected parse actual response body error")
	}
	if err := compareFixtureStreamResponseBodyJSON([]byte(`{"ok":true}`), []byte(`{"ok":false}`)); err == nil {
		t.Fatal("expected body_json mismatch")
	}
	if err := compareFixtureStreamResponseBodyJSON([]byte(`{"ok":true}`), []byte(`{"ok":true}`)); err != nil {
		t.Fatalf("expected match, got %v", err)
	}
}

func TestCompareFixtureStreamResponseChunks_CoversErrorBranches(t *testing.T) {
	t.Parallel()

	expected := FixtureResponse{
		Status: 200,
		Chunks: []FixtureBody{{Encoding: "nope", Value: ""}},
	}
	actual := streamCapturedResponse{Response: apptheory.Response{Status: 200}}
	if err := compareFixtureStreamResponseChunks(expected, actual); err == nil || !strings.Contains(err.Error(), "decode expected chunk") {
		t.Fatalf("expected chunk decode error, got %v", err)
	}

	expected = FixtureResponse{
		Status: 200,
		Chunks: []FixtureBody{{Encoding: "utf8", Value: "a"}},
	}
	actual = streamCapturedResponse{
		Response: apptheory.Response{Status: 200, Body: []byte("a")},
		Chunks:   [][]byte{[]byte("a"), []byte("b")},
	}
	if err := compareFixtureStreamResponseChunks(expected, actual); err == nil || !strings.Contains(err.Error(), "chunks length") {
		t.Fatalf("expected chunks length error, got %v", err)
	}

	actual = streamCapturedResponse{
		Response: apptheory.Response{Status: 200, Body: []byte("a")},
		Chunks:   [][]byte{[]byte("b")},
	}
	if err := compareFixtureStreamResponseChunks(expected, actual); err == nil || !strings.Contains(err.Error(), "chunk 0 mismatch") {
		t.Fatalf("expected chunk mismatch error, got %v", err)
	}

	expected.Body = &FixtureBody{Encoding: "base64", Value: "!!!"}
	actual = streamCapturedResponse{
		Response: apptheory.Response{Status: 200, Body: []byte("a")},
		Chunks:   [][]byte{[]byte("a")},
	}
	if err := compareFixtureStreamResponseChunks(expected, actual); err == nil || !strings.Contains(err.Error(), "decode expected body") {
		t.Fatalf("expected body decode error, got %v", err)
	}

	expected.Body = &FixtureBody{Encoding: "utf8", Value: "b"}
	if err := compareFixtureStreamResponseChunks(expected, actual); err == nil || !strings.Contains(err.Error(), "body mismatch") {
		t.Fatalf("expected body mismatch error, got %v", err)
	}

	expected.Body = &FixtureBody{Encoding: "utf8", Value: "a"}
	if err := compareFixtureStreamResponseChunks(expected, actual); err != nil {
		t.Fatalf("expected chunks/body match, got %v", err)
	}
}

func TestCompareFixtureStreamResponseBodyBytes_CoversDecodeAndMismatch(t *testing.T) {
	t.Parallel()

	if err := compareFixtureStreamResponseBodyBytes(&FixtureBody{Encoding: "base64", Value: "!!!"}, []byte("")); err == nil {
		t.Fatal("expected decode error")
	}
	if err := compareFixtureStreamResponseBodyBytes(&FixtureBody{Encoding: "utf8", Value: "a"}, []byte("b")); err == nil {
		t.Fatal("expected mismatch error")
	}
	if err := compareFixtureStreamResponseBodyBytes(&FixtureBody{Encoding: "utf8", Value: "a"}, []byte("a")); err != nil {
		t.Fatalf("expected match, got %v", err)
	}
	if err := compareFixtureStreamResponseBodyBytes(nil, nil); err != nil {
		t.Fatalf("expected nil expected body to match nil actual body, got %v", err)
	}
}
