package apptheory

import (
	"encoding/json"
	"io"
)

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

func normalizeResponse(in *Response) Response {
	if in == nil {
		return errorResponse(errorCodeInternal, errorMessageInternal, nil)
	}
	out := *in
	if out.Status == 0 {
		out.Status = 200
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
	return out
}
