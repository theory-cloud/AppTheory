package apptheory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
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

// SSEStreamResponse builds a canonical AppTheory Response with event-by-event SSE output.
//
// The returned response uses response streaming when invoked through the API Gateway REST API v1 adapter
// (`ServeAPIGatewayProxy` via `HandleLambda`).
func SSEStreamResponse(ctx context.Context, status int, events <-chan SSEEvent) (*Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()

		if events == nil {
			return
		}

		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-events:
				if !ok {
					return
				}

				b, err := formatSSEEvent(ev)
				if err != nil {
					_ = pw.CloseWithError(err)
					return
				}

				if _, err := pw.Write(b); err != nil {
					_ = pw.CloseWithError(err)
					return
				}
			}
		}
	}()

	return &Response{
		Status: status,
		Headers: map[string][]string{
			"content-type":  {"text/event-stream"},
			"cache-control": {"no-cache"},
			"connection":    {"keep-alive"},
		},
		Cookies:    nil,
		Body:       nil,
		BodyReader: pr,
		IsBase64:   false,
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
