package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	defaultTaskTTL          = 10 * time.Minute
	defaultTaskMaxTTL       = time.Hour
	defaultTaskPollInterval = 5 * time.Second
	defaultTaskListLimit    = 100
	maxTaskListLimit        = 500
)

const relatedTaskMetadataKey = "io.modelcontextprotocol/related-task"

// TaskSupport declares whether a tool can be invoked through MCP task
// augmentation.
type TaskSupport string

const (
	TaskSupportForbidden TaskSupport = "forbidden"
	TaskSupportOptional  TaskSupport = "optional"
	TaskSupportRequired  TaskSupport = "required"
)

// TaskStatus is an MCP task lifecycle state.
type TaskStatus string

const (
	TaskStatusWorking       TaskStatus = "working"
	TaskStatusInputRequired TaskStatus = "input_required"
	TaskStatusCompleted     TaskStatus = "completed"
	TaskStatusFailed        TaskStatus = "failed"
	TaskStatusCanceled      TaskStatus = "cancel" + "led"
)

// Task is the MCP task state returned by task operations.
type Task struct {
	TaskID        string     `json:"taskId"`
	Status        TaskStatus `json:"status"`
	StatusMessage string     `json:"statusMessage,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	LastUpdatedAt time.Time  `json:"lastUpdatedAt"`
	TTL           *int64     `json:"ttl"`
	PollInterval  *int64     `json:"pollInterval,omitempty"`
}

// TaskMetadata is the MCP request parameter used to request task-augmented
// execution.
type TaskMetadata struct {
	TTL *int64 `json:"ttl,omitempty"`
}

// RelatedTaskMetadata is the MCP _meta entry that associates messages with a
// task.
type RelatedTaskMetadata struct {
	TaskID string `json:"taskId"`
}

// CreateTaskResult is returned when AppTheory accepts a task-augmented request.
type CreateTaskResult struct {
	Meta map[string]any `json:"_meta,omitempty"`
	Task Task           `json:"task"`
}

// TaskRecord is the durable representation stored by TaskStore implementations.
type TaskRecord struct {
	SessionID string          `json:"sessionId"`
	Method    string          `json:"method"`
	ToolName  string          `json:"toolName,omitempty"`
	Task      Task            `json:"task"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *RPCError       `json:"error,omitempty"`
}

// TaskLookup scopes a task lookup to the active MCP session.
type TaskLookup struct {
	SessionID string `json:"sessionId"`
	TaskID    string `json:"taskId"`
}

// TaskListRequest scopes a task listing to the active MCP session.
type TaskListRequest struct {
	SessionID string `json:"sessionId"`
	Cursor    string `json:"cursor,omitempty"`
	Limit     int    `json:"limit,omitempty"`
}

// TaskListResult is the MCP tasks/list result.
type TaskListResult struct {
	Tasks      []Task `json:"tasks"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// TaskStore persists MCP task state. Implementations must bind every operation
// to the supplied SessionID and fail closed if a task belongs to a different
// authorization context.
type TaskStore interface {
	Create(ctx context.Context, task TaskRecord) (*TaskRecord, error)
	Get(ctx context.Context, lookup TaskLookup) (*TaskRecord, error)
	Update(ctx context.Context, task TaskRecord) (*TaskRecord, error)
	List(ctx context.Context, req TaskListRequest) (*TaskListResult, error)
	Cancel(ctx context.Context, lookup TaskLookup) (*TaskRecord, error)
	DeleteSession(ctx context.Context, sessionID string) error
}

// ErrTaskNotFound is returned when a task does not exist in the caller's
// session scope.
var ErrTaskNotFound = errors.New("task not found")

// ErrTaskTerminal is returned when a mutation targets a task that is already in
// a terminal state.
var ErrTaskTerminal = errors.New("task already terminal")

// TaskRuntimeOptions configures task-augmented MCP execution.
type TaskRuntimeOptions struct {
	Store                  TaskStore
	DefaultTTL             time.Duration
	MaxTTL                 time.Duration
	PollInterval           time.Duration
	ListLimit              int
	ModelImmediateResponse string
}

type taskRuntimeConfig struct {
	store                  TaskStore
	defaultTTL             time.Duration
	maxTTL                 time.Duration
	pollInterval           time.Duration
	listLimit              int
	modelImmediateResponse string
}

func normalizeTaskRuntimeOptions(opts TaskRuntimeOptions) taskRuntimeConfig {
	defaultTTL := opts.DefaultTTL
	if defaultTTL <= 0 {
		defaultTTL = defaultTaskTTL
	}

	maxTTL := opts.MaxTTL
	if maxTTL <= 0 {
		maxTTL = defaultTaskMaxTTL
	}
	if defaultTTL > maxTTL {
		defaultTTL = maxTTL
	}

	pollInterval := opts.PollInterval
	if pollInterval <= 0 {
		pollInterval = defaultTaskPollInterval
	}

	listLimit := opts.ListLimit
	if listLimit <= 0 {
		listLimit = defaultTaskListLimit
	}
	if listLimit > maxTaskListLimit {
		listLimit = maxTaskListLimit
	}

	return taskRuntimeConfig{
		store:                  opts.Store,
		defaultTTL:             defaultTTL,
		maxTTL:                 maxTTL,
		pollInterval:           pollInterval,
		listLimit:              listLimit,
		modelImmediateResponse: strings.TrimSpace(opts.ModelImmediateResponse),
	}
}

func (s *Server) hasTaskRuntime() bool {
	return s != nil && s.taskRuntime.store != nil
}

func (s *Server) handleTaskToolsCall(ctx context.Context, req *Request, sessionID string, params toolsCallParams) *Response {
	if !s.hasTaskRuntime() {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: task runtime not configured")
	}
	if strings.TrimSpace(sessionID) == "" {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing session id")
	}

	switch s.registry.taskSupport(params.Name) {
	case TaskSupportOptional, TaskSupportRequired:
		// ok
	default:
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: tool does not support task execution")
	}

	ttl, errResp := s.taskTTL(req.ID, params.Task)
	if errResp != nil {
		return errResp
	}
	pollInterval := durationMilliseconds(s.taskRuntime.pollInterval)
	now := time.Now().UTC()
	taskID := strings.TrimSpace(s.idGen.NewID())
	if taskID == "" {
		return NewErrorResponse(req.ID, CodeInternalError, "task id generator returned empty id")
	}

	record := TaskRecord{
		SessionID: sessionID,
		Method:    methodToolsCall,
		ToolName:  params.Name,
		Task: Task{
			TaskID:        taskID,
			Status:        TaskStatusWorking,
			CreatedAt:     now,
			LastUpdatedAt: now,
			TTL:           &ttl,
			PollInterval:  &pollInterval,
		},
	}
	created, err := s.taskRuntime.store.Create(ctx, record)
	if err != nil {
		return NewErrorResponse(req.ID, CodeServerError, err.Error())
	}
	if created == nil {
		return NewErrorResponse(req.ID, CodeServerError, "task store returned nil task")
	}

	taskCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	finish := s.taskExecutions.track(sessionID, created.Task.TaskID, cancel)
	go s.runTaskTool(taskCtx, *created, params.Arguments, finish)

	return NewResultResponse(req.ID, CreateTaskResult{
		Meta: map[string]any{relatedTaskMetadataKey: RelatedTaskMetadata{TaskID: created.Task.TaskID}},
		Task: created.Task,
	})
}

func (s *Server) taskTTL(reqID any, meta *TaskMetadata) (int64, *Response) {
	ttl := s.taskRuntime.defaultTTL
	if meta != nil && meta.TTL != nil {
		if *meta.TTL <= 0 {
			return 0, NewErrorResponse(reqID, CodeInvalidParams, "Invalid params: task.ttl must be positive")
		}
		ttl = time.Duration(*meta.TTL) * time.Millisecond
	}
	if ttl > s.taskRuntime.maxTTL {
		return 0, NewErrorResponse(reqID, CodeInvalidParams, "Invalid params: task.ttl exceeds maximum")
	}
	return durationMilliseconds(ttl), nil
}

func durationMilliseconds(d time.Duration) int64 {
	if d <= 0 {
		return 0
	}
	return int64(d / time.Millisecond)
}

func (s *Server) runTaskTool(ctx context.Context, record TaskRecord, args json.RawMessage, finish func()) {
	defer finish()
	defer func() {
		if r := recover(); r != nil {
			s.logger.ErrorContext(ctx, "task tool panic", "taskId", record.Task.TaskID, "tool", record.ToolName, "panic", r)
			s.finishTask(ctx, record, nil, &RPCError{Code: CodeInternalError, Message: "internal error"})
		}
	}()

	result, err := s.registry.Call(ctx, record.ToolName, args)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		s.finishTask(ctx, record, nil, &RPCError{Code: CodeServerError, Message: err.Error()})
		return
	}

	resultBytes, err := json.Marshal(result)
	if err != nil {
		s.finishTask(ctx, record, nil, &RPCError{Code: CodeServerError, Message: "task result marshal failed"})
		return
	}
	s.finishTask(ctx, record, resultBytes, nil)
}

func (s *Server) finishTask(ctx context.Context, record TaskRecord, result json.RawMessage, rpcErr *RPCError) {
	now := time.Now().UTC()
	record.Task.LastUpdatedAt = now
	record.Result = append(json.RawMessage(nil), result...)
	record.Error = rpcErr
	if rpcErr != nil {
		record.Task.Status = TaskStatusFailed
		if record.Task.StatusMessage == "" {
			record.Task.StatusMessage = rpcErr.Message
		}
	} else {
		record.Task.Status = TaskStatusCompleted
	}
	if _, err := s.taskRuntime.store.Update(context.WithoutCancel(ctx), record); err != nil && !errors.Is(err, ErrTaskTerminal) {
		s.logger.ErrorContext(ctx, "task store update error", "taskId", record.Task.TaskID, "tool", record.ToolName, "error", err)
	}
}

func (s *Server) handleTasksGet(ctx context.Context, req *Request, sessionID string) *Response {
	lookup, errResp := taskLookupFromRequest(req)
	if errResp != nil {
		return errResp
	}
	lookup.SessionID = sessionID

	record, err := s.taskRuntime.store.Get(ctx, lookup)
	if err != nil {
		return taskStoreError(req.ID, err)
	}
	return NewResultResponse(req.ID, record.Task)
}

func (s *Server) handleTasksResult(ctx context.Context, req *Request, sessionID string) *Response {
	lookup, errResp := taskLookupFromRequest(req)
	if errResp != nil {
		return errResp
	}
	lookup.SessionID = sessionID

	record, err := s.taskRuntime.store.Get(ctx, lookup)
	if err != nil {
		return taskStoreError(req.ID, err)
	}
	if !taskStatusTerminal(record.Task.Status) && record.Task.Status != TaskStatusInputRequired {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: task result not ready")
	}
	if record.Error != nil {
		return &Response{JSONRPC: jsonrpcVersion, ID: req.ID, Error: record.Error}
	}
	if len(bytes.TrimSpace(record.Result)) == 0 {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: task result not available")
	}

	result, err := taskResultWithRelatedMetadata(record.Result, record.Task.TaskID)
	if err != nil {
		return NewErrorResponse(req.ID, CodeServerError, err.Error())
	}
	return NewResultResponse(req.ID, result)
}

func (s *Server) handleTasksList(ctx context.Context, req *Request, sessionID string) *Response {
	var params struct {
		Cursor string `json:"cursor,omitempty"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil && len(bytes.TrimSpace(req.Params)) > 0 {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
	}

	result, err := s.taskRuntime.store.List(ctx, TaskListRequest{
		SessionID: sessionID,
		Cursor:    params.Cursor,
		Limit:     s.taskRuntime.listLimit,
	})
	if err != nil {
		return taskStoreError(req.ID, err)
	}
	if result == nil {
		result = &TaskListResult{Tasks: []Task{}}
	}
	if result.Tasks == nil {
		result.Tasks = []Task{}
	}
	return NewResultResponse(req.ID, result)
}

func (s *Server) handleTasksCancel(ctx context.Context, req *Request, sessionID string) *Response {
	lookup, errResp := taskLookupFromRequest(req)
	if errResp != nil {
		return errResp
	}
	lookup.SessionID = sessionID

	record, err := s.taskRuntime.store.Cancel(ctx, lookup)
	if err != nil {
		return taskStoreError(req.ID, err)
	}
	if s.taskExecutions != nil {
		s.taskExecutions.cancel(sessionID, lookup.TaskID)
	}
	return NewResultResponse(req.ID, record.Task)
}

func taskLookupFromRequest(req *Request) (TaskLookup, *Response) {
	var params struct {
		TaskID string `json:"taskId"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return TaskLookup{}, NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
	}
	if strings.TrimSpace(params.TaskID) == "" {
		return TaskLookup{}, NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing taskId")
	}
	return TaskLookup{TaskID: strings.TrimSpace(params.TaskID)}, nil
}

type taskExecutionTracker struct {
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func newTaskExecutionTracker() *taskExecutionTracker {
	return &taskExecutionTracker{cancels: map[string]context.CancelFunc{}}
}

func (t *taskExecutionTracker) track(sessionID, taskID string, cancel context.CancelFunc) func() {
	if t == nil || cancel == nil {
		return func() {}
	}
	key := taskExecutionKey(sessionID, taskID)
	t.mu.Lock()
	t.cancels[key] = cancel
	t.mu.Unlock()
	return func() {
		t.mu.Lock()
		delete(t.cancels, key)
		t.mu.Unlock()
	}
}

func (t *taskExecutionTracker) cancel(sessionID, taskID string) bool {
	if t == nil {
		return false
	}
	key := taskExecutionKey(sessionID, taskID)
	t.mu.Lock()
	cancel := t.cancels[key]
	t.mu.Unlock()
	if cancel == nil {
		return false
	}
	cancel()
	return true
}

func taskExecutionKey(sessionID, taskID string) string {
	return sessionID + "\x00" + taskID
}

func taskStoreError(reqID any, err error) *Response {
	switch {
	case errors.Is(err, ErrTaskNotFound):
		return NewErrorResponse(reqID, CodeInvalidParams, err.Error())
	case errors.Is(err, ErrTaskTerminal):
		return NewErrorResponse(reqID, CodeInvalidParams, err.Error())
	default:
		return NewErrorResponse(reqID, CodeServerError, err.Error())
	}
}

func taskStatusTerminal(status TaskStatus) bool {
	switch status {
	case TaskStatusCompleted, TaskStatusFailed, TaskStatusCanceled:
		return true
	default:
		return false
	}
}

func taskResultWithRelatedMetadata(raw json.RawMessage, taskID string) (json.RawMessage, error) {
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("task result is not a JSON object: %w", err)
	}

	meta := map[string]any{}
	if rawMeta, hasMeta := result["_meta"]; hasMeta {
		existing, ok := rawMeta.(map[string]any)
		if ok && existing != nil {
			meta = existing
		}
	}
	meta[relatedTaskMetadataKey] = RelatedTaskMetadata{TaskID: taskID}
	result["_meta"] = meta

	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}
