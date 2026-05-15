package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
)

const (
	defaultDynamoTaskTableName = "mcp-tasks"
	envTaskTableName           = "MCP_TASK_TABLE"
)

type dynamoTaskRecord struct {
	SessionID          string          `theorydb:"pk,attr:sessionId" json:"sessionId"`
	TaskID             string          `theorydb:"sk,attr:taskId" json:"taskId"`
	Method             string          `theorydb:"attr:method" json:"method"`
	ToolName           string          `theorydb:"attr:toolName,omitempty" json:"toolName,omitempty"`
	Status             TaskStatus      `theorydb:"attr:status" json:"status"`
	StatusMessage      string          `theorydb:"attr:statusMessage,omitempty" json:"statusMessage,omitempty"`
	CreatedAt          time.Time       `theorydb:"attr:createdAt" json:"createdAt"`
	LastUpdatedAt      time.Time       `theorydb:"attr:lastUpdatedAt" json:"lastUpdatedAt"`
	ExpiresAt          int64           `theorydb:"ttl,attr:expiresAt" json:"expiresAt"`
	TTLMillis          int64           `theorydb:"attr:ttl,omitempty" json:"ttl,omitempty"`
	PollIntervalMillis int64           `theorydb:"attr:pollInterval,omitempty" json:"pollInterval,omitempty"`
	Result             json.RawMessage `theorydb:"attr:result,omitempty" json:"result,omitempty"`
	ErrorCode          int             `theorydb:"attr:errorCode,omitempty" json:"errorCode,omitempty"`
	ErrorMessage       string          `theorydb:"attr:errorMessage,omitempty" json:"errorMessage,omitempty"`
	ErrorData          json.RawMessage `theorydb:"attr:errorData,omitempty" json:"errorData,omitempty"`
}

func (dynamoTaskRecord) TableName() string {
	if name := strings.TrimSpace(os.Getenv(envTaskTableName)); name != "" {
		return name
	}
	return defaultDynamoTaskTableName
}

// DynamoTaskStore implements TaskStore using DynamoDB via TableTheory.
type DynamoTaskStore struct {
	db  tablecore.DB
	now func() time.Time
}

var _ TaskStore = (*DynamoTaskStore)(nil)

var errDynamoTaskStoreNotConfigured = errors.New("task store db not configured")

// NewDynamoTaskStore creates a DynamoDB-backed task store.
func NewDynamoTaskStore(db tablecore.DB) TaskStore {
	return &DynamoTaskStore{
		db:  db,
		now: func() time.Time { return time.Now().UTC() },
	}
}

func (d *DynamoTaskStore) Create(ctx context.Context, task TaskRecord) (*TaskRecord, error) {
	if err := d.configured(); err != nil {
		return nil, err
	}
	record, err := d.taskRecordToDynamo(task)
	if err != nil {
		return nil, err
	}
	if err := d.db.Model(record).WithContext(ctx).Create(); err != nil {
		return nil, err
	}
	return d.dynamoToTaskRecord(record)
}

func (d *DynamoTaskStore) Get(ctx context.Context, lookup TaskLookup) (*TaskRecord, error) {
	record, err := d.getDynamoRecord(ctx, lookup)
	if err != nil {
		return nil, err
	}
	return d.dynamoToTaskRecord(record)
}

func (d *DynamoTaskStore) Update(ctx context.Context, task TaskRecord) (*TaskRecord, error) {
	if err := d.configured(); err != nil {
		return nil, err
	}
	existing, err := d.getDynamoRecord(ctx, TaskLookup{SessionID: task.SessionID, TaskID: task.Task.TaskID})
	if err != nil {
		return nil, err
	}
	if taskStatusTerminal(existing.Status) {
		return nil, ErrTaskTerminal
	}

	record, err := d.taskRecordToDynamo(task)
	if err != nil {
		return nil, err
	}
	if err := d.db.Model(record).WithContext(ctx).CreateOrUpdate(); err != nil {
		return nil, err
	}
	return d.dynamoToTaskRecord(record)
}

func (d *DynamoTaskStore) List(ctx context.Context, req TaskListRequest) (*TaskListResult, error) {
	if err := d.configured(); err != nil {
		return nil, err
	}
	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		return &TaskListResult{Tasks: []Task{}}, nil
	}

	var records []dynamoTaskRecord
	err := d.db.Model(&dynamoTaskRecord{}).
		WithContext(ctx).
		Where("SessionID", "=", sessionID).
		All(&records)
	if err != nil {
		if tableerrors.IsNotFound(err) {
			return &TaskListResult{Tasks: []Task{}}, nil
		}
		return nil, err
	}

	return d.listResult(req, records)
}

func (d *DynamoTaskStore) Cancel(ctx context.Context, lookup TaskLookup) (*TaskRecord, error) {
	if err := d.configured(); err != nil {
		return nil, err
	}
	record, err := d.getDynamoRecord(ctx, lookup)
	if err != nil {
		return nil, err
	}
	if taskStatusTerminal(record.Status) {
		return nil, ErrTaskTerminal
	}

	record.Status = TaskStatusCanceled
	record.LastUpdatedAt = d.nowUTC()
	if err := d.db.Model(record).WithContext(ctx).CreateOrUpdate(); err != nil {
		return nil, err
	}
	return d.dynamoToTaskRecord(record)
}

func (d *DynamoTaskStore) DeleteSession(ctx context.Context, sessionID string) error {
	if err := d.configured(); err != nil {
		return err
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil
	}
	return d.db.Model(&dynamoTaskRecord{}).
		WithContext(ctx).
		Where("SessionID", "=", sessionID).
		Delete()
}

func (d *DynamoTaskStore) configured() error {
	if d == nil || d.db == nil {
		return errDynamoTaskStoreNotConfigured
	}
	return nil
}

func (d *DynamoTaskStore) getDynamoRecord(ctx context.Context, lookup TaskLookup) (*dynamoTaskRecord, error) {
	if err := d.configured(); err != nil {
		return nil, err
	}
	lookup.SessionID = strings.TrimSpace(lookup.SessionID)
	lookup.TaskID = strings.TrimSpace(lookup.TaskID)
	if lookup.SessionID == "" || lookup.TaskID == "" {
		return nil, ErrTaskNotFound
	}

	var record dynamoTaskRecord
	err := d.db.Model(&dynamoTaskRecord{}).
		WithContext(ctx).
		Where("SessionID", "=", lookup.SessionID).
		Where("TaskID", "=", lookup.TaskID).
		First(&record)
	if err != nil {
		if tableerrors.IsNotFound(err) {
			return nil, ErrTaskNotFound
		}
		return nil, err
	}
	if d.expired(record) {
		return nil, ErrTaskNotFound
	}
	return &record, nil
}

func (d *DynamoTaskStore) listResult(req TaskListRequest, records []dynamoTaskRecord) (*TaskListResult, error) {
	limit := taskListLimit(req.Limit)
	start, err := taskListCursor(req.Cursor)
	if err != nil {
		return nil, err
	}

	active := records[:0]
	for _, record := range records {
		if !d.expired(record) {
			active = append(active, record)
		}
	}
	sort.SliceStable(active, func(i, j int) bool {
		if active[i].CreatedAt.Equal(active[j].CreatedAt) {
			return active[i].TaskID < active[j].TaskID
		}
		return active[i].CreatedAt.Before(active[j].CreatedAt)
	})

	if start >= len(active) {
		return &TaskListResult{Tasks: []Task{}}, nil
	}
	end := start + limit
	if end > len(active) {
		end = len(active)
	}

	tasks := make([]Task, 0, end-start)
	for i := start; i < end; i++ {
		tasks = append(tasks, dynamoTaskToTask(active[i]))
	}
	result := &TaskListResult{Tasks: tasks}
	if end < len(active) {
		result.NextCursor = strconv.Itoa(end)
	}
	return result, nil
}

func taskListLimit(limit int) int {
	if limit <= 0 {
		return defaultTaskListLimit
	}
	if limit > maxTaskListLimit {
		return maxTaskListLimit
	}
	return limit
}

func taskListCursor(cursor string) (int, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return 0, nil
	}
	start, err := strconv.Atoi(cursor)
	if err != nil || start < 0 {
		return 0, errors.New("invalid task list cursor")
	}
	return start, nil
}

func (d *DynamoTaskStore) taskRecordToDynamo(task TaskRecord) (*dynamoTaskRecord, error) {
	task.SessionID = strings.TrimSpace(task.SessionID)
	task.Task.TaskID = strings.TrimSpace(task.Task.TaskID)
	task.Method = strings.TrimSpace(task.Method)
	task.ToolName = strings.TrimSpace(task.ToolName)
	if task.SessionID == "" {
		return nil, errors.New("missing session id")
	}
	if task.Task.TaskID == "" {
		return nil, errors.New("missing task id")
	}
	if task.Method == "" {
		return nil, errors.New("missing task method")
	}
	if !validTaskStatus(task.Task.Status) {
		return nil, errors.New("invalid task status")
	}

	createdAt := task.Task.CreatedAt.UTC()
	if createdAt.IsZero() {
		createdAt = d.nowUTC()
	}
	lastUpdatedAt := task.Task.LastUpdatedAt.UTC()
	if lastUpdatedAt.IsZero() {
		lastUpdatedAt = createdAt
	}

	ttl := int64(0)
	if task.Task.TTL != nil {
		ttl = *task.Task.TTL
	}
	pollInterval := int64(0)
	if task.Task.PollInterval != nil {
		pollInterval = *task.Task.PollInterval
	}

	record := &dynamoTaskRecord{
		SessionID:          task.SessionID,
		TaskID:             task.Task.TaskID,
		Method:             task.Method,
		ToolName:           task.ToolName,
		Status:             task.Task.Status,
		StatusMessage:      task.Task.StatusMessage,
		CreatedAt:          createdAt,
		LastUpdatedAt:      lastUpdatedAt,
		ExpiresAt:          taskExpiresAt(createdAt, ttl),
		TTLMillis:          ttl,
		PollIntervalMillis: pollInterval,
		Result:             append(json.RawMessage(nil), task.Result...),
	}
	if task.Error != nil {
		record.ErrorCode = task.Error.Code
		record.ErrorMessage = task.Error.Message
		if task.Error.Data != nil {
			data, err := json.Marshal(task.Error.Data)
			if err != nil {
				return nil, err
			}
			record.ErrorData = data
		}
	}
	return record, nil
}

func (d *DynamoTaskStore) dynamoToTaskRecord(record *dynamoTaskRecord) (*TaskRecord, error) {
	if record == nil || strings.TrimSpace(record.SessionID) == "" || strings.TrimSpace(record.TaskID) == "" {
		return nil, ErrTaskNotFound
	}
	if d.expired(*record) {
		return nil, ErrTaskNotFound
	}

	out := &TaskRecord{
		SessionID: record.SessionID,
		Method:    record.Method,
		ToolName:  record.ToolName,
		Task:      dynamoTaskToTask(*record),
		Result:    append(json.RawMessage(nil), record.Result...),
	}
	if record.ErrorCode != 0 || record.ErrorMessage != "" || len(record.ErrorData) > 0 {
		out.Error = &RPCError{
			Code:    record.ErrorCode,
			Message: record.ErrorMessage,
		}
		if len(record.ErrorData) > 0 {
			out.Error.Data = append(json.RawMessage(nil), record.ErrorData...)
		}
	}
	return out, nil
}

func dynamoTaskToTask(record dynamoTaskRecord) Task {
	task := Task{
		TaskID:        record.TaskID,
		Status:        record.Status,
		StatusMessage: record.StatusMessage,
		CreatedAt:     record.CreatedAt.UTC(),
		LastUpdatedAt: record.LastUpdatedAt.UTC(),
	}
	if record.TTLMillis > 0 {
		ttl := record.TTLMillis
		task.TTL = &ttl
	}
	if record.PollIntervalMillis > 0 {
		pollInterval := record.PollIntervalMillis
		task.PollInterval = &pollInterval
	}
	return task
}

func taskExpiresAt(createdAt time.Time, ttlMillis int64) int64 {
	if ttlMillis <= 0 {
		return createdAt.Add(defaultTaskMaxTTL).Unix()
	}
	return createdAt.Add(time.Duration(ttlMillis) * time.Millisecond).Unix()
}

func validTaskStatus(status TaskStatus) bool {
	switch status {
	case TaskStatusWorking, TaskStatusInputRequired, TaskStatusCompleted, TaskStatusFailed, TaskStatusCanceled:
		return true
	default:
		return false
	}
}

func (d *DynamoTaskStore) expired(record dynamoTaskRecord) bool {
	return record.ExpiresAt > 0 && !d.nowUTC().Before(time.Unix(record.ExpiresAt, 0).UTC())
}

func (d *DynamoTaskStore) nowUTC() time.Time {
	if d != nil && d.now != nil {
		return d.now().UTC()
	}
	return time.Now().UTC()
}
