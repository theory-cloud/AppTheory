package apptheory

import (
	"encoding/json"
	"fmt"
	"strings"
)

// HTML builds a text/html response (utf-8).
//
// body supports string and []byte inputs.
func HTML(status int, body any) *Response {
	var bytes []byte
	switch v := body.(type) {
	case nil:
		bytes = nil
	case string:
		bytes = []byte(v)
	case []byte:
		bytes = append([]byte(nil), v...)
	default:
		panic(fmt.Sprintf("apptheory: html body must be string or []byte (got %T)", body))
	}

	return &Response{
		Status: status,
		Headers: map[string][]string{
			"content-type": {"text/html; charset=utf-8"},
		},
		Cookies:  nil,
		Body:     bytes,
		IsBase64: false,
	}
}

// HTMLStream builds a streaming text/html response (utf-8).
func HTMLStream(status int, stream BodyStream) *Response {
	return &Response{
		Status: status,
		Headers: map[string][]string{
			"content-type": {"text/html; charset=utf-8"},
		},
		Cookies:    nil,
		Body:       nil,
		BodyStream: stream,
		IsBase64:   false,
	}
}

// SafeJSONForHTML serializes a value as JSON with escaping suitable for embedding into HTML.
//
// It escapes `<`, `>`, `&`, U+2028, and U+2029 to prevent script-breaking sequences and cross-language drift.
func SafeJSONForHTML(value any) (string, error) {
	b, err := json.Marshal(value)
	if err != nil {
		return "", err
	}

	replacer := strings.NewReplacer(
		"&", "\\u0026",
		"<", "\\u003c",
		">", "\\u003e",
		"\u2028", "\\u2028",
		"\u2029", "\\u2029",
	)
	return replacer.Replace(string(b)), nil
}
