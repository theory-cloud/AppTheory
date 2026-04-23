package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

func readSSEFrame(r *bufio.Reader) (string, error) {
	var b strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return b.String(), err
		}
		b.WriteString(line)
		if line == "\n" {
			return b.String(), nil
		}
	}
}

func TestToolsCallStreaming_StreamsProgressIncrementally(t *testing.T) {
	s := NewServer("test-server", "1.0.0")

	sessionID := initializeSession(t, s)

	firstEmitted := make(chan struct{})
	continueTool := make(chan struct{})

	if err := s.registry.RegisterStreamingTool(
		ToolDef{
			Name:        "slow_tool",
			Description: "Emits progress then blocks",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(ctx context.Context, _ json.RawMessage, emit func(SSEEvent)) (*ToolResult, error) {
			emit(SSEEvent{Data: map[string]any{"seq": 1}})
			close(firstEmitted)

			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-continueTool:
			}

			emit(SSEEvent{Data: map[string]any{"seq": 2}})
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	params := toolsCallParams{Name: "slow_tool", Arguments: json.RawMessage(`{}`)}
	params.Meta.ProgressToken = json.RawMessage(`"pt-123"`)

	body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsCall, Params: mustMarshal(t, params)})

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}

	if ids := resp.Headers["mcp-session-id"]; len(ids) == 0 || ids[0] == "" {
		t.Fatalf("expected mcp-session-id header to be set")
	}

	if resp.BodyReader == nil {
		t.Fatalf("expected streaming response BodyReader to be set")
	}

	reader := bufio.NewReader(resp.BodyReader)

	select {
	case <-firstEmitted:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first progress emission")
	}

	firstFrameCh := make(chan string, 1)
	firstFrameErrCh := make(chan error, 1)
	go func() {
		frame, err := readSSEFrame(reader)
		if err != nil {
			firstFrameErrCh <- err
			return
		}
		firstFrameCh <- frame
	}()

	var firstFrame string
	select {
	case firstFrame = <-firstFrameCh:
	case err := <-firstFrameErrCh:
		t.Fatalf("read first SSE frame: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first SSE frame")
	}

	if !strings.Contains(firstFrame, "event: message\n") {
		t.Fatalf("expected first frame to be message event, got:\n%s", firstFrame)
	}
	if !strings.Contains(firstFrame, `"method":"notifications/progress"`) {
		t.Fatalf("expected first frame to be progress notification, got:\n%s", firstFrame)
	}
	if !strings.Contains(firstFrame, `"progressToken":"pt-123"`) {
		t.Fatalf("expected first frame to contain progressToken, got:\n%s", firstFrame)
	}

	close(continueTool)

	restCh := make(chan []byte, 1)
	restErrCh := make(chan error, 1)
	go func() {
		b, err := io.ReadAll(reader)
		if err != nil {
			restErrCh <- err
			return
		}
		restCh <- b
	}()

	var rest []byte
	select {
	case rest = <-restCh:
	case err := <-restErrCh:
		t.Fatalf("read rest of SSE stream: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out reading rest of SSE stream")
	}

	all := firstFrame + string(rest)
	if !strings.Contains(all, `"method":"notifications/progress"`) {
		t.Fatalf("expected SSE stream to contain progress notification, got:\n%s", all)
	}
	if !strings.Contains(all, "event: message\n") {
		t.Fatalf("expected SSE stream to contain final message event, got:\n%s", all)
	}
	if !strings.Contains(all, `"result"`) {
		t.Fatalf("expected final message to contain JSON-RPC result, got:\n%s", all)
	}
}

func TestToolsCallStreaming_ProgressToken_NumberIsPreserved(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSession(t, s)

	firstEmitted := make(chan struct{})
	continueTool := make(chan struct{})

	if err := s.registry.RegisterStreamingTool(
		ToolDef{
			Name:        "slow_tool",
			Description: "Emits progress then blocks",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(ctx context.Context, _ json.RawMessage, emit func(SSEEvent)) (*ToolResult, error) {
			emit(SSEEvent{Data: map[string]any{"seq": 1}})
			close(firstEmitted)

			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-continueTool:
			}

			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	params := toolsCallParams{Name: "slow_tool", Arguments: json.RawMessage(`{}`)}
	params.Meta.ProgressToken = json.RawMessage(`123`)
	body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsCall, Params: mustMarshal(t, params)})

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.BodyReader == nil {
		t.Fatalf("expected streaming response BodyReader to be set")
	}

	reader := bufio.NewReader(resp.BodyReader)

	select {
	case <-firstEmitted:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first progress emission")
	}

	firstFrame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read first SSE frame: %v", err)
	}
	if !strings.Contains(firstFrame, `"method":"notifications/progress"`) {
		t.Fatalf("expected first frame to be progress notification, got:\n%s", firstFrame)
	}
	if !strings.Contains(firstFrame, `"progressToken":123`) {
		t.Fatalf("expected first frame to contain numeric progressToken, got:\n%s", firstFrame)
	}

	close(continueTool)

	if _, err := io.ReadAll(reader); err != nil {
		t.Fatalf("read rest of SSE stream: %v", err)
	}
}

func TestToolsCallStreaming_CanResumeViaGETWithLastEventID(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSession(t, s)

	firstEmitted := make(chan struct{})
	continueTool := make(chan struct{})
	toolDone := make(chan struct{})

	if err := s.registry.RegisterStreamingTool(
		ToolDef{
			Name:        "slow_tool",
			Description: "Emits progress then blocks",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(ctx context.Context, _ json.RawMessage, emit func(SSEEvent)) (*ToolResult, error) {
			emit(SSEEvent{Data: map[string]any{"seq": 1}})
			close(firstEmitted)

			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-continueTool:
			}

			emit(SSEEvent{Data: map[string]any{"seq": 2}})
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	params := toolsCallParams{Name: "slow_tool", Arguments: json.RawMessage(`{}`)}
	params.Meta.ProgressToken = json.RawMessage(`"pt-123"`)
	body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsCall, Params: mustMarshal(t, params)})

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}

	reqCtx, cancel := context.WithCancel(context.Background())
	resp, err := invokeHandlerWithMethod(reqCtx, s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.BodyReader == nil {
		t.Fatalf("expected streaming response BodyReader to be set")
	}

	reader := bufio.NewReader(resp.BodyReader)

	select {
	case <-firstEmitted:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first progress emission")
	}

	firstFrame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read first SSE frame: %v", err)
	}

	if !strings.Contains(firstFrame, "event: message\n") {
		t.Fatalf("expected first frame to be message event, got:\n%s", firstFrame)
	}
	if !strings.Contains(firstFrame, `"method":"notifications/progress"`) {
		t.Fatalf("expected first frame to be progress notification, got:\n%s", firstFrame)
	}

	// Capture the SSE id to use as Last-Event-ID.
	lastID := ""
	for _, line := range strings.Split(firstFrame, "\n") {
		if strings.HasPrefix(line, "id: ") {
			lastID = strings.TrimSpace(strings.TrimPrefix(line, "id: "))
			break
		}
	}
	if lastID == "" {
		t.Fatalf("expected first frame to include an id line, got:\n%s", firstFrame)
	}

	// Simulate disconnect: stop the POST stream.
	cancel()

	// Allow tool to finish after disconnect.
	go func() {
		defer close(toolDone)
		close(continueTool)
	}()
	select {
	case <-toolDone:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for tool completion")
	}

	getHeaders := sessionHeaders(sessionID)
	getHeaders["accept"] = []string{"text/event-stream"}
	getHeaders["last-event-id"] = []string{lastID}

	getResp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, getHeaders)
	if err != nil {
		t.Fatalf("invoke GET: %v", err)
	}
	if getResp.BodyReader == nil {
		t.Fatalf("expected GET response BodyReader to be set")
	}

	b, err := io.ReadAll(getResp.BodyReader)
	if err != nil {
		t.Fatalf("read GET SSE: %v", err)
	}

	all := string(b)
	if !strings.Contains(all, `"method":"notifications/progress"`) {
		t.Fatalf("expected resumed stream to contain progress notification, got:\n%s", all)
	}
	if !strings.Contains(all, `"result"`) {
		t.Fatalf("expected resumed stream to contain final result, got:\n%s", all)
	}
}

func TestGET_NoLastEventID_ReturnsShortKeepaliveResponse(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSession(t, s)

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}

	reqCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	resp, err := invokeHandlerWithMethod(reqCtx, s, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke GET: %v", err)
	}
	if resp.BodyReader == nil {
		t.Fatalf("expected GET listener BodyReader to be set")
	}

	reader := bufio.NewReader(resp.BodyReader)

	done := make(chan struct{})
	var frame string
	var readErr error
	go func() {
		defer close(done)
		frame, readErr = readSSEFrame(reader)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for keepalive frame")
	}
	if readErr != nil {
		t.Fatalf("read keepalive SSE frame: %v (frame=%q)", readErr, frame)
	}
	if !strings.HasPrefix(frame, ":") || !strings.Contains(frame, "keepalive") {
		t.Fatalf("expected keepalive comment frame, got:\n%s", frame)
	}

	var (
		rest    []byte
		restErr error
	)
	restDone := make(chan struct{})
	go func() {
		defer close(restDone)
		rest, restErr = io.ReadAll(reader)
	}()

	select {
	case <-restDone:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for short keepalive response to close")
	}
	if restErr != nil {
		t.Fatalf("read short keepalive response: %v", restErr)
	}
	if len(rest) != 0 {
		t.Fatalf("expected no extra listener frames after initial keepalive, got %q", string(rest))
	}
}
