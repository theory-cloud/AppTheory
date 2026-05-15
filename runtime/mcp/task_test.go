package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestTaskRuntimeContract_AdvertisesTasksOnlyWithExplicitRuntime(t *testing.T) {
	s := NewServer("test", "dev")
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	caps := initializeCapabilityMap(t, s)
	if _, ok := caps["tasks"]; ok {
		t.Fatalf("expected tasks capability omitted without task runtime: %+v", caps)
	}

	s = NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: noopTaskStore{}}))
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register task tool: %v", err)
	}

	caps = initializeCapabilityMap(t, s)
	tasks, ok := caps["tasks"].(map[string]any)
	if !ok {
		t.Fatalf("expected tasks capability object with explicit runtime: %+v", caps)
	}
	if _, hasList := tasks["list"].(map[string]any); !hasList {
		t.Fatalf("expected tasks.list capability: %+v", tasks)
	}
	if _, hasCancel := tasks["cancel"].(map[string]any); !hasCancel {
		t.Fatalf("expected tasks.cancel capability: %+v", tasks)
	}
	requests, ok := tasks["requests"].(map[string]any)
	if !ok {
		t.Fatalf("expected task requests capability for task-capable tool: %+v", tasks)
	}
	tools, ok := requests["tools"].(map[string]any)
	if !ok {
		t.Fatalf("expected task requests.tools capability: %+v", requests)
	}
	if _, ok := tools["call"].(map[string]any); !ok {
		t.Fatalf("expected task requests.tools.call capability: %+v", tools)
	}
}

func TestTaskRuntimeContract_ProtocolGatesTasks(t *testing.T) {
	s := NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: noopTaskStore{}}))
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register task tool: %v", err)
	}

	resp := s.handleInitialize(&Request{JSONRPC: "2.0", ID: 1, Method: methodInitialize}, protocolVersionPrior)
	result, ok := resp.Result.(map[string]any)
	if !ok {
		t.Fatalf("expected initialize result object, got %T", resp.Result)
	}
	caps, ok := result["capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("expected capabilities object, got %T", result["capabilities"])
	}
	if _, ok := caps["tasks"]; ok {
		t.Fatalf("expected tasks to be omitted for prior protocol: %+v", caps)
	}
	if methodAllowedForProtocol(protocolVersionPrior, methodTasksGet) {
		t.Fatalf("expected tasks/get to be disallowed for prior protocol")
	}
	if !methodAllowedForProtocol(protocolVersion, methodTasksGet) {
		t.Fatalf("expected tasks/get to be allowed for latest protocol")
	}
}

func TestTaskRuntimeContract_ExplicitConfigCanDisableTasks(t *testing.T) {
	s := NewServer("test", "dev",
		WithTaskRuntime(TaskRuntimeOptions{Store: noopTaskStore{}}),
		WithCapabilityConfig(CapabilityConfig{Tasks: false}),
	)
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register task tool: %v", err)
	}

	caps := initializeCapabilityMap(t, s)
	if _, ok := caps["tasks"]; ok {
		t.Fatalf("expected explicitly disabled tasks capability to be omitted: %+v", caps)
	}
}

func TestTaskRuntimeContract_ParsesTaskAugmentedToolsCall(t *testing.T) {
	raw := mustMarshal(t, map[string]any{
		"name":      "slow",
		"arguments": map[string]any{"x": 1},
		"task": map[string]any{
			"ttl": 30000,
		},
	})

	var params toolsCallParams
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("unmarshal tools/call params: %v", err)
	}
	if params.Name != "slow" {
		t.Fatalf("unexpected tool name: %q", params.Name)
	}
	if params.Task == nil || params.Task.TTL == nil || *params.Task.TTL != 30000 {
		t.Fatalf("expected task ttl to parse, got %+v", params.Task)
	}
}

func taskCapableToolDef() ToolDef {
	return ToolDef{
		Name:        "slow",
		Description: "task capable",
		Execution:   &ToolExecution{TaskSupport: TaskSupportOptional},
		InputSchema: json.RawMessage(`{"type":"object"}`),
	}
}

type noopTaskStore struct{}

func (noopTaskStore) Create(context.Context, TaskRecord) (*TaskRecord, error) {
	return nil, ErrTaskNotFound
}

func (noopTaskStore) Get(context.Context, TaskLookup) (*TaskRecord, error) {
	return nil, ErrTaskNotFound
}

func (noopTaskStore) Update(context.Context, TaskRecord) (*TaskRecord, error) {
	return nil, ErrTaskNotFound
}

func (noopTaskStore) List(context.Context, TaskListRequest) (*TaskListResult, error) {
	return &TaskListResult{Tasks: []Task{}}, nil
}

func (noopTaskStore) Cancel(context.Context, TaskLookup) (*TaskRecord, error) {
	return nil, ErrTaskNotFound
}

func (noopTaskStore) DeleteSession(context.Context, string) error {
	return nil
}

func TestTaskRuntimeContract_DispatchesTaskMethodsAgainstStore(t *testing.T) {
	store := &recordingTaskStore{record: taskTestRecord("sess-1", "task-1", TaskStatusCompleted)}
	s := NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: store}))
	ctx := context.Background()

	getResp := s.dispatchForProtocol(ctx, taskRequest(1, methodTasksGet, "task-1"), protocolVersion, "sess-1")
	if getResp.Error != nil {
		t.Fatalf("tasks/get error: %+v", getResp.Error)
	}
	gotTask, ok := getResp.Result.(Task)
	if !ok || gotTask.TaskID != "task-1" || gotTask.Status != TaskStatusCompleted {
		t.Fatalf("unexpected tasks/get result: %#v", getResp.Result)
	}
	if store.lastLookup.SessionID != "sess-1" || store.lastLookup.TaskID != "task-1" {
		t.Fatalf("expected session-scoped lookup, got %+v", store.lastLookup)
	}

	resultResp := s.dispatchForProtocol(ctx, taskRequest(2, methodTasksResult, "task-1"), protocolVersion, "sess-1")
	if resultResp.Error != nil {
		t.Fatalf("tasks/result error: %+v", resultResp.Error)
	}
	resultBytes, err := json.Marshal(resultResp.Result)
	if err != nil {
		t.Fatalf("marshal task result: %v", err)
	}
	var result map[string]any
	if err := json.Unmarshal(resultBytes, &result); err != nil {
		t.Fatalf("unmarshal task result: %v", err)
	}
	meta, ok := result["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("expected result metadata, got %+v", result)
	}
	related, ok := meta[relatedTaskMetadataKey].(map[string]any)
	if !ok || related["taskId"] != "task-1" {
		t.Fatalf("expected related task metadata, got %+v", meta)
	}

	listResp := s.dispatchForProtocol(ctx, &Request{JSONRPC: jsonrpcVersion, ID: 3, Method: methodTasksList}, protocolVersion, "sess-1")
	if listResp.Error != nil {
		t.Fatalf("tasks/list error: %+v", listResp.Error)
	}
	listResult, ok := listResp.Result.(*TaskListResult)
	if !ok || len(listResult.Tasks) != 1 {
		t.Fatalf("unexpected tasks/list result: %#v", listResp.Result)
	}
	if store.lastList.SessionID != "sess-1" || store.lastList.Limit != defaultTaskListLimit {
		t.Fatalf("expected session-scoped list request, got %+v", store.lastList)
	}

	cancelResp := s.dispatchForProtocol(ctx, taskRequest(4, methodTasksCancel, "task-1"), protocolVersion, "sess-1")
	if cancelResp.Error != nil {
		t.Fatalf("tasks/cancel error: %+v", cancelResp.Error)
	}
	canceledTask, ok := cancelResp.Result.(Task)
	if !ok || canceledTask.Status != TaskStatusCanceled {
		t.Fatalf("unexpected tasks/cancel result: %#v", cancelResp.Result)
	}
}

func TestTaskRuntimeContract_TaskMethodsFailClosed(t *testing.T) {
	s := NewServer("test", "dev")
	resp := s.dispatchForProtocol(context.Background(), taskRequest(1, methodTasksGet, "task-1"), protocolVersion, "sess-1")
	if resp.Error == nil || resp.Error.Code != CodeMethodNotFound {
		t.Fatalf("expected tasks/get to fail closed without runtime, got %+v", resp.Error)
	}

	s = NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: &recordingTaskStore{}}))
	missing := s.dispatchForProtocol(context.Background(), taskRequest(2, methodTasksGet, "missing"), protocolVersion, "sess-1")
	if missing.Error == nil || missing.Error.Code != CodeInvalidParams {
		t.Fatalf("expected missing task to map to invalid params, got %+v", missing.Error)
	}

	invalid := s.dispatchForProtocol(context.Background(), &Request{JSONRPC: jsonrpcVersion, ID: 3, Method: methodTasksGet, Params: json.RawMessage(`{}`)}, protocolVersion, "sess-1")
	if invalid.Error == nil || invalid.Error.Code != CodeInvalidParams {
		t.Fatalf("expected missing taskId invalid params, got %+v", invalid.Error)
	}

	store := &recordingTaskStore{record: taskTestRecord("sess-1", "task-2", TaskStatusWorking)}
	s = NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: store, PollInterval: time.Millisecond}))
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	notReady := s.dispatchForProtocol(ctx, taskRequest(4, methodTasksResult, "task-2"), protocolVersion, "sess-1")
	if notReady.Error == nil || notReady.Error.Code != CodeServerError {
		t.Fatalf("expected not-ready task result to block until context closes, got %+v", notReady.Error)
	}
}

func TestTaskRuntimeContract_NormalizesOptions(t *testing.T) {
	cfg := normalizeTaskRuntimeOptions(TaskRuntimeOptions{
		Store:        noopTaskStore{},
		DefaultTTL:   3 * time.Hour,
		MaxTTL:       time.Hour,
		PollInterval: -time.Second,
		ListLimit:    maxTaskListLimit + 1,
	})
	if cfg.defaultTTL != time.Hour {
		t.Fatalf("expected default ttl to clamp to max, got %s", cfg.defaultTTL)
	}
	if cfg.pollInterval != defaultTaskPollInterval {
		t.Fatalf("expected default poll interval, got %s", cfg.pollInterval)
	}
	if cfg.listLimit != maxTaskListLimit {
		t.Fatalf("expected list limit clamp, got %d", cfg.listLimit)
	}

	t.Setenv(envTaskTTLMinutes, "7")
	cfg = normalizeTaskRuntimeOptions(TaskRuntimeOptions{Store: noopTaskStore{}})
	if cfg.defaultTTL != 7*time.Minute {
		t.Fatalf("expected default ttl from env, got %s", cfg.defaultTTL)
	}

	t.Setenv(envTaskTTLMinutes, "-1")
	cfg = normalizeTaskRuntimeOptions(TaskRuntimeOptions{Store: noopTaskStore{}})
	if cfg.defaultTTL != defaultTaskTTL {
		t.Fatalf("expected invalid env ttl to fall back, got %s", cfg.defaultTTL)
	}
}

func TestTaskRuntimeContract_ModelImmediateResponseMetadata(t *testing.T) {
	s := NewServer("test", "dev",
		WithServerIDGenerator(staticIDGenerator{id: "task-immediate"}),
		WithTaskRuntime(TaskRuntimeOptions{
			Store:                  NewMemoryTaskStore(),
			ModelImmediateResponse: "Task accepted; check back for the result.",
		}),
	)
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
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
	if got := created.Meta[modelImmediateResponseMetadataKey]; got != "Task accepted; check back for the result." {
		t.Fatalf("expected model immediate response metadata, got %+v", created.Meta)
	}
}

func taskRequest(id int, method, taskID string) *Request {
	return &Request{
		JSONRPC: jsonrpcVersion,
		ID:      id,
		Method:  method,
		Params:  mustMarshalTaskParams(map[string]any{"taskId": taskID}),
	}
}

func taskTestRecord(sessionID, taskID string, status TaskStatus) TaskRecord {
	now := time.Now().UTC()
	ttl := int64(time.Hour / time.Millisecond)
	return TaskRecord{
		SessionID: sessionID,
		Method:    methodToolsCall,
		ToolName:  "slow",
		Task: Task{
			TaskID:        taskID,
			Status:        status,
			CreatedAt:     now,
			LastUpdatedAt: now,
			TTL:           &ttl,
		},
		Result: json.RawMessage(`{"content":[{"type":"text","text":"ok"}],"_meta":{"existing":true}}`),
	}
}

type recordingTaskStore struct {
	record     TaskRecord
	lastLookup TaskLookup
	lastList   TaskListRequest
}

func (s *recordingTaskStore) Create(_ context.Context, task TaskRecord) (*TaskRecord, error) {
	s.record = task
	return &s.record, nil
}

func (s *recordingTaskStore) Get(_ context.Context, lookup TaskLookup) (*TaskRecord, error) {
	s.lastLookup = lookup
	if s.record.Task.TaskID == "" || s.record.Task.TaskID != lookup.TaskID || s.record.SessionID != lookup.SessionID {
		return nil, ErrTaskNotFound
	}
	return &s.record, nil
}

func (s *recordingTaskStore) Update(_ context.Context, task TaskRecord) (*TaskRecord, error) {
	s.record = task
	return &s.record, nil
}

func (s *recordingTaskStore) List(_ context.Context, req TaskListRequest) (*TaskListResult, error) {
	s.lastList = req
	if s.record.Task.TaskID == "" || s.record.SessionID != req.SessionID {
		return &TaskListResult{Tasks: []Task{}}, nil
	}
	return &TaskListResult{Tasks: []Task{s.record.Task}}, nil
}

func (s *recordingTaskStore) Cancel(_ context.Context, lookup TaskLookup) (*TaskRecord, error) {
	s.lastLookup = lookup
	if s.record.Task.TaskID == "" || s.record.Task.TaskID != lookup.TaskID || s.record.SessionID != lookup.SessionID {
		return nil, ErrTaskNotFound
	}
	s.record.Task.Status = TaskStatusCanceled
	s.record.Task.LastUpdatedAt = time.Now().UTC()
	return &s.record, nil
}

func (s *recordingTaskStore) DeleteSession(_ context.Context, sessionID string) error {
	if s.record.SessionID == sessionID {
		s.record = TaskRecord{}
	}
	return nil
}

func mustMarshalTaskParams(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func TestTaskRuntimeToolsCall_CompletesAndReturnsResult(t *testing.T) {
	store := NewMemoryTaskStore()
	s := NewServer("test", "dev",
		WithServerIDGenerator(staticIDGenerator{id: "task-1"}),
		WithTaskRuntime(TaskRuntimeOptions{Store: store}),
	)
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "done"}}}, nil
	}); err != nil {
		t.Fatalf("register task tool: %v", err)
	}

	createResp := s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(1, "slow"), protocolVersion, "sess-1")
	if createResp.Error != nil {
		t.Fatalf("tools/call task create error: %+v", createResp.Error)
	}
	created, ok := createResp.Result.(CreateTaskResult)
	if !ok {
		t.Fatalf("expected create task result, got %#v", createResp.Result)
	}
	if created.Task.TaskID != "task-1" || created.Task.Status != TaskStatusWorking {
		t.Fatalf("unexpected create task: %+v", created.Task)
	}
	if _, ok := created.Meta[relatedTaskMetadataKey].(RelatedTaskMetadata); !ok {
		t.Fatalf("expected related task metadata: %+v", created.Meta)
	}

	record := waitForTaskStatus(t, store, "sess-1", "task-1", TaskStatusCompleted)
	if len(record.Result) == 0 {
		t.Fatal("expected task result to be stored")
	}

	resultResp := s.dispatchForProtocol(context.Background(), taskRequest(2, methodTasksResult, "task-1"), protocolVersion, "sess-1")
	if resultResp.Error != nil {
		t.Fatalf("tasks/result error: %+v", resultResp.Error)
	}
	resultBytes, err := json.Marshal(resultResp.Result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if !json.Valid(resultBytes) || !bytes.Contains(resultBytes, []byte(`"done"`)) || !bytes.Contains(resultBytes, []byte(relatedTaskMetadataKey)) {
		t.Fatalf("expected tool result with related task metadata, got %s", string(resultBytes))
	}
}

func TestTaskRuntimeToolsCall_ResultBlocksUntilTerminal(t *testing.T) {
	store := NewMemoryTaskStore()
	record := taskTestRecord("sess-1", "task-blocking-result", TaskStatusWorking)
	record.Result = nil
	if _, err := store.Create(context.Background(), record); err != nil {
		t.Fatalf("create working task: %v", err)
	}

	s := NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: store, PollInterval: 5 * time.Millisecond}))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	done := make(chan *Response, 1)
	go func() {
		done <- s.dispatchForProtocol(ctx, taskRequest(1, methodTasksResult, "task-blocking-result"), protocolVersion, "sess-1")
	}()

	select {
	case resp := <-done:
		t.Fatalf("tasks/result returned before task reached terminal status: %+v", resp)
	case <-time.After(25 * time.Millisecond):
	}

	completed := taskTestRecord("sess-1", "task-blocking-result", TaskStatusCompleted)
	completed.Result = json.RawMessage(`{"content":[{"type":"text","text":"later"}]}`)
	if _, err := store.Update(context.Background(), completed); err != nil {
		t.Fatalf("complete task: %v", err)
	}

	select {
	case resp := <-done:
		if resp.Error != nil {
			t.Fatalf("tasks/result error after completion: %+v", resp.Error)
		}
		resultBytes, err := json.Marshal(resp.Result)
		if err != nil {
			t.Fatalf("marshal result: %v", err)
		}
		if !bytes.Contains(resultBytes, []byte(`"later"`)) || !bytes.Contains(resultBytes, []byte(relatedTaskMetadataKey)) {
			t.Fatalf("expected completed result with related task metadata, got %s", string(resultBytes))
		}
	case <-time.After(time.Second):
		t.Fatal("tasks/result did not return after task completion")
	}
}

func TestTaskRuntimeToolsCall_ErrorResultFailsTaskButReturnsToolResult(t *testing.T) {
	store := NewMemoryTaskStore()
	s := NewServer("test", "dev",
		WithServerIDGenerator(staticIDGenerator{id: "task-tool-error-result"}),
		WithTaskRuntime(TaskRuntimeOptions{Store: store}),
	)
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{
			Content: []ContentBlock{{Type: "text", Text: "tool failed"}},
			IsError: true,
		}, nil
	}); err != nil {
		t.Fatalf("register task tool: %v", err)
	}

	createResp := s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(1, "slow"), protocolVersion, "sess-1")
	if createResp.Error != nil {
		t.Fatalf("tools/call task create error: %+v", createResp.Error)
	}
	record := waitForTaskStatus(t, store, "sess-1", "task-tool-error-result", TaskStatusFailed)
	if record.Error != nil {
		t.Fatalf("expected isError tool result to fail task status without JSON-RPC error, got %+v", record.Error)
	}
	if record.Task.StatusMessage == "" {
		t.Fatal("expected failed task status message")
	}

	resultResp := s.dispatchForProtocol(context.Background(), taskRequest(2, methodTasksResult, "task-tool-error-result"), protocolVersion, "sess-1")
	if resultResp.Error != nil {
		t.Fatalf("expected tasks/result to return successful tool result, got %+v", resultResp.Error)
	}
	resultBytes, err := json.Marshal(resultResp.Result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if !bytes.Contains(resultBytes, []byte(`"isError":true`)) || !bytes.Contains(resultBytes, []byte(`"tool failed"`)) {
		t.Fatalf("expected original isError tool result, got %s", string(resultBytes))
	}
}

func TestTaskRuntimeToolsCall_CancelStopsInFlightTool(t *testing.T) {
	store := NewMemoryTaskStore()
	s := NewServer("test", "dev",
		WithServerIDGenerator(staticIDGenerator{id: "task-cancel"}),
		WithTaskRuntime(TaskRuntimeOptions{Store: store}),
	)
	started := make(chan struct{})
	canceled := make(chan struct{})
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(ctx context.Context, _ json.RawMessage) (*ToolResult, error) {
		close(started)
		<-ctx.Done()
		close(canceled)
		return nil, ctx.Err()
	}); err != nil {
		t.Fatalf("register task tool: %v", err)
	}

	createResp := s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(1, "slow"), protocolVersion, "sess-1")
	if createResp.Error != nil {
		t.Fatalf("tools/call task create error: %+v", createResp.Error)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("task tool did not start")
	}

	cancelResp := s.dispatchForProtocol(context.Background(), taskRequest(2, methodTasksCancel, "task-cancel"), protocolVersion, "sess-1")
	if cancelResp.Error != nil {
		t.Fatalf("tasks/cancel error: %+v", cancelResp.Error)
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("task tool context was not canceled")
	}

	record, err := store.Get(context.Background(), TaskLookup{SessionID: "sess-1", TaskID: "task-cancel"})
	if err != nil {
		t.Fatalf("get canceled task: %v", err)
	}
	if record.Task.Status != TaskStatusCanceled {
		t.Fatalf("expected canceled task status, got %+v", record.Task)
	}

	resultResp := s.dispatchForProtocol(context.Background(), taskRequest(3, methodTasksResult, "task-cancel"), protocolVersion, "sess-1")
	if resultResp.Error == nil || resultResp.Error.Code != CodeServerError {
		t.Fatalf("expected canceled task result to return cancellation error, got %+v", resultResp.Error)
	}
}

func TestTaskRuntimeToolsCall_EnforcesToolSupport(t *testing.T) {
	s := NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: NewMemoryTaskStore()}))
	if err := s.Registry().RegisterTool(ToolDef{
		Name:        "required",
		Description: "requires tasks",
		Execution:   &ToolExecution{TaskSupport: TaskSupportRequired},
		InputSchema: json.RawMessage(`{"type":"object"}`),
	}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register required tool: %v", err)
	}
	if err := s.Registry().RegisterTool(ToolDef{Name: "plain", InputSchema: json.RawMessage(`{"type":"object"}`)}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "plain"}}}, nil
	}); err != nil {
		t.Fatalf("register plain tool: %v", err)
	}

	requiredSync := s.dispatchForProtocol(context.Background(), toolsCallRequest(1, "required"), protocolVersion, "sess-1")
	if requiredSync.Error == nil || requiredSync.Error.Code != CodeMethodNotFound {
		t.Fatalf("expected required task tool to reject sync call, got %+v", requiredSync.Error)
	}

	plainTask := s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(2, "plain"), protocolVersion, "sess-1")
	if plainTask.Error == nil || plainTask.Error.Code != CodeMethodNotFound {
		t.Fatalf("expected plain tool to reject task call, got %+v", plainTask.Error)
	}

	plainSync := s.dispatchForProtocol(context.Background(), toolsCallRequest(3, "plain"), protocolVersion, "sess-1")
	if plainSync.Error != nil {
		t.Fatalf("expected plain sync call to work, got %+v", plainSync.Error)
	}
}

func TestTaskRuntimeToolsCall_FailsClosedOnRuntimeErrors(t *testing.T) {
	s := NewServer("test", "dev")
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register task tool: %v", err)
	}
	resp := s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(1, "slow"), protocolVersion, "sess-1")
	if resp.Error != nil {
		t.Fatalf("expected task metadata to be ignored without advertised task runtime, got %+v", resp.Error)
	}

	s = NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: NewMemoryTaskStore()}))
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register task tool with runtime: %v", err)
	}
	resp = s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(2, "slow"), protocolVersion, "")
	if resp.Error == nil || resp.Error.Code != CodeInvalidParams {
		t.Fatalf("expected task call without session to fail closed, got %+v", resp.Error)
	}

	s = NewServer("test", "dev",
		WithServerIDGenerator(staticIDGenerator{id: ""}),
		WithTaskRuntime(TaskRuntimeOptions{Store: NewMemoryTaskStore()}),
	)
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register task tool with empty id generator: %v", err)
	}
	resp = s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(3, "slow"), protocolVersion, "sess-1")
	if resp.Error == nil || resp.Error.Code != CodeInternalError {
		t.Fatalf("expected empty task id to fail closed, got %+v", resp.Error)
	}

	s = NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: createFailTaskStore{err: errors.New("create failed")}}))
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register task tool with failing store: %v", err)
	}
	resp = s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(4, "slow"), protocolVersion, "sess-1")
	if resp.Error == nil || resp.Error.Code != CodeServerError {
		t.Fatalf("expected task store create failure to be server error, got %+v", resp.Error)
	}
}

type createFailTaskStore struct {
	noopTaskStore
	err error
}

func (s createFailTaskStore) Create(context.Context, TaskRecord) (*TaskRecord, error) {
	return nil, s.err
}

func TestMemoryTaskStore_ListPaginationAndTerminalUpdates(t *testing.T) {
	store := NewMemoryTaskStore()
	record1 := taskTestRecord("sess-1", "task-1", TaskStatusWorking)
	record2 := taskTestRecord("sess-1", "task-2", TaskStatusWorking)
	record2.Task.CreatedAt = record1.Task.CreatedAt.Add(time.Second)
	if _, err := store.Create(context.Background(), record1); err != nil {
		t.Fatalf("create first task: %v", err)
	}
	if _, err := store.Create(context.Background(), record2); err != nil {
		t.Fatalf("create second task: %v", err)
	}

	firstPage, err := store.List(context.Background(), TaskListRequest{SessionID: "sess-1", Limit: 1})
	if err != nil {
		t.Fatalf("list first page: %v", err)
	}
	if len(firstPage.Tasks) != 1 || firstPage.Tasks[0].TaskID != "task-1" || firstPage.NextCursor == "" {
		t.Fatalf("unexpected first page: %+v", firstPage)
	}
	secondPage, err := store.List(context.Background(), TaskListRequest{SessionID: "sess-1", Cursor: firstPage.NextCursor, Limit: 1})
	if err != nil {
		t.Fatalf("list second page: %v", err)
	}
	if len(secondPage.Tasks) != 1 || secondPage.Tasks[0].TaskID != "task-2" || secondPage.NextCursor != "" {
		t.Fatalf("unexpected second page: %+v", secondPage)
	}

	if _, cancelErr := store.Cancel(context.Background(), TaskLookup{SessionID: "sess-1", TaskID: "task-1"}); cancelErr != nil {
		t.Fatalf("cancel task: %v", cancelErr)
	}
	record1.Task.Status = TaskStatusCompleted
	if _, updateErr := store.Update(context.Background(), record1); !errors.Is(updateErr, ErrTaskTerminal) {
		t.Fatalf("expected terminal task update to fail closed, got %v", updateErr)
	}
	if deleteErr := store.DeleteSession(context.Background(), "sess-1"); deleteErr != nil {
		t.Fatalf("delete session: %v", deleteErr)
	}
	list, err := store.List(context.Background(), TaskListRequest{SessionID: "sess-1"})
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if len(list.Tasks) != 0 {
		t.Fatalf("expected tasks deleted with session, got %+v", list.Tasks)
	}
}

func toolsCallTaskRequest(id int, name string) *Request {
	params := toolsCallParams{Name: name, Arguments: json.RawMessage(`{}`), Task: &TaskMetadata{}}
	return &Request{JSONRPC: jsonrpcVersion, ID: id, Method: methodToolsCall, Params: mustMarshalTaskParams(params)}
}

func toolsCallRequest(id int, name string) *Request {
	params := toolsCallParams{Name: name, Arguments: json.RawMessage(`{}`)}
	return &Request{JSONRPC: jsonrpcVersion, ID: id, Method: methodToolsCall, Params: mustMarshalTaskParams(params)}
}

func waitForTaskStatus(t *testing.T, store TaskStore, sessionID, taskID string, status TaskStatus) *TaskRecord {
	t.Helper()
	deadline := time.After(time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		record, err := store.Get(context.Background(), TaskLookup{SessionID: sessionID, TaskID: taskID})
		if err == nil && record.Task.Status == status {
			return record
		}
		select {
		case <-deadline:
			if err != nil {
				t.Fatalf("task did not reach %s: %v", status, err)
			}
			t.Fatalf("task did not reach %s; latest status %s", status, record.Task.Status)
		case <-ticker.C:
		}
	}
}

func TestTaskRuntimeToolsCall_FailureAndPanicBecomeFailedTasks(t *testing.T) {
	for _, tc := range []struct {
		name    string
		taskID  string
		handler ToolHandler
		code    int
	}{
		{
			name:   "handler error",
			taskID: "task-error",
			handler: func(context.Context, json.RawMessage) (*ToolResult, error) {
				return nil, errors.New("boom")
			},
			code: CodeServerError,
		},
		{
			name:   "panic",
			taskID: "task-panic",
			handler: func(context.Context, json.RawMessage) (*ToolResult, error) {
				panic("secret panic")
			},
			code: CodeInternalError,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := NewMemoryTaskStore()
			s := NewServer("test", "dev",
				WithServerIDGenerator(staticIDGenerator{id: tc.taskID}),
				WithTaskRuntime(TaskRuntimeOptions{Store: store}),
			)
			if err := s.Registry().RegisterTool(taskCapableToolDef(), tc.handler); err != nil {
				t.Fatalf("register task tool: %v", err)
			}

			createResp := s.dispatchForProtocol(context.Background(), toolsCallTaskRequest(1, "slow"), protocolVersion, "sess-1")
			if createResp.Error != nil {
				t.Fatalf("tools/call task create error: %+v", createResp.Error)
			}
			record := waitForTaskStatus(t, store, "sess-1", tc.taskID, TaskStatusFailed)
			if record.Error == nil || record.Error.Code != tc.code {
				t.Fatalf("expected task error code %d, got %+v", tc.code, record.Error)
			}

			resultResp := s.dispatchForProtocol(context.Background(), taskRequest(2, methodTasksResult, tc.taskID), protocolVersion, "sess-1")
			if resultResp.Error == nil || resultResp.Error.Code != tc.code {
				t.Fatalf("expected tasks/result to return task error code %d, got %+v", tc.code, resultResp.Error)
			}
		})
	}
}

func TestTaskRuntimeToolsCall_ValidatesTTL(t *testing.T) {
	s := NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: NewMemoryTaskStore(), MaxTTL: time.Second}))
	if err := s.Registry().RegisterTool(taskCapableToolDef(), func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
	}); err != nil {
		t.Fatalf("register task tool: %v", err)
	}

	zero := int64(0)
	resp := s.dispatchForProtocol(context.Background(), toolsCallTaskRequestWithTTL(1, "slow", &zero), protocolVersion, "sess-1")
	if resp.Error == nil || resp.Error.Code != CodeInvalidParams {
		t.Fatalf("expected zero ttl invalid params, got %+v", resp.Error)
	}
	twoSeconds := int64(2000)
	resp = s.dispatchForProtocol(context.Background(), toolsCallTaskRequestWithTTL(2, "slow", &twoSeconds), protocolVersion, "sess-1")
	if resp.Error == nil || resp.Error.Code != CodeInvalidParams {
		t.Fatalf("expected excessive ttl invalid params, got %+v", resp.Error)
	}
}

func TestTaskRuntimeMethods_ErrorPaths(t *testing.T) {
	store := &recordingTaskStore{record: taskTestRecord("sess-1", "task-bad", TaskStatusCompleted)}
	store.record.Result = json.RawMessage(`not-json`)
	s := NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: store}))

	badResult := s.dispatchForProtocol(context.Background(), taskRequest(1, methodTasksResult, "task-bad"), protocolVersion, "sess-1")
	if badResult.Error == nil || badResult.Error.Code != CodeServerError {
		t.Fatalf("expected malformed task result server error, got %+v", badResult.Error)
	}

	badJSON := s.dispatchForProtocol(context.Background(), &Request{JSONRPC: jsonrpcVersion, ID: 2, Method: methodTasksList, Params: json.RawMessage(`{"cursor":`)}, protocolVersion, "sess-1")
	if badJSON.Error == nil || badJSON.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid tasks/list params, got %+v", badJSON.Error)
	}

	badLookup := s.dispatchForProtocol(context.Background(), &Request{JSONRPC: jsonrpcVersion, ID: 22, Method: methodTasksGet, Params: json.RawMessage(`{"taskId":`)}, protocolVersion, "sess-1")
	if badLookup.Error == nil || badLookup.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid task lookup params, got %+v", badLookup.Error)
	}

	nilListStore := &nilListTaskStore{}
	s = NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: nilListStore}))
	nilList := s.dispatchForProtocol(context.Background(), &Request{JSONRPC: jsonrpcVersion, ID: 23, Method: methodTasksList}, protocolVersion, "sess-1")
	if nilList.Error != nil {
		t.Fatalf("expected nil task list to normalize, got %+v", nilList.Error)
	}
	nilListResult, ok := nilList.Result.(*TaskListResult)
	if !ok || len(nilListResult.Tasks) != 0 {
		t.Fatalf("expected empty normalized task list, got %#v", nilList.Result)
	}

	mem := NewMemoryTaskStore()
	s = NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: mem}))
	badCursor := s.dispatchForProtocol(context.Background(), &Request{JSONRPC: jsonrpcVersion, ID: 3, Method: methodTasksList, Params: json.RawMessage(`{"cursor":"nope"}`)}, protocolVersion, "sess-1")
	if badCursor.Error == nil || badCursor.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid cursor invalid params, got %+v", badCursor.Error)
	}
}

type nilListTaskStore struct {
	noopTaskStore
}

func (s *nilListTaskStore) List(context.Context, TaskListRequest) (*TaskListResult, error) {
	return &TaskListResult{}, nil
}

func TestTaskRuntimeHelpers_ErrorBranches(t *testing.T) {
	if durationMilliseconds(0) != 0 {
		t.Fatal("expected non-positive duration to return zero milliseconds")
	}

	finish := (*taskExecutionTracker)(nil).track("sess", "task", func() {})
	finish()
	if (*taskExecutionTracker)(nil).cancel("sess", "task") {
		t.Fatal("expected nil task execution tracker cancel to return false")
	}
	tracker := newTaskExecutionTracker()
	if tracker.cancel("sess", "missing") {
		t.Fatal("expected missing task execution cancel to return false")
	}

	if _, err := taskResultWithRelatedMetadata(json.RawMessage(`[]`), "task-1"); err == nil {
		t.Fatal("expected non-object task result to fail")
	}
}

func TestMemoryTaskStore_FailsClosedOnInvalidWrites(t *testing.T) {
	store := NewMemoryTaskStore()
	if _, err := store.Create(context.Background(), TaskRecord{}); err == nil {
		t.Fatal("expected missing session/task ids to fail")
	}
	record := taskTestRecord("sess-1", "task-1", TaskStatusWorking)
	if _, err := store.Create(context.Background(), record); err != nil {
		t.Fatalf("create task: %v", err)
	}
	if _, err := store.Create(context.Background(), record); err == nil {
		t.Fatal("expected duplicate task create to fail")
	}
	if _, err := store.Get(context.Background(), TaskLookup{SessionID: "sess-1", TaskID: "missing"}); !errors.Is(err, ErrTaskNotFound) {
		t.Fatalf("expected missing task error, got %v", err)
	}
	if _, err := store.List(context.Background(), TaskListRequest{SessionID: "sess-1", Cursor: "bad"}); err == nil {
		t.Fatal("expected invalid cursor error")
	}
	if _, err := store.Cancel(context.Background(), TaskLookup{}); !errors.Is(err, ErrTaskNotFound) {
		t.Fatalf("expected invalid cancel lookup to fail closed, got %v", err)
	}
}

func toolsCallTaskRequestWithTTL(id int, name string, ttl *int64) *Request {
	params := toolsCallParams{Name: name, Arguments: json.RawMessage(`{}`), Task: &TaskMetadata{TTL: ttl}}
	return &Request{JSONRPC: jsonrpcVersion, ID: id, Method: methodToolsCall, Params: mustMarshalTaskParams(params)}
}
