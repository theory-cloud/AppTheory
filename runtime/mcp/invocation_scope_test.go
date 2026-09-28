package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"runtime"
	"strings"
	"testing"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v5/runtime"
)

// This file proves the invocation-scope invariant for the MCP server: every
// goroutine the server starts to produce a response body (the session listener
// keepalive writer, the stream subscription pump, the SSE forwarder, the SSE
// writer, and the streamed tool body) has returned once the body reader reaches
// EOF or is closed, so nothing outlives the invocation that started it.

func goroutineStacksContaining(marker string) string {
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
		if strings.Contains(block, marker) {
			leaked = append(leaked, block)
		}
	}
	return strings.Join(leaked, "\n\n")
}

func assertNoGoroutineFor(t *testing.T, marker, when string) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for {
		if leaked := goroutineStacksContaining(marker); leaked == "" {
			return
		} else if time.Now().After(deadline) {
			t.Fatalf("%s: producer goroutine outlived its invocation:\n%s", when, leaked)
		}
		time.Sleep(time.Millisecond)
	}
}

// assertStreamProducersJoined asserts that none of the goroutines that can
// produce a streamed MCP response body is still running.
func assertStreamProducersJoined(t *testing.T, when string) {
	t.Helper()

	for _, marker := range []string{
		"internal/streamjoin.New.func",
		"forwardStreamEvents",
		"(*streamScope).goRun.func",
		"(*streamScope).goJoin.func",
		"(*MemoryStreamStore).pumpSubscription",
		"(*MemoryStreamStore).broadcastOnDone.func",
	} {
		assertNoGoroutineFor(t, marker, when)
	}
}

func TestSessionListenerJoinsProducerOnClose(t *testing.T) {
	s := NewServer("test-server", "1.0.0", WithInitialSessionListenerBudget(InitialSessionListenerBudgetOptions{
		SafetyBuffer: 100 * time.Millisecond,
		MaxDuration:  30 * time.Second,
	}))
	sessionID := initializeSession(t, s)

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke GET: %v", err)
	}

	reader := bufio.NewReader(resp.BodyReader)
	frame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read keepalive frame: %v (frame=%q)", err, frame)
	}
	if !strings.Contains(frame, "keepalive") {
		t.Fatalf("expected keepalive frame, got %q", frame)
	}

	closer, ok := resp.BodyReader.(io.Closer)
	if !ok {
		t.Fatal("expected the listener body to be closable")
	}
	if err := closer.Close(); err != nil {
		t.Fatalf("close listener body: %v", err)
	}

	assertNoGoroutineFor(t, "internal/streamjoin.New.func", "session listener abandoned by the adapter")
}

func TestSessionListenerJoinsProducerOnEOF(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSession(t, s)

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke GET: %v", err)
	}

	body, err := io.ReadAll(resp.BodyReader)
	if err != nil {
		t.Fatalf("read short listener: %v", err)
	}
	if !strings.Contains(string(body), "keepalive") {
		t.Fatalf("expected a keepalive comment, got %q", string(body))
	}

	assertNoGoroutineFor(t, "internal/streamjoin.New.func", "session listener served to EOF")
}

func TestToolsCallStreamingJoinsToolWhenBodyCloses(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSession(t, s)

	toolFinished := make(chan struct{})
	release := make(chan struct{})
	if err := s.registry.RegisterStreamingTool(
		ToolDef{
			Name:        "join_tool",
			Description: "Emits progress, then blocks",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(ctx context.Context, _ json.RawMessage, emit func(SSEEvent)) (*ToolResult, error) {
			emit(SSEEvent{Data: map[string]any{"seq": 1}})
			defer close(toolFinished)
			select {
			case <-ctx.Done():
			case <-release:
			}
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	body := streamToolsCallBody(t, "join_tool")
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}

	reader := bufio.NewReader(resp.BodyReader)
	if _, err := readSSEFrame(reader); err != nil {
		t.Fatalf("read priming frame: %v", err)
	}
	if _, err := readSSEFrame(reader); err != nil {
		t.Fatalf("read progress frame: %v", err)
	}

	closer, ok := resp.BodyReader.(io.Closer)
	if !ok {
		t.Fatal("expected the streamed body to be closable")
	}

	// The tool holds work of its own, so closing the body joins it rather than
	// canceling it: the close must not return until the tool has finished.
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		if err := closer.Close(); err != nil {
			t.Errorf("close streamed body: %v", err)
		}
	}()

	select {
	case <-closed:
		t.Fatal("closing the streamed body returned while the tool body was still running")
	case <-time.After(20 * time.Millisecond):
	}

	close(release)
	select {
	case <-toolFinished:
	case <-time.After(2 * time.Second):
		t.Fatal("tool body did not finish")
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("closing the streamed body did not join the tool body")
	}

	assertStreamProducersJoined(t, "streamed tools/call body abandoned by the adapter")
}

func TestToolsCallStreamingJoinsToolOnEOF(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSession(t, s)

	if err := s.registry.RegisterStreamingTool(
		ToolDef{
			Name:        "quick_tool",
			Description: "Emits progress and returns",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(_ context.Context, _ json.RawMessage, emit func(SSEEvent)) (*ToolResult, error) {
			emit(SSEEvent{Data: map[string]any{"seq": 1}})
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	); err != nil {
		t.Fatalf("register streaming tool: %v", err)
	}

	body := streamToolsCallBody(t, "quick_tool")
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}

	all, err := io.ReadAll(resp.BodyReader)
	if err != nil {
		t.Fatalf("read streamed body: %v", err)
	}
	if !strings.Contains(string(all), `"result"`) {
		t.Fatalf("expected the tool result in the stream, got:\n%s", string(all))
	}

	assertStreamProducersJoined(t, "streamed tools/call body served to EOF")
}

func TestStreamSubscriptionJoinsPumpAndWatcher(t *testing.T) {
	store := NewMemoryStreamStore()
	ctx, cancel := context.WithCancel(context.Background())

	streamID, err := store.Create(ctx, "sess-join")
	if err != nil {
		t.Fatalf("create stream: %v", err)
	}
	if _, appendErr := store.Append(ctx, "sess-join", streamID, json.RawMessage(`{"jsonrpc":"2.0"}`)); appendErr != nil {
		t.Fatalf("append stream event: %v", appendErr)
	}

	events, err := store.Subscribe(ctx, "sess-join", streamID, "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	go func() {
		for range events {
		}
	}()

	time.Sleep(10 * time.Millisecond)
	cancel()

	// The subscription's pump and the watcher it starts both stop with the
	// subscription context; neither may keep running.
	time.Sleep(20 * time.Millisecond)
	assertNoGoroutineFor(t, "(*MemoryStreamStore).pumpSubscription", "stream subscription canceled")
	assertNoGoroutineFor(t, "(*MemoryStreamStore).broadcastOnDone.func", "stream subscription canceled")
}

func TestStreamedBodyReleaseJoinsScopeBeforeClosing(t *testing.T) {
	scope := newStreamScope(context.Background())

	finished := make(chan struct{})
	scope.goJoin(func() {
		time.Sleep(20 * time.Millisecond)
		close(finished)
	})

	relayDone := make(chan struct{})
	scope.goRun(func(ctx context.Context) {
		<-ctx.Done()
		close(relayDone)
	})

	reader := &scopedBodyReader{inner: io.NopCloser(strings.NewReader("body")), closer: io.NopCloser(strings.NewReader("body")), scope: scope}

	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read scoped body: %v", err)
	}
	if string(body) != "body" {
		t.Fatalf("scoped body = %q", string(body))
	}

	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("scope did not join the producer that holds its own work")
	}
	select {
	case <-relayDone:
	case <-time.After(time.Second):
		t.Fatal("scope did not cancel its relay producer")
	}
}

// TestScopeResponseBodyAlwaysReleasesScope covers R4: the scope-releasing
// wrapper is installed for every body reader, so a future BodyReader type that
// does not implement io.Closer cannot skip the join.
func TestScopeResponseBodyAlwaysReleasesScope(t *testing.T) {
	t.Run("on EOF", func(t *testing.T) {
		scope := newStreamScope(context.Background())
		relayDone := make(chan struct{})
		scope.goRun(func(ctx context.Context) {
			<-ctx.Done()
			close(relayDone)
		})

		// strings.Reader is not an io.Closer, so the wrapper used to be skipped
		// for this shape and the scope was never released.
		reader := scopeResponseBody(scope, strings.NewReader("body"))
		if _, ok := reader.(*scopedBodyReader); !ok {
			t.Fatalf("expected the scope wrapper to be installed unconditionally, got %T", reader)
		}

		body, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("read scoped body: %v", err)
		}
		if string(body) != "body" {
			t.Fatalf("scoped body = %q", string(body))
		}

		select {
		case <-relayDone:
		case <-time.After(time.Second):
			t.Fatal("reaching EOF on a non-closable scoped body did not release the scope")
		}
		assertNoGoroutineFor(t, "(*streamScope).goRun.func", "non-closable scoped body served to EOF")
	})

	t.Run("on close", func(t *testing.T) {
		scope := newStreamScope(context.Background())
		relayDone := make(chan struct{})
		scope.goRun(func(ctx context.Context) {
			<-ctx.Done()
			close(relayDone)
		})

		reader := scopeResponseBody(scope, strings.NewReader("body"))
		closer, ok := reader.(io.Closer)
		if !ok {
			t.Fatalf("expected the wrapped reader to be closable, got %T", reader)
		}
		if err := closer.Close(); err != nil {
			t.Fatalf("close scoped body: %v", err)
		}

		select {
		case <-relayDone:
		case <-time.After(time.Second):
			t.Fatal("closing a non-closable scoped body did not release the scope")
		}
		assertNoGoroutineFor(t, "(*streamScope).goRun.func", "non-closable scoped body closed")
	})
}

// TestStreamToSSEInstallsTheScopeWrapper proves streamToSSE routes its body
// through the unconditional scope wrapper, and that releasing the body joins the
// SSE forwarder.
func TestStreamToSSEInstallsTheScopeWrapper(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	scope := newStreamScope(context.Background())
	events := make(chan StreamEvent)

	resp, err := s.streamToSSE(scope, "sess-join", events)
	if err != nil {
		t.Fatalf("streamToSSE: %v", err)
	}
	if _, ok := resp.BodyReader.(*scopedBodyReader); !ok {
		t.Fatalf("expected the scope wrapper to be installed, got %T", resp.BodyReader)
	}

	// The store closes its subscription when the invocation ends, which is the
	// close the forwarder drains inside the scope's stop.
	close(events)

	closer, ok := resp.BodyReader.(io.Closer)
	if !ok {
		t.Fatalf("expected the scoped body to be closable, got %T", resp.BodyReader)
	}
	if err := closer.Close(); err != nil {
		t.Fatalf("close scoped body: %v", err)
	}

	assertNoGoroutineFor(t, "forwardStreamEvents", "streamed body released")
	assertNoGoroutineFor(t, "(*streamScope).goRun.func", "streamed body released")
}

func streamToolsCallBody(t *testing.T, name string) []byte {
	t.Helper()

	params := toolsCallParams{Name: name, Arguments: json.RawMessage(`{}`)}
	params.Meta.ProgressToken = json.RawMessage(`"pt-join"`)
	return mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsCall, Params: mustMarshal(t, params)})
}

func TestTaskBodyRunsInsideTheToolsCallInvocation(t *testing.T) {
	store := NewMemoryTaskStore()
	s := NewServer("test", "dev",
		WithServerIDGenerator(staticIDGenerator{id: "task-invocation"}),
		WithTaskRuntime(TaskRuntimeOptions{Store: store}),
	)

	bodyFinished := false
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		bodyFinished = true
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "done"}}}, nil
	}); err != nil {
		t.Fatalf("register task tool: %v", err)
	}

	resp := s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(1, "slow"), protocolVersion, "sess-1")
	if resp.Error != nil {
		t.Fatalf("tools/call task create error: %+v", resp.Error)
	}
	created, ok := resp.Result.(CreateTaskResult)
	if !ok {
		t.Fatalf("expected create task result, got %#v", resp.Result)
	}

	if !bodyFinished {
		t.Fatal("tools/call returned before the task body ran")
	}
	if created.Task.Status != TaskStatusCompleted {
		t.Fatalf("expected a terminal task in the tools/call reply, got %+v", created.Task)
	}
	record, err := store.Get(context.Background(), TaskLookup{SessionID: "sess-1", TaskID: "task-invocation"})
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if record.Task.Status != TaskStatusCompleted || len(record.Result) == 0 {
		t.Fatalf("expected a stored terminal task with a result, got %+v", record)
	}

	assertNoGoroutineFor(t, "runTaskTool", "tools/call task body")
}

var _ = apptheory.Response{}
