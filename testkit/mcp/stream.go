package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	mcpruntime "github.com/theory-cloud/apptheory/runtime/mcp"
)

// SSEMessage is a parsed Server-Sent Events frame.
//
// For MCP Streamable HTTP, Data is typically a single JSON-RPC message.
type SSEMessage struct {
	ID    string
	Event string
	Data  json.RawMessage
}

// Stream represents an open SSE stream from an in-process MCP server.
//
// Cancel simulates a client disconnect.
type Stream struct {
	cancel context.CancelFunc
	resp   apptheory.Response
	reader *bufio.Reader
}

// Response returns the HTTP response metadata for the stream.
func (s *Stream) Response() apptheory.Response {
	return s.resp
}

// Cancel simulates a client disconnect by canceling the stream context.
func (s *Stream) Cancel() {
	if s == nil || s.cancel == nil {
		return
	}
	s.cancel()
}

// Next blocks until the next SSE message is available or the stream ends.
func (s *Stream) Next() (*SSEMessage, error) {
	if s == nil || s.reader == nil {
		return nil, errors.New("mcp stream: nil reader")
	}
	return ReadSSEMessage(s.reader)
}

// ReadAll reads all remaining SSE messages until EOF.
func (s *Stream) ReadAll() ([]SSEMessage, error) {
	if s == nil || s.reader == nil {
		return nil, errors.New("mcp stream: nil reader")
	}

	var out []SSEMessage
	for {
		msg, err := ReadSSEMessage(s.reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return out, nil
			}
			return nil, err
		}
		out = append(out, *msg)
	}
}

// ReadSSEMessage reads a single SSE message (one frame, terminated by a blank line).
func ReadSSEMessage(r *bufio.Reader) (*SSEMessage, error) {
	if r == nil {
		return nil, errors.New("mcp stream: nil bufio.Reader")
	}

	var (
		id        string
		eventName string
		dataLines []string
	)

	for {
		line, err := r.ReadString('\n')
		if err != nil {
			// If we haven't accumulated any bytes, treat as clean EOF.
			if errors.Is(err, io.EOF) && line == "" && id == "" && eventName == "" && len(dataLines) == 0 {
				return nil, io.EOF
			}
			return nil, err
		}

		if line == "\n" {
			break
		}

		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}

		// Comments (keepalive) start with ":".
		if strings.HasPrefix(line, ":") {
			continue
		}

		switch {
		case strings.HasPrefix(line, "id:"):
			id = strings.TrimSpace(strings.TrimPrefix(line, "id:"))
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			v := strings.TrimPrefix(line, "data:")
			v = strings.TrimPrefix(v, " ")
			dataLines = append(dataLines, v)
		default:
			// Ignore unknown fields for robustness.
		}
	}

	data := strings.Join(dataLines, "\n")
	return &SSEMessage{
		ID:    id,
		Event: eventName,
		Data:  json.RawMessage(data),
	}, nil
}

// RawStream sends a JSON-RPC request to POST /mcp with `Accept: text/event-stream` and
// returns a Stream for reading incremental SSE messages.
func (c *Client) RawStream(ctx context.Context, req *mcpruntime.Request, extraHeaders map[string][]string) (*Stream, error) {
	if c == nil {
		return nil, errors.New("mcp client: nil client")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	headers := map[string][]string{
		"content-type": {"application/json"},
		"accept":       {"application/json, text/event-stream"},
	}
	if c.sessionID != "" {
		headers["mcp-session-id"] = []string{c.sessionID}
		headers["mcp-protocol-version"] = []string{c.protocol}
	}
	for k, v := range extraHeaders {
		headers[strings.ToLower(strings.TrimSpace(k))] = append([]string(nil), v...)
	}

	streamCtx, cancel := context.WithCancel(ctx)
	httpReq := apptheory.Request{
		Method:  "POST",
		Path:    "/mcp",
		Headers: headers,
		Body:    body,
	}
	httpResp := c.env.Invoke(streamCtx, c.app, httpReq)

	if ids := httpResp.Headers["mcp-session-id"]; len(ids) > 0 && ids[0] != "" {
		c.sessionID = ids[0]
	}

	if httpResp.BodyReader == nil {
		cancel()
		return nil, fmt.Errorf("expected streaming BodyReader (status=%d content-type=%q)", httpResp.Status, firstHeaderForDebug(httpResp.Headers, "content-type"))
	}

	return &Stream{
		cancel: cancel,
		resp:   httpResp,
		reader: bufio.NewReader(httpResp.BodyReader),
	}, nil
}

// ResumeStream opens GET /mcp with Last-Event-ID and returns a Stream for replay/resume.
func (c *Client) ResumeStream(ctx context.Context, lastEventID string, extraHeaders map[string][]string) (*Stream, error) {
	if c == nil {
		return nil, errors.New("mcp client: nil client")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	lastEventID = strings.TrimSpace(lastEventID)
	if lastEventID == "" {
		return nil, errors.New("missing last event id")
	}

	headers := map[string][]string{
		"accept":         {"text/event-stream"},
		"last-event-id":  {lastEventID},
		"mcp-session-id": {c.sessionID},
	}
	if c.protocol != "" {
		headers["mcp-protocol-version"] = []string{c.protocol}
	}
	for k, v := range extraHeaders {
		headers[strings.ToLower(strings.TrimSpace(k))] = append([]string(nil), v...)
	}

	streamCtx, cancel := context.WithCancel(ctx)
	httpReq := apptheory.Request{
		Method:  "GET",
		Path:    "/mcp",
		Headers: headers,
	}
	httpResp := c.env.Invoke(streamCtx, c.app, httpReq)

	if httpResp.BodyReader == nil {
		cancel()
		return nil, fmt.Errorf("expected streaming BodyReader (status=%d content-type=%q)", httpResp.Status, firstHeaderForDebug(httpResp.Headers, "content-type"))
	}

	return &Stream{
		cancel: cancel,
		resp:   httpResp,
		reader: bufio.NewReader(httpResp.BodyReader),
	}, nil
}

func firstHeaderForDebug(headers map[string][]string, key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	values := headers[key]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
