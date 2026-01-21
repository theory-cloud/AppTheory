package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory"
)

type streamCapturedResponse struct {
	Response         apptheory.Response
	Chunks           [][]byte
	StreamErrorCode  string
	StreamErrorCause error
}

func runFixtureM14(f Fixture) error {
	now := time.Unix(0, 0).UTC()
	app := newAppTheoryFixtureAppP1(now, f.Setup.Limits, f.Setup.CORS)

	for _, name := range f.Setup.Middlewares {
		mw := builtInM12Middleware(name)
		if mw == nil {
			return &apptheory.AppError{Code: "app.internal", Message: "internal error"}
		}
		app.Use(mw)
	}

	for _, r := range f.Setup.Routes {
		handler := builtInAppTheoryHandler(r.Handler)
		if handler == nil {
			return &apptheory.AppError{Code: "app.internal", Message: "internal error"}
		}
		var opts []apptheory.RouteOption
		if r.AuthRequired {
			opts = append(opts, apptheory.RequireAuth())
		}
		app.Handle(r.Method, r.Path, handler, opts...)
	}

	if f.Input.Request == nil {
		return &apptheory.AppError{Code: "app.internal", Message: "internal error"}
	}

	bodyBytes, err := decodeFixtureBody(f.Input.Request.Body)
	if err != nil {
		return err
	}

	req := apptheory.Request{
		Method:   f.Input.Request.Method,
		Path:     f.Input.Request.Path,
		Query:    f.Input.Request.Query,
		Headers:  f.Input.Request.Headers,
		Body:     bodyBytes,
		IsBase64: f.Input.Request.IsBase64,
	}

	ctx, cancel := fixtureContext(now, f.Input.Context.RemainingMS)
	if cancel != nil {
		defer cancel()
	}

	actual := app.Serve(ctx, req)
	captured, err := captureStreamResponse(ctx, actual)
	if err != nil {
		return err
	}

	return compareFixtureStreamResponse(f, captured, nil, nil, nil)
}

func captureStreamResponse(ctx context.Context, resp apptheory.Response) (streamCapturedResponse, error) {
	var chunks [][]byte
	var body []byte

	if len(resp.Body) > 0 {
		prefix := append([]byte(nil), resp.Body...)
		chunks = append(chunks, prefix)
		body = append(body, prefix...)
	}

	if resp.BodyReader != nil {
		b, err := io.ReadAll(resp.BodyReader)
		if err != nil {
			return streamCapturedResponse{}, err
		}
		if len(b) > 0 {
			copied := append([]byte(nil), b...)
			chunks = append(chunks, copied)
			body = append(body, copied...)
		}
		resp.BodyReader = nil
	}

	var streamErr error
	if resp.BodyStream != nil {
		streamChunks, streamBody, err := apptheory.CaptureBodyStream(ctx, resp.BodyStream)
		chunks = append(chunks, streamChunks...)
		body = append(body, streamBody...)
		streamErr = err
		resp.BodyStream = nil
	}

	resp.Body = body

	captured := streamCapturedResponse{
		Response:         resp,
		Chunks:           chunks,
		StreamErrorCode:  streamErrorCode(streamErr),
		StreamErrorCause: streamErr,
	}
	return captured, nil
}

func streamErrorCode(err error) string {
	if err == nil {
		return ""
	}
	var appErr *apptheory.AppError
	if errors.As(err, &appErr) && strings.TrimSpace(appErr.Code) != "" {
		return strings.TrimSpace(appErr.Code)
	}
	return "app.internal"
}

func compareFixtureStreamResponse(
	f Fixture,
	actual streamCapturedResponse,
	logs []FixtureLogRecord,
	metrics []FixtureMetricRecord,
	spans []FixtureSpanRecord,
) error {
	if f.Expect.Response == nil {
		return fmt.Errorf("fixture missing expect.response")
	}
	expected := *f.Expect.Response

	expectedHeaders := canonicalizeHeaders(expected.Headers)
	actualHeaders := canonicalizeHeaders(actual.Response.Headers)

	if err := compareFixtureResponseMeta(expected, actual.Response, expectedHeaders, actualHeaders); err != nil {
		return err
	}

	if expected.StreamErrorCode != "" {
		if expected.StreamErrorCode != actual.StreamErrorCode {
			return fmt.Errorf("stream_error_code: expected %q, got %q", expected.StreamErrorCode, actual.StreamErrorCode)
		}
	} else if actual.StreamErrorCode != "" {
		return fmt.Errorf("stream_error_code: expected empty, got %q", actual.StreamErrorCode)
	}

	if err := compareFixtureStreamResponseBody(expected, actual); err != nil {
		return err
	}

	return compareFixtureSideEffects(f.Expect, logs, metrics, spans)
}

func compareFixtureStreamResponseBody(expected FixtureResponse, actual streamCapturedResponse) error {
	if len(expected.BodyJSON) > 0 {
		return compareFixtureStreamResponseBodyJSON(expected.BodyJSON, actual.Response.Body)
	}

	if len(expected.Chunks) > 0 {
		return compareFixtureStreamResponseChunks(expected, actual)
	}

	return compareFixtureStreamResponseBodyBytes(expected.Body, actual.Response.Body)
}

func compareFixtureStreamResponseBodyJSON(expectedJSONRaw json.RawMessage, actualBody []byte) error {
	var expectedJSON any
	if err := json.Unmarshal(expectedJSONRaw, &expectedJSON); err != nil {
		return fmt.Errorf("parse expected body_json: %w", err)
	}
	var actualJSON any
	if err := json.Unmarshal(actualBody, &actualJSON); err != nil {
		return fmt.Errorf("parse actual response body as json: %w", err)
	}
	if !jsonEqual(expectedJSON, actualJSON) {
		return fmt.Errorf("body_json mismatch")
	}
	return nil
}

func compareFixtureStreamResponseChunks(expected FixtureResponse, actual streamCapturedResponse) error {
	expectedChunks, expectedBody, err := decodeFixtureChunks(expected.Chunks)
	if err != nil {
		return err
	}

	if len(expectedChunks) != len(actual.Chunks) {
		return fmt.Errorf("chunks length: expected %d, got %d", len(expectedChunks), len(actual.Chunks))
	}
	for i := range expectedChunks {
		if !equalBytes(expectedChunks[i], actual.Chunks[i]) {
			return fmt.Errorf("chunk %d mismatch", i)
		}
	}

	if expected.Body != nil {
		expectedBody, err = decodeFixtureBody(*expected.Body)
		if err != nil {
			return fmt.Errorf("decode expected body: %w", err)
		}
	}

	if !equalBytes(expectedBody, actual.Response.Body) {
		return fmt.Errorf("body mismatch")
	}
	return nil
}

func decodeFixtureChunks(chunks []FixtureBody) ([][]byte, []byte, error) {
	expectedChunks := make([][]byte, 0, len(chunks))
	var expectedBody []byte
	for _, c := range chunks {
		b, err := decodeFixtureBody(c)
		if err != nil {
			return nil, nil, fmt.Errorf("decode expected chunk: %w", err)
		}
		expectedChunks = append(expectedChunks, b)
		expectedBody = append(expectedBody, b...)
	}
	return expectedChunks, expectedBody, nil
}

func compareFixtureStreamResponseBodyBytes(expectedBody *FixtureBody, actualBody []byte) error {
	var expectedBodyBytes []byte
	if expectedBody != nil {
		var err error
		expectedBodyBytes, err = decodeFixtureBody(*expectedBody)
		if err != nil {
			return fmt.Errorf("decode expected body: %w", err)
		}
	}
	if !equalBytes(expectedBodyBytes, actualBody) {
		return fmt.Errorf("body mismatch")
	}
	return nil
}
