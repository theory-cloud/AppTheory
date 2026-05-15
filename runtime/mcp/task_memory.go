package mcp

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MemoryTaskStore is an in-memory TaskStore for testing and local development.
type MemoryTaskStore struct {
	mu       sync.RWMutex
	sessions map[string]map[string]*TaskRecord
}

var _ TaskStore = (*MemoryTaskStore)(nil)

// NewMemoryTaskStore creates an empty in-memory task store.
func NewMemoryTaskStore() *MemoryTaskStore {
	return &MemoryTaskStore{sessions: map[string]map[string]*TaskRecord{}}
}

func (m *MemoryTaskStore) Create(_ context.Context, task TaskRecord) (*TaskRecord, error) {
	task.SessionID = strings.TrimSpace(task.SessionID)
	task.Task.TaskID = strings.TrimSpace(task.Task.TaskID)
	if task.SessionID == "" {
		return nil, errors.New("missing session id")
	}
	if task.Task.TaskID == "" {
		return nil, errors.New("missing task id")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	sess := m.sessions[task.SessionID]
	if sess == nil {
		sess = map[string]*TaskRecord{}
		m.sessions[task.SessionID] = sess
	}
	if _, exists := sess[task.Task.TaskID]; exists {
		return nil, errors.New("task already exists")
	}
	stored := cloneTaskRecord(&task)
	sess[stored.Task.TaskID] = stored
	return cloneTaskRecord(stored), nil
}

func (m *MemoryTaskStore) Get(_ context.Context, lookup TaskLookup) (*TaskRecord, error) {
	lookup.SessionID = strings.TrimSpace(lookup.SessionID)
	lookup.TaskID = strings.TrimSpace(lookup.TaskID)
	if lookup.SessionID == "" || lookup.TaskID == "" {
		return nil, ErrTaskNotFound
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	record := m.recordLocked(lookup)
	if record == nil {
		return nil, ErrTaskNotFound
	}
	return cloneTaskRecord(record), nil
}

func (m *MemoryTaskStore) Update(_ context.Context, task TaskRecord) (*TaskRecord, error) {
	task.SessionID = strings.TrimSpace(task.SessionID)
	task.Task.TaskID = strings.TrimSpace(task.Task.TaskID)
	if task.SessionID == "" || task.Task.TaskID == "" {
		return nil, ErrTaskNotFound
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	record := m.recordLocked(TaskLookup{SessionID: task.SessionID, TaskID: task.Task.TaskID})
	if record == nil {
		return nil, ErrTaskNotFound
	}
	if taskStatusTerminal(record.Task.Status) {
		return nil, ErrTaskTerminal
	}
	stored := cloneTaskRecord(&task)
	m.sessions[task.SessionID][task.Task.TaskID] = stored
	return cloneTaskRecord(stored), nil
}

func (m *MemoryTaskStore) List(_ context.Context, req TaskListRequest) (*TaskListResult, error) {
	req.SessionID = strings.TrimSpace(req.SessionID)
	if req.SessionID == "" {
		return &TaskListResult{Tasks: []Task{}}, nil
	}
	limit := req.Limit
	if limit <= 0 {
		limit = defaultTaskListLimit
	}
	if limit > maxTaskListLimit {
		limit = maxTaskListLimit
	}
	start := 0
	if cursor := strings.TrimSpace(req.Cursor); cursor != "" {
		idx, err := strconv.Atoi(cursor)
		if err != nil || idx < 0 {
			return nil, errTaskInvalidCursor
		}
		start = idx
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	sess := m.sessions[req.SessionID]
	if sess == nil {
		return &TaskListResult{Tasks: []Task{}}, nil
	}
	records := make([]*TaskRecord, 0, len(sess))
	for _, record := range sess {
		records = append(records, record)
	}
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].Task.CreatedAt.Equal(records[j].Task.CreatedAt) {
			return records[i].Task.TaskID < records[j].Task.TaskID
		}
		return records[i].Task.CreatedAt.Before(records[j].Task.CreatedAt)
	})
	if start >= len(records) {
		return &TaskListResult{Tasks: []Task{}}, nil
	}
	end := start + limit
	if end > len(records) {
		end = len(records)
	}
	tasks := make([]Task, 0, end-start)
	for _, record := range records[start:end] {
		tasks = append(tasks, record.Task)
	}
	result := &TaskListResult{Tasks: tasks}
	if end < len(records) {
		result.NextCursor = strconv.Itoa(end)
	}
	return result, nil
}

func (m *MemoryTaskStore) Cancel(_ context.Context, lookup TaskLookup) (*TaskRecord, error) {
	lookup.SessionID = strings.TrimSpace(lookup.SessionID)
	lookup.TaskID = strings.TrimSpace(lookup.TaskID)
	if lookup.SessionID == "" || lookup.TaskID == "" {
		return nil, ErrTaskNotFound
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	record := m.recordLocked(lookup)
	if record == nil {
		return nil, ErrTaskNotFound
	}
	if taskStatusTerminal(record.Task.Status) {
		return nil, ErrTaskTerminal
	}
	record.Task.Status = TaskStatusCanceled
	record.Task.StatusMessage = taskCanceledMessage
	record.Task.LastUpdatedAt = time.Now().UTC()
	record.Error = &RPCError{Code: CodeServerError, Message: taskCanceledMessage}
	return cloneTaskRecord(record), nil
}

func (m *MemoryTaskStore) DeleteSession(_ context.Context, sessionID string) error {
	m.mu.Lock()
	delete(m.sessions, strings.TrimSpace(sessionID))
	m.mu.Unlock()
	return nil
}

func (m *MemoryTaskStore) recordLocked(lookup TaskLookup) *TaskRecord {
	sess := m.sessions[lookup.SessionID]
	if sess == nil {
		return nil
	}
	return sess[lookup.TaskID]
}

func cloneTaskRecord(in *TaskRecord) *TaskRecord {
	if in == nil {
		return nil
	}
	out := *in
	if in.Task.TTL != nil {
		v := *in.Task.TTL
		out.Task.TTL = &v
	}
	if in.Task.PollInterval != nil {
		v := *in.Task.PollInterval
		out.Task.PollInterval = &v
	}
	out.Result = append(out.Result[:0:0], in.Result...)
	if in.Error != nil {
		errCopy := *in.Error
		out.Error = &errCopy
	}
	return &out
}
