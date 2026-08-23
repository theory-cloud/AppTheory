package apptheory

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestText(t *testing.T) {
	resp := Text(200, "hello")
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	if ct := resp.Headers["content-type"]; len(ct) != 1 || ct[0] != "text/plain; charset=utf-8" {
		t.Fatalf("unexpected content-type: %v", ct)
	}
	if string(resp.Body) != "hello" {
		t.Fatalf("unexpected body: %q", string(resp.Body))
	}
	if resp.IsBase64 {
		t.Fatal("expected IsBase64=false")
	}
}

func TestJSONAndMustJSON(t *testing.T) {
	resp, err := JSON(201, map[string]any{"ok": true})
	if err != nil {
		t.Fatalf("JSON returned error: %v", err)
	}
	if resp.Status != 201 {
		t.Fatalf("expected status 201, got %d", resp.Status)
	}

	var parsed map[string]any
	if err := json.Unmarshal(resp.Body, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if parsed["ok"] != true {
		t.Fatalf("expected ok=true, got %v", parsed["ok"])
	}

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected MustJSON to panic for non-marshalable value")
		}
	}()
	_ = MustJSON(200, func() {})
}

func TestCreatedJSONNoContentAndSetHeader(t *testing.T) {
	resp, err := CreatedJSON(map[string]any{"created": true})
	if err != nil {
		t.Fatalf("CreatedJSON returned error: %v", err)
	}
	if resp.Status != 201 {
		t.Fatalf("expected status 201, got %d", resp.Status)
	}

	noContent := NoContent().SetHeader("X-Test", "ok")
	if noContent.Status != 204 {
		t.Fatalf("expected status 204, got %d", noContent.Status)
	}
	if got := noContent.Headers["x-test"]; len(got) != 1 || got[0] != "ok" {
		t.Fatalf("unexpected x-test header: %v", got)
	}

	var nilResp *Response
	if got := nilResp.SetHeader("x-test", "ignored"); got != nil {
		t.Fatalf("expected nil SetHeader receiver to stay nil, got %#v", got)
	}
}

func TestBinaryCopiesBody(t *testing.T) {
	body := []byte{0x01, 0x02, 0x03}
	resp := Binary(200, body, "application/octet-stream")
	body[0] = 0xff
	if resp.Body[0] == 0xff {
		t.Fatal("expected Binary to copy body bytes")
	}
	if !resp.IsBase64 {
		t.Fatal("expected IsBase64=true")
	}
	if ct := resp.Headers["content-type"]; len(ct) != 1 || ct[0] != "application/octet-stream" {
		t.Fatalf("unexpected content-type: %v", ct)
	}
}

func TestNormalizeResponse(t *testing.T) {
	out, err := normalizeResponse(nil)
	if err != nil {
		t.Fatalf("unexpected error for nil response: %v", err)
	}
	if out.Status != 500 {
		t.Fatalf("expected status 500 for nil response, got %d", out.Status)
	}

	in := &Response{
		Status: 0,
		Headers: map[string][]string{
			"X-Test":     {"a"},
			"set-cookie": {"a=b; Path=/", "c=d; Path=/"},
		},
		Cookies: []string{"e=f; Path=/"},
		Body:    []byte("hi"),
	}
	n, err := normalizeResponse(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n.Status != 200 {
		t.Fatalf("expected default status 200, got %d", n.Status)
	}
	if _, ok := n.Headers["set-cookie"]; ok {
		t.Fatal("expected set-cookie to be removed from headers")
	}
	if got := n.Headers["x-test"]; len(got) != 1 || got[0] != "a" {
		t.Fatalf("unexpected x-test header: %v", got)
	}
	if len(n.Cookies) != 3 {
		t.Fatalf("expected 3 cookies, got %v", n.Cookies)
	}
	// Ensure slices are copied.
	in.Body[0] = 'X'
	if string(n.Body) == string(in.Body) {
		t.Fatal("expected normalizeResponse to copy body bytes")
	}
	in.Cookies[0] = "mutated"
	if n.Cookies[0] == "mutated" {
		t.Fatal("expected normalizeResponse to copy cookies slice")
	}
}

func TestNormalizeResponse_FailsClosedOnDualBodyDivergence(t *testing.T) {
	// A response carrying both a non-empty buffered body and a streaming body
	// is divergent: the buffered adapters drain the stream and replace the
	// buffered body, while the v1 streaming adapter composes Body + BodyReader
	// and ignores BodyStream. The normalizer must fail closed instead of
	// letting adapters silently pick one representation.
	for _, tc := range []struct {
		name string
		in   *Response
	}{
		{name: "body plus body reader", in: &Response{Status: 200, Body: []byte("head"), BodyReader: strings.NewReader("tail")}},
		{name: "body plus body stream", in: &Response{Status: 200, Body: []byte("head"), BodyStream: StreamBytes([]byte("tail"))}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := normalizeResponse(tc.in)
			if !errors.Is(err, errDualBodyResponse) {
				t.Fatalf("expected errDualBodyResponse sentinel, got %v", err)
			}
			// The serve path turns the sentinel into the established error
			// shape; the normalizer itself signals rather than formatting.
			if out.Status != 0 {
				t.Fatalf("expected zero-value response on sentinel error, got %#v", out)
			}
			if code := errorCodeForError(err); code != errorCodeInternal {
				t.Fatalf("expected app.internal code from sentinel, got %q", code)
			}
		})
	}
}

func TestServe_DualBodyFailsClosedThroughServeErrorPipeline(t *testing.T) {
	// The fail-closed dual-body response must route through the serve-error
	// pipeline exactly like the TS throw and Py raise: the portable error body
	// carries the request id, and P2 observability records errorCode
	// app.internal instead of the empty string the inline errorResponse
	// produced at PR head.
	var gotLog *LogRecord
	app := New(
		WithTier(TierP2),
		WithObservability(ObservabilityHooks{
			Log: func(r LogRecord) {
				copy := r
				gotLog = &copy
			},
		}),
	)
	app.Get("/dual", func(_ *Context) (*Response, error) {
		return &Response{
			Status:     200,
			Headers:    map[string][]string{"content-type": {"text/html; charset=utf-8"}},
			Body:       []byte("buffered"),
			BodyStream: StreamBytes([]byte("streamed")),
		}, nil
	})

	resp := app.Serve(context.Background(), Request{
		Method:  "GET",
		Path:    "/dual",
		Headers: map[string][]string{"x-request-id": {"req_dual_1"}},
	})

	if resp.Status != 500 {
		t.Fatalf("expected fail-closed status 500, got %d", resp.Status)
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal error body: %v", err)
	}
	errorBody, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected nested error body, got %#v", body)
	}
	if errorBody["code"] != errorCodeInternal || errorBody["message"] != errorMessageInternal {
		t.Fatalf("unexpected error body: %#v", errorBody)
	}
	if errorBody["request_id"] != "req_dual_1" {
		t.Fatalf("expected request_id in portable error body, got %#v", errorBody)
	}

	if gotLog == nil {
		t.Fatal("expected P2 observability record for dual-body failure")
	}
	if gotLog.ErrorCode != errorCodeInternal {
		t.Fatalf("expected observability errorCode app.internal, got %q", gotLog.ErrorCode)
	}
	if gotLog.Status != 500 || gotLog.Method != "GET" || gotLog.Path != "/dual" {
		t.Fatalf("unexpected observability record: %+v", gotLog)
	}
}
