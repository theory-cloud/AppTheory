package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/runtime/mcp"
)

const mcpProtocolVersion = "2025-11-25"

func runFixtureMCP(f Fixture) error {
	if f.Input.MCP == nil {
		return errors.New("fixture missing input.mcp")
	}
	if f.Expect.MCP == nil {
		return errors.New("fixture missing expect.mcp")
	}
	if len(f.Input.MCP.Steps) != len(f.Expect.MCP.Steps) {
		return fmt.Errorf("mcp steps length: expected %d, got %d", len(f.Expect.MCP.Steps), len(f.Input.MCP.Steps))
	}

	server, err := newFixtureMCPServer(f.Setup.MCP)
	if err != nil {
		return fmt.Errorf("setup mcp server: %w", err)
	}
	app := apptheory.New(apptheory.WithIDGenerator(fixedIDGenerator{id: "req_mcp_123"}))
	handler := server.Handler()
	app.Post("/mcp", handler)
	app.Get("/mcp", handler)
	app.Delete("/mcp", handler)

	for i, step := range f.Input.MCP.Steps {
		actual, err := invokeMCPFixtureStep(app, step)
		if err != nil {
			return fmt.Errorf("step %s: %w", step.Name, err)
		}
		if err := compareMCPExpectedStep(f.Expect.MCP.Steps[i], actual); err != nil {
			return fmt.Errorf("step %s: %w", step.Name, err)
		}
	}
	return nil
}

func newFixtureMCPServer(setup FixtureMCPSetup) (*mcp.Server, error) {
	name := strings.TrimSpace(setup.Server.Name)
	if name == "" {
		name = "AppTheoryContractMCP"
	}
	version := strings.TrimSpace(setup.Server.Version)
	if version == "" {
		version = "sp09"
	}

	serverIDs := newSequenceIDGenerator(setup.IDSequence, "mcp-id")
	streamIDs := newSequenceIDGenerator(setup.StreamIDSequence, "mcp-stream")
	sessionStore := newFixtureMCPSessionStore(setup.SessionStore)
	streamStore := mcp.NewMemoryStreamStore(mcp.WithStreamIDGenerator(streamIDs))

	opts := []mcp.ServerOption{
		mcp.WithServerIDGenerator(serverIDs),
		mcp.WithSessionStore(sessionStore),
		mcp.WithStreamStore(streamStore),
	}
	if setup.TaskRuntime != nil && setup.TaskRuntime.Enabled {
		opts = append(opts, mcp.WithTaskRuntime(mcp.TaskRuntimeOptions{
			Store:                  newFixtureMCPTaskStore(*setup.TaskRuntime),
			DefaultTTL:             durationFromMilliseconds(setup.TaskRuntime.DefaultTTLMS),
			MaxTTL:                 durationFromMilliseconds(setup.TaskRuntime.MaxTTLMS),
			PollInterval:           durationFromMilliseconds(setup.TaskRuntime.PollIntervalMS),
			ListLimit:              setup.TaskRuntime.ListLimit,
			ModelImmediateResponse: setup.TaskRuntime.ModelImmediateResponse,
		}))
	}

	server := mcp.NewServer(name, version, opts...)
	for _, tool := range setup.Tools {
		if err := registerFixtureMCPTool(server, tool); err != nil {
			return nil, err
		}
	}
	for _, resource := range setup.Resources {
		if err := registerFixtureMCPResource(server, resource); err != nil {
			return nil, err
		}
	}
	if len(setup.ResourceTemplates) > 0 {
		return nil, errors.New("resource templates are not supported by this Go MCP runner yet")
	}
	for _, prompt := range setup.Prompts {
		if err := registerFixtureMCPPrompt(server, prompt); err != nil {
			return nil, err
		}
	}
	return server, nil
}

func durationFromMilliseconds(ms int64) time.Duration {
	if ms <= 0 {
		return 0
	}
	return time.Duration(ms) * time.Millisecond
}

type sequenceIDGenerator struct {
	mu       sync.Mutex
	ids      []string
	fallback string
	next     int
}

func newSequenceIDGenerator(ids []string, fallback string) *sequenceIDGenerator {
	return &sequenceIDGenerator{ids: append([]string(nil), ids...), fallback: fallback}
}

func (g *sequenceIDGenerator) NewID() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.next < len(g.ids) {
		out := strings.TrimSpace(g.ids[g.next])
		g.next++
		if out != "" {
			return out
		}
	}
	g.next++
	return fmt.Sprintf("%s-%d", g.fallback, g.next)
}

func newFixtureMCPSessionStore(config FixtureMCPSessionStore) *mcp.MemorySessionStore {
	store := mcp.NewMemorySessionStore(mcp.WithClock(fixedClock{now: time.Unix(1700000000, 0).UTC()}))
	for _, seed := range config.Seed {
		created := timeFromUnixMilliseconds(seed.CreatedUnixMS)
		if created.IsZero() {
			created = time.Unix(0, 0).UTC()
		}
		sess := &mcp.Session{
			ID:        seed.ID,
			CreatedAt: created,
			ExpiresAt: timeFromUnixMilliseconds(seed.ExpiresUnixMS),
			Data:      cloneStringMap(seed.Data),
		}
		_ = store.Put(context.Background(), sess)
	}
	return store
}

func timeFromUnixMilliseconds(ms int64) time.Time {
	if ms <= 0 {
		return time.Time{}
	}
	sec := ms / 1000
	nsec := (ms % 1000) * int64(time.Millisecond)
	return time.Unix(sec, nsec).UTC()
}

func cloneStringMap(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func registerFixtureMCPTool(server *mcp.Server, tool FixtureMCPTool) error {
	def := mcp.ToolDef{
		Name:         tool.Name,
		Title:        tool.Title,
		Description:  tool.Description,
		InputSchema:  cloneRawMessage(tool.InputSchema),
		OutputSchema: cloneRawMessage(tool.OutputSchema),
	}
	if support := strings.TrimSpace(tool.TaskSupport); support != "" {
		def.Execution = &mcp.ToolExecution{TaskSupport: mcp.TaskSupport(support)}
	}

	if tool.Streaming {
		handler, err := fixtureMCPStreamingToolHandler(tool.Handler)
		if err != nil {
			return err
		}
		return server.Registry().RegisterStreamingTool(def, handler)
	}
	handler, err := fixtureMCPToolHandler(tool.Handler)
	if err != nil {
		return err
	}
	return server.Registry().RegisterTool(def, handler)
}

func cloneRawMessage(in json.RawMessage) json.RawMessage {
	return append(json.RawMessage(nil), in...)
}

func fixtureMCPToolHandler(name string) (mcp.ToolHandler, error) {
	switch strings.TrimSpace(name) {
	case "echo_text":
		return func(_ context.Context, args json.RawMessage) (*mcp.ToolResult, error) {
			message, err := mcpFixtureMessageArg(args)
			if err != nil {
				return nil, err
			}
			return &mcp.ToolResult{Content: []mcp.ContentBlock{{Type: "text", Text: message}}}, nil
		}, nil
	case "fail_error":
		return func(context.Context, json.RawMessage) (*mcp.ToolResult, error) {
			return nil, errors.New("fixture tool failed")
		}, nil
	case "task_echo":
		return func(_ context.Context, args json.RawMessage) (*mcp.ToolResult, error) {
			message, err := mcpFixtureMessageArg(args)
			if err != nil {
				return nil, err
			}
			return &mcp.ToolResult{
				Content:           []mcp.ContentBlock{{Type: "text", Text: message}},
				StructuredContent: map[string]any{"message": message},
			}, nil
		}, nil
	default:
		return nil, fmt.Errorf("unknown mcp tool handler %q", name)
	}
}

func fixtureMCPStreamingToolHandler(name string) (mcp.StreamingToolHandler, error) {
	switch strings.TrimSpace(name) {
	case "stream_progress":
		return func(_ context.Context, args json.RawMessage, emit func(mcp.SSEEvent)) (*mcp.ToolResult, error) {
			message, err := mcpFixtureMessageArg(args)
			if err != nil {
				return nil, err
			}
			emit(mcp.SSEEvent{Data: map[string]any{"seq": 1, "total": 2, "message": "half"}})
			emit(mcp.SSEEvent{Data: map[string]any{"seq": 2, "total": 2, "message": "done"}})
			return &mcp.ToolResult{Content: []mcp.ContentBlock{{Type: "text", Text: message}}}, nil
		}, nil
	default:
		return nil, fmt.Errorf("unknown mcp streaming tool handler %q", name)
	}
}

func mcpFixtureMessageArg(args json.RawMessage) (string, error) {
	var payload struct {
		Message string `json:"message"`
	}
	if len(bytes.TrimSpace(args)) > 0 {
		if err := json.Unmarshal(args, &payload); err != nil {
			return "", err
		}
	}
	if strings.TrimSpace(payload.Message) == "" {
		return "", errors.New("missing message")
	}
	return payload.Message, nil
}

func registerFixtureMCPResource(server *mcp.Server, resource FixtureMCPResource) error {
	contents := make([]mcp.ResourceContent, 0, len(resource.Contents))
	for _, content := range resource.Contents {
		contents = append(contents, mcp.ResourceContent{
			URI:      content.URI,
			MimeType: content.MimeType,
			Text:     content.Text,
			Blob:     content.Blob,
		})
	}
	return server.Resources().RegisterResource(mcp.ResourceDef{
		URI:         resource.URI,
		Name:        resource.Name,
		Title:       resource.Title,
		Description: resource.Description,
		MimeType:    resource.MimeType,
		Size:        resource.Size,
	}, func(context.Context) ([]mcp.ResourceContent, error) {
		out := append([]mcp.ResourceContent(nil), contents...)
		return out, nil
	})
}

func registerFixtureMCPPrompt(server *mcp.Server, prompt FixtureMCPPrompt) error {
	args := make([]mcp.PromptArgument, 0, len(prompt.Arguments))
	for _, arg := range prompt.Arguments {
		args = append(args, mcp.PromptArgument{
			Name:        arg.Name,
			Title:       arg.Title,
			Description: arg.Description,
			Required:    arg.Required,
		})
	}
	handler, err := fixtureMCPPromptHandler(prompt.Handler)
	if err != nil {
		return err
	}
	return server.Prompts().RegisterPrompt(mcp.PromptDef{
		Name:        prompt.Name,
		Title:       prompt.Title,
		Description: prompt.Description,
		Arguments:   args,
	}, handler)
}

func fixtureMCPPromptHandler(name string) (mcp.PromptHandler, error) {
	switch strings.TrimSpace(name) {
	case "render_greeting":
		return func(_ context.Context, args json.RawMessage) (*mcp.PromptResult, error) {
			var payload struct {
				Name string `json:"name"`
			}
			if len(bytes.TrimSpace(args)) > 0 {
				if err := json.Unmarshal(args, &payload); err != nil {
					return nil, err
				}
			}
			name := strings.TrimSpace(payload.Name)
			if name == "" {
				name = "friend"
			}
			return &mcp.PromptResult{
				Description: "Rendered greeting",
				Messages: []mcp.PromptMessage{{
					Role:    "user",
					Content: mcp.ContentBlock{Type: "text", Text: "Hello, " + name + "."},
				}},
			}, nil
		}, nil
	default:
		return nil, fmt.Errorf("unknown mcp prompt handler %q", name)
	}
}

type fixtureMCPActualStep struct {
	Status    int
	Headers   map[string][]string
	Cookies   []string
	Body      []byte
	SSEFrames []FixtureMCPSSEFrame
	IsBase64  bool
}

func invokeMCPFixtureStep(app *apptheory.App, step FixtureMCPStep) (fixtureMCPActualStep, error) {
	body, err := decodeFixtureBody(step.Request.Body)
	if err != nil {
		return fixtureMCPActualStep{}, fmt.Errorf("decode request body: %w", err)
	}
	if step.Request.IsBase64 {
		decoded, err := decodeBase64String(string(body))
		if err != nil {
			return fixtureMCPActualStep{}, fmt.Errorf("decode base64 request body: %w", err)
		}
		body = decoded
	}
	ctx, cancel := fixtureContext(time.Unix(0, 0).UTC(), 0)
	if cancel != nil {
		defer cancel()
	}
	resp := app.Serve(ctx, apptheory.Request{
		Method:  strings.ToUpper(strings.TrimSpace(step.Request.Method)),
		Path:    strings.TrimSpace(step.Request.Path),
		Query:   cloneHeaders(step.Request.Query),
		Headers: canonicalizeHeaders(step.Request.Headers),
		Body:    body,
	})

	actualBody := append([]byte(nil), resp.Body...)
	if resp.BodyReader != nil {
		read, err := io.ReadAll(resp.BodyReader)
		if err != nil {
			return fixtureMCPActualStep{}, fmt.Errorf("read response body: %w", err)
		}
		actualBody = append(actualBody, read...)
	}
	frames, err := parseMCPSSEFrames(actualBody)
	if err != nil {
		return fixtureMCPActualStep{}, err
	}
	return fixtureMCPActualStep{
		Status:    resp.Status,
		Headers:   canonicalizeHeaders(resp.Headers),
		Cookies:   append([]string(nil), resp.Cookies...),
		Body:      actualBody,
		SSEFrames: frames,
		IsBase64:  resp.IsBase64,
	}, nil
}

func decodeBase64String(value string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(strings.TrimSpace(value))
}

func compareMCPExpectedStep(expected FixtureMCPExpectedStep, actual fixtureMCPActualStep) error {
	if expected.Status != actual.Status {
		return fmt.Errorf("status: expected %d, got %d", expected.Status, actual.Status)
	}
	if expected.IsBase64 != actual.IsBase64 {
		return fmt.Errorf("is_base64: expected %v, got %v", expected.IsBase64, actual.IsBase64)
	}
	if !equalStringSlices(expected.Cookies, actual.Cookies) {
		return fmt.Errorf("cookies mismatch")
	}
	if !equalHeaders(canonicalizeHeaders(expected.Headers), actual.Headers) {
		return fmt.Errorf("headers mismatch: expected %s, got %s", string(marshalIndentOrPlaceholder(canonicalizeHeaders(expected.Headers))), string(marshalIndentOrPlaceholder(actual.Headers)))
	}
	if len(expected.SSEFrames) > 0 {
		if !reflectMCPFramesEqual(expected.SSEFrames, actual.SSEFrames) {
			return fmt.Errorf("sse_frames mismatch: expected %s, got %s", string(marshalIndentOrPlaceholder(expected.SSEFrames)), string(marshalIndentOrPlaceholder(actual.SSEFrames)))
		}
		return nil
	}
	if len(expected.BodyJSON) > 0 {
		var expectedJSON any
		if err := json.Unmarshal(expected.BodyJSON, &expectedJSON); err != nil {
			return fmt.Errorf("parse expected body_json: %w", err)
		}
		var actualJSON any
		if err := json.Unmarshal(actual.Body, &actualJSON); err != nil {
			return fmt.Errorf("parse actual body_json: %w (body=%q)", err, string(actual.Body))
		}
		if !jsonEqual(expectedJSON, actualJSON) {
			return fmt.Errorf("body_json mismatch: expected %s, got %s", string(marshalIndentOrPlaceholder(expectedJSON)), string(marshalIndentOrPlaceholder(actualJSON)))
		}
		return nil
	}
	var expectedBody []byte
	if expected.Body != nil {
		var err error
		expectedBody, err = decodeFixtureBody(*expected.Body)
		if err != nil {
			return fmt.Errorf("decode expected body: %w", err)
		}
	}
	if !equalBytes(expectedBody, actual.Body) {
		return fmt.Errorf("body mismatch: expected %q, got %q", string(expectedBody), string(actual.Body))
	}
	return nil
}

func reflectMCPFramesEqual(a, b []FixtureMCPSSEFrame) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func parseMCPSSEFrames(body []byte) ([]FixtureMCPSSEFrame, error) {
	if !bytes.Contains(body, []byte("data: ")) && !bytes.Contains(body, []byte("id: ")) {
		return nil, nil
	}
	chunks := bytes.Split(body, []byte("\n\n"))
	frames := make([]FixtureMCPSSEFrame, 0, len(chunks))
	for _, chunk := range chunks {
		chunk = bytes.Trim(chunk, "\n")
		if len(bytes.TrimSpace(chunk)) == 0 {
			continue
		}
		frame := FixtureMCPSSEFrame{}
		var dataLines []string
		for _, rawLine := range bytes.Split(chunk, []byte("\n")) {
			line := string(rawLine)
			if strings.HasPrefix(line, ":") {
				continue
			}
			switch {
			case strings.HasPrefix(line, "id: "):
				frame.ID = strings.TrimSpace(strings.TrimPrefix(line, "id: "))
			case strings.HasPrefix(line, "event: "):
				frame.Event = strings.TrimSpace(strings.TrimPrefix(line, "event: "))
			case strings.HasPrefix(line, "data: "):
				dataLines = append(dataLines, strings.TrimPrefix(line, "data: "))
			case strings.TrimSpace(line) == "":
				// ignore
			default:
				return nil, fmt.Errorf("invalid SSE line %q", line)
			}
		}
		frame.Data = strings.Join(dataLines, "\n")
		frames = append(frames, frame)
	}
	return frames, nil
}

type fixtureMCPTaskStore struct {
	mu         sync.RWMutex
	sessions   map[string]map[string]*mcp.TaskRecord
	createTime time.Time
	updateTime time.Time
}

func newFixtureMCPTaskStore(config FixtureMCPTaskRuntime) *fixtureMCPTaskStore {
	createTime := timeFromUnixMilliseconds(config.ClockUnixMS)
	if createTime.IsZero() {
		createTime = time.Unix(1772539200, 0).UTC()
	}
	updateTime := timeFromUnixMilliseconds(config.UpdateClockUnixMS)
	if updateTime.IsZero() {
		updateTime = createTime.Add(time.Second)
	}
	return &fixtureMCPTaskStore{
		sessions:   map[string]map[string]*mcp.TaskRecord{},
		createTime: createTime,
		updateTime: updateTime,
	}
}

func (s *fixtureMCPTaskStore) Create(_ context.Context, task mcp.TaskRecord) (*mcp.TaskRecord, error) {
	task.SessionID = strings.TrimSpace(task.SessionID)
	task.Task.TaskID = strings.TrimSpace(task.Task.TaskID)
	if task.SessionID == "" {
		return nil, errors.New("missing session id")
	}
	if task.Task.TaskID == "" {
		return nil, errors.New("missing task id")
	}
	task.Task.CreatedAt = s.createTime
	task.Task.LastUpdatedAt = s.createTime

	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.sessions[task.SessionID]
	if sess == nil {
		sess = map[string]*mcp.TaskRecord{}
		s.sessions[task.SessionID] = sess
	}
	if _, exists := sess[task.Task.TaskID]; exists {
		return nil, errors.New("task already exists")
	}
	sess[task.Task.TaskID] = cloneMCPTaskRecord(&task)
	return cloneMCPTaskRecord(sess[task.Task.TaskID]), nil
}

func (s *fixtureMCPTaskStore) Get(_ context.Context, lookup mcp.TaskLookup) (*mcp.TaskRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record := s.recordLocked(lookup)
	if record == nil {
		return nil, mcp.ErrTaskNotFound
	}
	return cloneMCPTaskRecord(record), nil
}

func (s *fixtureMCPTaskStore) Update(_ context.Context, task mcp.TaskRecord) (*mcp.TaskRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.recordLocked(mcp.TaskLookup{SessionID: task.SessionID, TaskID: task.Task.TaskID})
	if record == nil {
		return nil, mcp.ErrTaskNotFound
	}
	if mcpTaskTerminal(record.Task.Status) {
		return nil, mcp.ErrTaskTerminal
	}
	task.Task.CreatedAt = record.Task.CreatedAt
	task.Task.LastUpdatedAt = s.updateTime
	s.sessions[task.SessionID][task.Task.TaskID] = cloneMCPTaskRecord(&task)
	return cloneMCPTaskRecord(s.sessions[task.SessionID][task.Task.TaskID]), nil
}

func (s *fixtureMCPTaskStore) List(_ context.Context, req mcp.TaskListRequest) (*mcp.TaskListResult, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess := s.sessions[strings.TrimSpace(req.SessionID)]
	if sess == nil {
		return &mcp.TaskListResult{Tasks: []mcp.Task{}}, nil
	}
	records := make([]*mcp.TaskRecord, 0, len(sess))
	for _, record := range sess {
		records = append(records, record)
	}
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].Task.CreatedAt.Equal(records[j].Task.CreatedAt) {
			return records[i].Task.TaskID < records[j].Task.TaskID
		}
		return records[i].Task.CreatedAt.Before(records[j].Task.CreatedAt)
	})
	limit := req.Limit
	if limit <= 0 || limit > len(records) {
		limit = len(records)
	}
	tasks := make([]mcp.Task, 0, limit)
	for _, record := range records[:limit] {
		tasks = append(tasks, record.Task)
	}
	return &mcp.TaskListResult{Tasks: tasks}, nil
}

func (s *fixtureMCPTaskStore) Cancel(_ context.Context, lookup mcp.TaskLookup) (*mcp.TaskRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.recordLocked(lookup)
	if record == nil {
		return nil, mcp.ErrTaskNotFound
	}
	if mcpTaskTerminal(record.Task.Status) {
		return nil, mcp.ErrTaskTerminal
	}
	record.Task.Status = mcp.TaskStatusCanceled
	record.Task.StatusMessage = "task canceled"
	record.Task.LastUpdatedAt = s.updateTime
	record.Error = &mcp.RPCError{Code: mcp.CodeServerError, Message: "task canceled"}
	return cloneMCPTaskRecord(record), nil
}

func (s *fixtureMCPTaskStore) DeleteSession(_ context.Context, sessionID string) error {
	s.mu.Lock()
	delete(s.sessions, strings.TrimSpace(sessionID))
	s.mu.Unlock()
	return nil
}

func (s *fixtureMCPTaskStore) recordLocked(lookup mcp.TaskLookup) *mcp.TaskRecord {
	sess := s.sessions[strings.TrimSpace(lookup.SessionID)]
	if sess == nil {
		return nil
	}
	return sess[strings.TrimSpace(lookup.TaskID)]
}

func mcpTaskTerminal(status mcp.TaskStatus) bool {
	switch status {
	case mcp.TaskStatusCompleted, mcp.TaskStatusFailed, mcp.TaskStatusCanceled:
		return true
	default:
		return false
	}
}

func cloneMCPTaskRecord(in *mcp.TaskRecord) *mcp.TaskRecord {
	if in == nil {
		return nil
	}
	out := *in
	out.Result = append(json.RawMessage(nil), in.Result...)
	if in.Error != nil {
		errCopy := *in.Error
		out.Error = &errCopy
	}
	if in.Task.TTL != nil {
		v := *in.Task.TTL
		out.Task.TTL = &v
	}
	if in.Task.PollInterval != nil {
		v := *in.Task.PollInterval
		out.Task.PollInterval = &v
	}
	return &out
}
