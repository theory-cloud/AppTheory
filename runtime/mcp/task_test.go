package mcp

import (
	"context"
	"encoding/json"
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
	s = NewServer("test", "dev", WithTaskRuntime(TaskRuntimeOptions{Store: store}))
	notReady := s.dispatchForProtocol(context.Background(), taskRequest(4, methodTasksResult, "task-2"), protocolVersion, "sess-1")
	if notReady.Error == nil || notReady.Error.Code != CodeInvalidParams {
		t.Fatalf("expected not-ready task result invalid params, got %+v", notReady.Error)
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
