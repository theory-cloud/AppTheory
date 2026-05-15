package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
