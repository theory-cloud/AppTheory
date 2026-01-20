package apptheory

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// SSEEvent is a Server-Sent Events (SSE) message.
//
// Framing rules:
// - Optional: "id: <id>\n"
// - Optional: "event: <event>\n"
// - Data: one "data: <line>\n" per line (at least one line)
// - Terminator: "\n"
type SSEEvent struct {
	ID    string
	Event string
	Data  any
}

func sseDataString(value any) (string, error) {
	if value == nil {
		return "", nil
	}
	switch v := value.(type) {
	case string:
		return v, nil
	case []byte:
		return string(v), nil
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return "", fmt.Errorf("apptheory: sse json marshal: %w", err)
		}
		return string(b), nil
	}
}

func formatSSEEvent(event SSEEvent) ([]byte, error) {
	var buf bytes.Buffer

	id := strings.TrimSpace(event.ID)
	if id != "" {
		buf.WriteString("id: ")
		buf.WriteString(id)
		buf.WriteByte('\n')
	}

	name := strings.TrimSpace(event.Event)
	if name != "" {
		buf.WriteString("event: ")
		buf.WriteString(name)
		buf.WriteByte('\n')
	}

	data, err := sseDataString(event.Data)
	if err != nil {
		return nil, err
	}

	data = strings.ReplaceAll(data, "\r\n", "\n")
	data = strings.ReplaceAll(data, "\r", "\n")
	lines := strings.Split(data, "\n")
	if len(lines) == 0 {
		lines = []string{""}
	}
	for _, line := range lines {
		buf.WriteString("data: ")
		buf.WriteString(line)
		buf.WriteByte('\n')
	}

	buf.WriteByte('\n')
	return buf.Bytes(), nil
}

// SSEResponse builds a canonical AppTheory Response with properly framed SSE output.
func SSEResponse(status int, events ...SSEEvent) (*Response, error) {
	var buf bytes.Buffer
	for _, ev := range events {
		b, err := formatSSEEvent(ev)
		if err != nil {
			return nil, err
		}
		buf.Write(b)
	}
	return &Response{
		Status: status,
		Headers: map[string][]string{
			"content-type":  {"text/event-stream"},
			"cache-control": {"no-cache"},
			"connection":    {"keep-alive"},
		},
		Cookies:  nil,
		Body:     buf.Bytes(),
		IsBase64: false,
	}, nil
}

// MustSSEResponse builds an SSE response and panics on framing/serialization errors.
func MustSSEResponse(status int, events ...SSEEvent) *Response {
	resp, err := SSEResponse(status, events...)
	if err != nil {
		panic(err)
	}
	return resp
}
