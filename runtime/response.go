package apptheory

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// errDualBodyResponse is the sentinel error normalizeResponse returns when a
// handler response carries both a non-empty buffered body and a streaming
// body. The serve path routes it through respondToServeError (exactly like the
// TS normalizeResponse throw and the Py normalize_response raise), so the
// fail-closed response is produced by the error pipeline with the request id,
// the AppSync envelope when serving AppSync, and P2 observability — not by an
// inline errorResponse that bypasses all three.
var errDualBodyResponse = errors.New("apptheory: response cannot carry both a buffered body and a streaming body")

// Response is the canonical HTTP response model returned by AppTheory handlers.
type Response struct {
	Status int
	// Headers are canonicalized to lowercase keys during response normalization.
	// Treat header names as case-insensitive and prefer lowercase when accessing values.
	Headers map[string][]string
	// Cookies contains raw Set-Cookie header values. If you also provide a "set-cookie"
	// header in Headers, normalization merges it into Cookies.
	Cookies    []string
	Body       []byte
	BodyReader io.Reader
	BodyStream BodyStream
	IsBase64   bool
}

// Text builds a text/plain response (utf-8).
func Text(status int, body string) *Response {
	return &Response{
		Status: status,
		Headers: map[string][]string{
			"content-type": {"text/plain; charset=utf-8"},
		},
		Body:     []byte(body),
		IsBase64: false,
	}
}

// JSON builds an application/json response (utf-8).
func JSON(status int, value any) (*Response, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return &Response{
		Status: status,
		Headers: map[string][]string{
			"content-type": {"application/json; charset=utf-8"},
		},
		Body:     body,
		IsBase64: false,
	}, nil
}

// CreatedJSON builds a 201 application/json response (utf-8).
func CreatedJSON(value any) (*Response, error) {
	return JSON(201, value)
}

// MustJSON builds an application/json response (utf-8) and panics on marshal failure.
func MustJSON(status int, value any) *Response {
	resp, err := JSON(status, value)
	if err != nil {
		panic(err)
	}
	return resp
}

// Binary builds a base64-encoded response for binary body content.
func Binary(status int, body []byte, contentType string) *Response {
	headers := map[string][]string{}
	if contentType != "" {
		headers["content-type"] = []string{contentType}
	}
	return &Response{
		Status:   status,
		Headers:  headers,
		Body:     append([]byte(nil), body...),
		IsBase64: true,
	}
}

// NoContent builds an empty 204 response.
func NoContent() *Response {
	return &Response{Status: 204}
}

// SetHeader sets a single response header value and returns the response.
func (r *Response) SetHeader(name string, value string) *Response {
	if r == nil {
		return nil
	}
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return r
	}
	if r.Headers == nil {
		r.Headers = map[string][]string{}
	}
	r.Headers[name] = []string{value}
	return r
}

func normalizeResponse(in *Response) (Response, error) {
	if in == nil {
		return errorResponse(errorCodeInternal, errorMessageInternal, nil), nil
	}
	out := *in
	if out.Status == 0 {
		out.Status = 200
	}
	// A response must carry exactly one body representation. A buffered body
	// combined with a streaming body is divergent: the buffered adapters drain
	// the stream and replace the buffered body, while the v1 streaming adapter
	// composes Body + BodyReader and ignores BodyStream entirely. The same
	// handler response would produce different wire bytes on different
	// adapters, so the normalizer fails closed on the ambiguous shape instead
	// of letting adapters silently pick one representation. The failure is
	// signaled as a sentinel error so the serve path routes it through the
	// established serve-error pipeline (request id, AppSync envelope, P2
	// observability), mirroring the TS throw and Py raise on the same shape.
	if len(out.Body) > 0 && (out.BodyReader != nil || out.BodyStream != nil) {
		return Response{}, errDualBodyResponse
	}
	out.Headers = canonicalizeHeaders(out.Headers)
	if setCookies := out.Headers["set-cookie"]; len(setCookies) > 0 {
		out.Cookies = append(append([]string(nil), out.Cookies...), setCookies...)
		delete(out.Headers, "set-cookie")
	}
	out.Body = append([]byte(nil), out.Body...)
	if out.Cookies != nil {
		out.Cookies = append([]string(nil), out.Cookies...)
	}
	return out, nil
}
