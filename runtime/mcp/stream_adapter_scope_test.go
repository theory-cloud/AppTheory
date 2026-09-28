package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/v5/runtime"
)

// This file proves R8: the streamed tools/call body join completes before the
// invocation returns on every adapter path, including a buffered adapter that
// gives up on the stream (413/500) and a response-streaming transport that stops
// reading the body on a client disconnect while MaxResponseBytes is set.

// oversizedSSEPayload is larger than the harness limiter budget, so the wrapper
// limitBodyReader trips on the streamed frame.
var oversizedSSEPayload = strings.Repeat("x", 4096)

// streamingToolHarness wires a streamed tools/call tool into an AppTheory app so
// a test can drive it through a real adapter.
type streamingToolHarness struct {
	app      *apptheory.App
	session  string
	finished chan struct{}
	release  chan struct{}

	releaseOnce sync.Once
}

func (h *streamingToolHarness) releaseTool() {
	h.releaseOnce.Do(func() { close(h.release) })
}

func newStreamingToolHarness(t *testing.T, limits apptheory.Limits, payload string) *streamingToolHarness {
	t.Helper()

	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSession(t, s)

	finished := make(chan struct{})
	release := make(chan struct{})
	if err := s.registry.RegisterStreamingTool(
		ToolDef{
			Name:        "slow_tool",
			Description: "Emits progress, then holds work",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(ctx context.Context, _ json.RawMessage, emit func(SSEEvent)) (*ToolResult, error) {
			defer close(finished)
			emit(SSEEvent{Data: payload})
			select {
			case <-ctx.Done():
			case <-release:
			}
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	handler := s.Handler()
	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP1),
		apptheory.WithLimits(limits),
	)
	app.Post("/mcp", handler)
	app.Get("/mcp", handler)
	app.Delete("/mcp", handler)

	return &streamingToolHarness{
		app:      app,
		session:  sessionID,
		finished: finished,
		release:  release,
	}
}

func (h *streamingToolHarness) callHeaders() map[string]string {
	headers := map[string]string{}
	for key, values := range sessionHeaders(h.session) {
		if len(values) > 0 {
			headers[key] = values[0]
		}
	}
	headers["accept"] = "application/json, text/event-stream"
	headers["content-type"] = "application/json"
	return headers
}

func (h *streamingToolHarness) v2Event(t *testing.T) events.APIGatewayV2HTTPRequest {
	t.Helper()

	event := events.APIGatewayV2HTTPRequest{
		RawPath: "/mcp",
		Headers: h.callHeaders(),
		Body:    string(streamToolsCallBody(t, "slow_tool")),
	}
	event.RequestContext.HTTP.Method = "POST"
	event.RequestContext.HTTP.Path = "/mcp"
	return event
}

func (h *streamingToolHarness) v1Event(t *testing.T, stageVariables map[string]string) json.RawMessage {
	t.Helper()

	event := events.APIGatewayProxyRequest{
		HTTPMethod:     "POST",
		Path:           "/mcp",
		Resource:       "/mcp",
		Headers:        h.callHeaders(),
		Body:           string(streamToolsCallBody(t, "slow_tool")),
		StageVariables: stageVariables,
	}
	event.RequestContext.HTTPMethod = "POST"
	event.RequestContext.Path = "/mcp"
	event.RequestContext.ResourcePath = "/mcp"

	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal v1 event: %v", err)
	}
	return raw
}

// assertAdapterWaitedForTheTool asserts an adapter call already in flight has not
// returned while the tool body that produced the stream is still running, and
// returns the channel the call's result arrives on.
func assertAdapterWaitedForTheTool(t *testing.T, call func() any, when string) chan any {
	t.Helper()

	returned := make(chan any, 1)
	go func() {
		returned <- call()
	}()

	select {
	case <-returned:
		t.Fatalf("%s: the adapter returned while the streamed tool body was still running", when)
	case <-time.After(40 * time.Millisecond):
	}
	return returned
}

func awaitToolAndCall(t *testing.T, h *streamingToolHarness, returned chan any, when string) any {
	t.Helper()

	h.releaseTool()
	select {
	case <-h.finished:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s: streamed tool body did not finish", when)
	}
	select {
	case out := <-returned:
		return out
	case <-time.After(2 * time.Second):
		t.Fatalf("%s: the adapter did not return after the tool body finished", when)
		return nil
	}
}

// TestBufferedAdaptersJoinStreamedToolsCallBody covers the buffered adapter paths
// that give up on a never-terminating streamed tools/call: the drain deadline
// (500) and the response limiter (413). Each must join the tool body before it
// returns.
func TestBufferedAdaptersJoinStreamedToolsCallBody(t *testing.T) {
	t.Run("drain deadline fails closed with 500 and joins the tool", func(t *testing.T) {
		h := newStreamingToolHarness(t, apptheory.Limits{MaxResponseBytes: 1 << 20}, "progress")
		defer h.releaseTool()
		before := goroutineIDs()

		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()

		returned := assertAdapterWaitedForTheTool(t, func() any {
			return h.app.ServeAPIGatewayV2(ctx, h.v2Event(t))
		}, "v2 buffered adapter drain deadline")

		out, ok := awaitToolAndCall(t, h, returned, "v2 buffered adapter drain deadline").(events.APIGatewayV2HTTPResponse)
		if !ok {
			t.Fatal("expected an HTTP API v2 response")
		}
		if out.StatusCode != 500 {
			t.Fatalf("expected the abandoned streamed body to fail closed with 500, got %d", out.StatusCode)
		}
		assertNoNewStreamProducers(t, before, "v2 buffered adapter drain deadline")
	})

	t.Run("limiter overflow fails closed with 413 and joins the tool", func(t *testing.T) {
		h := newStreamingToolHarness(t, apptheory.Limits{MaxResponseBytes: 512}, oversizedSSEPayload)
		defer h.releaseTool()
		before := goroutineIDs()

		returned := assertAdapterWaitedForTheTool(t, func() any {
			return h.app.ServeAPIGatewayV2(context.Background(), h.v2Event(t))
		}, "v2 buffered adapter response limiter")

		out, ok := awaitToolAndCall(t, h, returned, "v2 buffered adapter response limiter").(events.APIGatewayV2HTTPResponse)
		if !ok {
			t.Fatal("expected an HTTP API v2 response")
		}
		if out.StatusCode != 413 {
			t.Fatalf("expected the response limiter to map to 413, got %d", out.StatusCode)
		}
		assertNoNewStreamProducers(t, before, "v2 buffered adapter response limiter")
	})
}

// TestV1StreamingClientDisconnectJoinsStreamedToolsCallBody covers R3 on the
// registered v1 response-streaming route: the SSE body the transport receives is
// wrapped by MaxResponseBytes, and the transport closes it on a client
// disconnect. That close must reach the SSE writer and the tool body.
func TestV1StreamingClientDisconnectJoinsStreamedToolsCallBody(t *testing.T) {
	h := newStreamingToolHarness(t, apptheory.Limits{MaxResponseBytes: 1 << 20}, "progress")
	defer h.releaseTool()
	before := goroutineIDs()

	stageVariables := map[string]string{
		"APPTHEORYSTREAMINGV1" + streamingRouteStageVariableHash("POST", "/mcp"): "1",
	}
	assertStreamingDisconnectJoinsTool(t, h, before, h.v1Event(t, stageVariables), "v1 streaming route client disconnect")
}

// TestV1StreamingFallbackDisconnectJoinsStreamedToolsCallBody covers the other
// v1 response-streaming shape: a non-streaming route whose response is an SSE
// content type is delivered by the streaming adapter, so the transport still owns
// the body's lifetime and must join the producers on a disconnect.
func TestV1StreamingFallbackDisconnectJoinsStreamedToolsCallBody(t *testing.T) {
	h := newStreamingToolHarness(t, apptheory.Limits{MaxResponseBytes: 1 << 20}, "progress")
	defer h.releaseTool()
	before := goroutineIDs()

	assertStreamingDisconnectJoinsTool(t, h, before, h.v1Event(t, nil), "v1 streaming fallback client disconnect")
}

func assertStreamingDisconnectJoinsTool(t *testing.T, h *streamingToolHarness, before map[int]struct{}, event json.RawMessage, when string) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	out, err := h.app.HandleLambda(ctx, event)
	if err != nil {
		t.Fatalf("%s: HandleLambda: %v", when, err)
	}
	streaming, ok := out.(*events.APIGatewayProxyStreamingResponse)
	if !ok {
		t.Fatalf("%s: expected a v1 streaming response, got %T", when, out)
	}

	buf := make([]byte, 64)
	if _, err := streaming.Body.Read(buf); err != nil && err != io.EOF {
		t.Fatalf("%s: read priming frame: %v", when, err)
	}

	closer, ok := streaming.Body.(io.Closer)
	if !ok {
		t.Fatalf("%s: expected a closable streaming body, got %T", when, streaming.Body)
	}

	// The client disconnects: the transport closes the body. The close must not
	// return while the tool body is still running, and must join it.
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		if err := closer.Close(); err != nil {
			t.Errorf("%s: close streaming body: %v", when, err)
		}
	}()

	select {
	case <-closed:
		t.Fatalf("%s: closing the streamed body returned while the tool body was still running", when)
	case <-time.After(40 * time.Millisecond):
	}

	h.releaseTool()
	select {
	case <-h.finished:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s: streamed tool body did not finish", when)
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s: closing the streamed body did not join the tool body", when)
	}

	assertNoNewStreamProducers(t, before, when)
}

// streamingRouteStageVariableHash mirrors the adapter's stage-variable naming:
// sha256 of "<METHOD> <resource>" truncated to 16 bytes, hex encoded.
func streamingRouteStageVariableHash(method, resource string) string {
	sum := sha256.Sum256([]byte(strings.ToUpper(strings.TrimSpace(method)) + " " + resource))
	return hex.EncodeToString(sum[:16])
}

// streamProducerMarkers name every goroutine that can produce a streamed MCP
// response body. A call must not leave a new one of these running.
var streamProducerMarkers = []string{
	"internal/streamjoin.New.func",
	"forwardStreamEvents",
	"(*streamScope).goRun.func",
	"(*streamScope).goJoin.func",
	"(*MemoryStreamStore).pumpSubscription",
	"(*MemoryStreamStore).broadcastOnDone.func",
}

// goroutineIDs returns the id of every live goroutine. Goroutine ids are unique
// for the life of the process, so an id absent from a snapshot is a goroutine
// started after that snapshot.
func goroutineIDs() map[int]struct{} {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			break
		}
		buf = make([]byte, 2*len(buf))
	}

	ids := map[int]struct{}{}
	for _, block := range strings.Split(string(buf), "\n\n") {
		header := block
		if idx := strings.IndexByte(block, '\n'); idx >= 0 {
			header = block[:idx]
		}
		fields := strings.Fields(header)
		if len(fields) < 2 || fields[0] != "goroutine" {
			continue
		}
		id, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		ids[id] = struct{}{}
	}
	return ids
}

func goroutineStacksForNewIDs(before map[int]struct{}, marker string) string {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			break
		}
		buf = make([]byte, 2*len(buf))
	}

	var leaked []string
	for _, block := range strings.Split(string(buf), "\n\n") {
		if !strings.Contains(block, marker) {
			continue
		}
		header := block
		if idx := strings.IndexByte(block, '\n'); idx >= 0 {
			header = block[:idx]
		}
		fields := strings.Fields(header)
		if len(fields) < 2 || fields[0] != "goroutine" {
			continue
		}
		if id, err := strconv.Atoi(fields[1]); err == nil {
			if _, seen := before[id]; seen {
				continue
			}
		}
		leaked = append(leaked, block)
	}
	return strings.Join(leaked, "\n\n")
}

// assertNoNewStreamProducers asserts that no goroutine containing a stream
// producer marker was started after the snapshot. It is delta-based so a
// producer another test in the process left running cannot be attributed to this
// call.
func assertNoNewStreamProducers(t *testing.T, before map[int]struct{}, when string) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for {
		leaked := ""
		for _, marker := range streamProducerMarkers {
			if block := goroutineStacksForNewIDs(before, marker); block != "" {
				leaked = block
				break
			}
		}
		if leaked == "" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: producer goroutine outlived its invocation:\n%s", when, leaked)
		}
		time.Sleep(time.Millisecond)
	}
}
