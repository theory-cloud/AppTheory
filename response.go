package apptheory

import "encoding/json"

// Response is the canonical HTTP response model returned by AppTheory handlers.
type Response struct {
	Status   int
	Headers  map[string][]string
	Cookies  []string
	Body     []byte
	IsBase64 bool
}

// Text builds a text/plain response (utf-8).
func Text(status int, body string) *Response {
	return &Response{
		Status: status,
		Headers: map[string][]string{
			"content-type": []string{"text/plain; charset=utf-8"},
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
			"content-type": []string{"application/json; charset=utf-8"},
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
		return errorResponse("app.internal", "internal error", nil)
	}
	out := *in
	if out.Status == 0 {
		out.Status = 200
	}
	out.Headers = canonicalizeHeaders(out.Headers)
	out.Body = append([]byte(nil), out.Body...)
	if out.Cookies != nil {
		out.Cookies = append([]string(nil), out.Cookies...)
	}
	return out
}
