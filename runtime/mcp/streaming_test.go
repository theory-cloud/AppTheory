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

func sseFrameID(t *testing.T, frame string) string {
	t.Helper()
	for _, line := range strings.Split(frame, "\n") {
		if strings.HasPrefix(line, "id: ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "id: "))
		}
	}
	t.Fatalf("expected SSE frame to include an id line, got:\n%s", frame)
	return ""
}

func requirePrimingSSEFrame(t *testing.T, frame string) string {
	t.Helper()
	id := sseFrameID(t, frame)
	if strings.Contains(frame, "event: message\n") {
		t.Fatalf("expected priming frame to omit message event name, got:\n%s", frame)
	}
	if !strings.Contains(frame, "data: \n") {
		t.Fatalf("expected priming frame to contain an empty data field, got:\n%s", frame)
	}
	if strings.Contains(frame, `"jsonrpc"`) {
		t.Fatalf("expected priming frame to omit JSON-RPC payload, got:\n%s", frame)
	}
	return id
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
	headers["accept"] = []string{"application/json, text/event-stream"}

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

	firstFrameCh := make(chan string, 1)
	firstFrameErrCh := make(chan error, 1)
	go func() {
		frame, readErr := readSSEFrame(reader)
		if readErr != nil {
			firstFrameErrCh <- readErr
			return
		}
		firstFrameCh <- frame
	}()

	var firstFrame string
	select {
	case firstFrame = <-firstFrameCh:
	case frameErr := <-firstFrameErrCh:
		t.Fatalf("read first SSE frame: %v", frameErr)
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first SSE frame")
	}
	requirePrimingSSEFrame(t, firstFrame)

	select {
	case <-firstEmitted:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first progress emission")
	}

	progressFrame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read progress SSE frame: %v", err)
	}

	if !strings.Contains(progressFrame, "event: message\n") {
		t.Fatalf("expected progress frame to be message event, got:\n%s", progressFrame)
	}
	if !strings.Contains(progressFrame, `"method":"notifications/progress"`) {
		t.Fatalf("expected progress frame to be progress notification, got:\n%s", progressFrame)
	}
	if !strings.Contains(progressFrame, `"progressToken":"pt-123"`) {
		t.Fatalf("expected progress frame to contain progressToken, got:\n%s", progressFrame)
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

	all := firstFrame + progressFrame + string(rest)
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
	headers["accept"] = []string{"application/json, text/event-stream"}

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

	primingFrame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read priming SSE frame: %v", err)
	}
	requirePrimingSSEFrame(t, primingFrame)

	firstFrame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read first progress SSE frame: %v", err)
	}
	if !strings.Contains(firstFrame, `"method":"notifications/progress"`) {
		t.Fatalf("expected first progress frame to be progress notification, got:\n%s", firstFrame)
	}
	if !strings.Contains(firstFrame, `"progressToken":123`) {
		t.Fatalf("expected first progress frame to contain numeric progressToken, got:\n%s", firstFrame)
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
	headers["accept"] = []string{"application/json, text/event-stream"}

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

	primingFrame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read priming SSE frame: %v", err)
	}
	requirePrimingSSEFrame(t, primingFrame)

	firstFrame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read first progress SSE frame: %v", err)
	}

	if !strings.Contains(firstFrame, "event: message\n") {
		t.Fatalf("expected first progress frame to be message event, got:\n%s", firstFrame)
	}
	if !strings.Contains(firstFrame, `"method":"notifications/progress"`) {
		t.Fatalf("expected first progress frame to be progress notification, got:\n%s", firstFrame)
	}

	// Capture the SSE id to use as Last-Event-ID.
	lastID := sseFrameID(t, firstFrame)

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

func TestToolsCallStreaming_PrimingEventAllowsResumeBeforeMessages(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSession(t, s)

	toolEntered := make(chan struct{})
	continueTool := make(chan struct{})
	toolDone := make(chan struct{})

	if err := s.registry.RegisterStreamingTool(
		ToolDef{
			Name:        "delayed_tool",
			Description: "Waits before emitting progress",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(ctx context.Context, _ json.RawMessage, emit func(SSEEvent)) (*ToolResult, error) {
			defer close(toolDone)
			close(toolEntered)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-continueTool:
			}
			emit(SSEEvent{Data: map[string]any{"seq": 1}})
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	params := toolsCallParams{Name: "delayed_tool", Arguments: json.RawMessage(`{}`)}
	params.Meta.ProgressToken = json.RawMessage(`"pt-primed"`)
	body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsCall, Params: mustMarshal(t, params)})

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	reqCtx, cancel := context.WithCancel(context.Background())
	resp, err := invokeHandlerWithMethod(reqCtx, s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.BodyReader == nil {
		t.Fatalf("expected streaming response BodyReader to be set")
	}

	reader := bufio.NewReader(resp.BodyReader)
	primingFrame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read priming frame: %v", err)
	}
	primingID := requirePrimingSSEFrame(t, primingFrame)

	select {
	case <-toolEntered:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for tool to enter")
	}

	cancel()
	close(continueTool)
	select {
	case <-toolDone:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for tool completion")
	}

	getHeaders := sseSessionHeaders(sessionID)
	getHeaders["last-event-id"] = []string{primingID}

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
		t.Fatalf("expected replay after priming id to include progress notification, got:\n%s", all)
	}
	if !strings.Contains(all, `"progressToken":"pt-primed"`) {
		t.Fatalf("expected replay after priming id to include progress token, got:\n%s", all)
	}
	if !strings.Contains(all, `"result"`) {
		t.Fatalf("expected replay after priming id to include final result, got:\n%s", all)
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

func TestToolsCallStreaming_PanicReturnsInternalError(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSession(t, s)

	if err := s.registry.RegisterStreamingTool(
		ToolDef{
			Name:        "panic_tool",
			Description: "Panics during streaming execution",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(context.Context, json.RawMessage, func(SSEEvent)) (*ToolResult, error) {
			panic("boom")
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	params := toolsCallParams{Name: "panic_tool", Arguments: json.RawMessage(`{}`)}
	body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsCall, Params: mustMarshal(t, params)})

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.BodyReader == nil {
		t.Fatalf("expected streaming response BodyReader to be set")
	}

	b, err := io.ReadAll(resp.BodyReader)
	if err != nil {
		t.Fatalf("read panic SSE stream: %v", err)
	}

	all := string(b)
	if !strings.Contains(all, `"error":{"code":-32603,"message":"internal error"}`) {
		t.Fatalf("expected internal error payload, got:\n%s", all)
	}
	if strings.Contains(all, "boom") {
		t.Fatalf("panic text leaked into stream:\n%s", all)
	}
}
