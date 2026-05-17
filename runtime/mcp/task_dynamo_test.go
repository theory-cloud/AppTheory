package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
	tablemocks "github.com/theory-cloud/tabletheory/pkg/mocks"
)

func TestDynamoTaskRecord_TableName(t *testing.T) {
	t.Setenv(envTaskTableName, "")
	require.Equal(t, defaultDynamoTaskTableName, dynamoTaskRecord{}.TableName())

	t.Setenv(envTaskTableName, "custom-tasks")
	require.Equal(t, "custom-tasks", dynamoTaskRecord{}.TableName())
}

func TestDynamoTaskRecord_TheoryDBTagsMatchCanonicalTaskTableSchema(t *testing.T) {
	tp := reflect.TypeOf(dynamoTaskRecord{})

	assertTheoryDBTag(t, tp, "SessionID", "pk,attr:sessionId")
	assertTheoryDBTag(t, tp, "TaskID", "sk,attr:taskId")
	assertTheoryDBTag(t, tp, "Method", "attr:method")
	assertTheoryDBTag(t, tp, "ToolName", "attr:toolName,omitempty")
	assertTheoryDBTag(t, tp, "Status", "attr:status")
	assertTheoryDBTag(t, tp, "StatusMessage", "attr:statusMessage,omitempty")
	assertTheoryDBTag(t, tp, "CreatedAt", "attr:createdAt")
	assertTheoryDBTag(t, tp, "LastUpdatedAt", "attr:lastUpdatedAt")
	assertTheoryDBTag(t, tp, "ExpiresAt", "ttl,attr:expiresAt")
	assertTheoryDBTag(t, tp, "TTLMillis", "attr:ttl,omitempty")
	assertTheoryDBTag(t, tp, "PollIntervalMillis", "attr:pollInterval,omitempty")
	assertTheoryDBTag(t, tp, "Result", "attr:result,omitempty")
	assertTheoryDBTag(t, tp, "ErrorCode", "attr:errorCode,omitempty")
	assertTheoryDBTag(t, tp, "ErrorMessage", "attr:errorMessage,omitempty")
	assertTheoryDBTag(t, tp, "ErrorData", "attr:errorData,omitempty")
}

func assertTheoryDBTag(t *testing.T, tp reflect.Type, fieldName, want string) {
	t.Helper()

	field, ok := tp.FieldByName(fieldName)
	require.True(t, ok, "missing field %s", fieldName)
	require.Equal(t, want, field.Tag.Get("theorydb"))
}

func expectTaskNonTerminalWriteGuard(q *tablemocks.MockQuery) {
	q.On("WithCondition", "Status", "<>", TaskStatusCompleted).Return(q).Once()
	q.On("WithCondition", "Status", "<>", TaskStatusFailed).Return(q).Once()
	q.On("WithCondition", "Status", "<>", TaskStatusCanceled).Return(q).Once()
}

func expectDynamoTaskListQuery(q *tablemocks.MockQuery, sessionID string, limit int, offset int) {
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", sessionID).Return(q)
	q.On("OrderBy", "CreatedAt", "ASC").Return(q)
	q.On("OrderBy", "TaskID", "ASC").Return(q)
	q.On("Limit", limit).Return(q)
	q.On("Offset", offset).Return(q)
	q.On("Select", dynamoTaskListProjection).Return(q)
}

func TestDynamoTaskStore_CreatePersistsTaskRecord(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	now := time.Date(2026, 5, 15, 1, 30, 0, 0, time.UTC)
	ttl := int64(5 * time.Minute / time.Millisecond)
	poll := int64(5 * time.Second / time.Millisecond)
	record := TaskRecord{
		SessionID: " sess-1 ",
		Method:    methodToolsCall,
		ToolName:  " slow ",
		Task: Task{
			TaskID:        " task-1 ",
			Status:        TaskStatusFailed,
			StatusMessage: "failed",
			CreatedAt:     now,
			LastUpdatedAt: now.Add(time.Second),
			TTL:           &ttl,
			PollInterval:  &poll,
		},
		Result: json.RawMessage(`{"content":[]}`),
		Error:  &RPCError{Code: CodeServerError, Message: "boom", Data: map[string]any{"reason": "test"}},
	}

	db.On("Model", mock.MatchedBy(func(in *dynamoTaskRecord) bool {
		return in.SessionID == "sess-1" &&
			in.TaskID == "task-1" &&
			in.Method == methodToolsCall &&
			in.ToolName == "slow" &&
			in.Status == TaskStatusFailed &&
			in.StatusMessage == "failed" &&
			in.TTLMillis == ttl &&
			in.PollIntervalMillis == poll &&
			in.ExpiresAt == now.Add(5*time.Minute).Unix() &&
			json.Valid(in.ErrorData)
	})).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Create").Return(nil)

	store, ok := NewDynamoTaskStore(db).(*DynamoTaskStore)
	require.True(t, ok)
	store.now = func() time.Time { return now }
	created, err := store.Create(context.Background(), record)
	require.NoError(t, err)
	require.Equal(t, "sess-1", created.SessionID)
	require.Equal(t, "task-1", created.Task.TaskID)
	require.Equal(t, "slow", created.ToolName)
	require.Equal(t, TaskStatusFailed, created.Task.Status)
	require.Equal(t, ttl, *created.Task.TTL)
	require.Equal(t, poll, *created.Task.PollInterval)
	require.Equal(t, CodeServerError, created.Error.Code)
	errData, ok := created.Error.Data.(json.RawMessage)
	require.True(t, ok)
	require.JSONEq(t, `{"reason":"test"}`, string(errData))
}

func TestDynamoTaskStore_CreateDefaultsAndPropagatesErrors(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	expected := errors.New("create failed")

	db.On("Model", mock.MatchedBy(func(in *dynamoTaskRecord) bool {
		return in.ExpiresAt > 0 && in.TTLMillis == 0 && in.CreatedAt.After(time.Time{})
	})).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Create").Return(expected)

	store := NewDynamoTaskStore(db)
	_, err := store.Create(context.Background(), TaskRecord{
		SessionID: "sess-1",
		Method:    methodToolsCall,
		Task:      Task{TaskID: "task-1", Status: TaskStatusWorking},
	})
	require.ErrorIs(t, err, expected)

	_, err = NewDynamoTaskStore(nil).Create(context.Background(), taskTestRecord("sess-1", "task-1", TaskStatusWorking))
	require.ErrorIs(t, err, errDynamoTaskStoreNotConfigured)
}

func TestDynamoTaskStore_GetMapsNotFoundAndExpired(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	now := time.Date(2026, 5, 15, 1, 31, 0, 0, time.UTC)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", "missing").Return(q)
	q.On("Where", "TaskID", "=", "task-1").Return(q)
	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound).Once()
	q.On("Where", "SessionID", "=", "expired").Return(q)
	q.On("Where", "TaskID", "=", "task-2").Return(q)
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*dynamoTaskRecord)
		require.True(t, ok)
		*out = dynamoTaskRecord{
			SessionID:     "expired",
			TaskID:        "task-2",
			Method:        methodToolsCall,
			Status:        TaskStatusWorking,
			CreatedAt:     now.Add(-time.Hour),
			LastUpdatedAt: now.Add(-time.Hour),
			ExpiresAt:     now.Add(-time.Minute).Unix(),
			TTLMillis:     int64(time.Minute / time.Millisecond),
		}
	}).Return(nil).Once()

	store, ok := NewDynamoTaskStore(db).(*DynamoTaskStore)
	require.True(t, ok)
	store.now = func() time.Time { return now }

	_, err := store.Get(context.Background(), TaskLookup{SessionID: "missing", TaskID: "task-1"})
	require.ErrorIs(t, err, ErrTaskNotFound)

	_, err = store.Get(context.Background(), TaskLookup{SessionID: "expired", TaskID: "task-2"})
	require.ErrorIs(t, err, ErrTaskNotFound)
}

func TestDynamoTaskStore_GetSuccess(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	now := time.Date(2026, 5, 15, 1, 31, 30, 0, time.UTC)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", "sess-1").Return(q)
	q.On("Where", "TaskID", "=", "task-1").Return(q)
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*dynamoTaskRecord)
		require.True(t, ok)
		*out = dynamoTaskRecord{
			SessionID:          "sess-1",
			TaskID:             "task-1",
			Method:             methodToolsCall,
			ToolName:           "slow",
			Status:             TaskStatusCompleted,
			CreatedAt:          now,
			LastUpdatedAt:      now.Add(time.Second),
			ExpiresAt:          now.Add(time.Hour).Unix(),
			TTLMillis:          int64(time.Hour / time.Millisecond),
			PollIntervalMillis: int64(time.Second / time.Millisecond),
			Result:             json.RawMessage(`{"content":[]}`),
		}
	}).Return(nil)

	store, ok := NewDynamoTaskStore(db).(*DynamoTaskStore)
	require.True(t, ok)
	store.now = func() time.Time { return now }

	got, err := store.Get(context.Background(), TaskLookup{SessionID: " sess-1 ", TaskID: " task-1 "})
	require.NoError(t, err)
	require.Equal(t, "sess-1", got.SessionID)
	require.Equal(t, "task-1", got.Task.TaskID)
	require.Equal(t, TaskStatusCompleted, got.Task.Status)
	require.Equal(t, int64(time.Second/time.Millisecond), *got.Task.PollInterval)
}

func TestDynamoTaskStore_UpdateRejectsTerminalTask(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	now := time.Now().UTC()

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", "sess-1").Return(q)
	q.On("Where", "TaskID", "=", "task-1").Return(q)
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*dynamoTaskRecord)
		require.True(t, ok)
		*out = dynamoTaskRecord{
			SessionID:     "sess-1",
			TaskID:        "task-1",
			Method:        methodToolsCall,
			Status:        TaskStatusCompleted,
			CreatedAt:     now,
			LastUpdatedAt: now,
			ExpiresAt:     now.Add(time.Hour).Unix(),
			TTLMillis:     int64(time.Hour / time.Millisecond),
		}
	}).Return(nil)

	store := NewDynamoTaskStore(db)
	_, err := store.Update(context.Background(), taskTestRecord("sess-1", "task-1", TaskStatusCompleted))
	require.ErrorIs(t, err, ErrTaskTerminal)
	q.AssertNotCalled(t, "CreateOrUpdate")
}

func TestDynamoTaskStore_UpdatePersistsNonTerminalTask(t *testing.T) {
	db := new(tablemocks.MockDB)
	getQ := new(tablemocks.MockQuery)
	updateQ := new(tablemocks.MockQuery)
	now := time.Now().UTC()

	db.On("Model", mock.AnythingOfType("*mcp.dynamoTaskRecord")).Return(getQ).Once()
	getQ.On("WithContext", mock.Anything).Return(getQ)
	getQ.On("Where", "SessionID", "=", "sess-1").Return(getQ)
	getQ.On("Where", "TaskID", "=", "task-1").Return(getQ)
	getQ.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*dynamoTaskRecord)
		require.True(t, ok)
		*out = dynamoTaskRecord{
			SessionID:     "sess-1",
			TaskID:        "task-1",
			Method:        methodToolsCall,
			Status:        TaskStatusWorking,
			CreatedAt:     now,
			LastUpdatedAt: now,
			ExpiresAt:     now.Add(time.Hour).Unix(),
			TTLMillis:     int64(time.Hour / time.Millisecond),
		}
	}).Return(nil)

	db.On("Model", mock.MatchedBy(func(in *dynamoTaskRecord) bool {
		return in.Status == TaskStatusCompleted && string(in.Result) == `{"content":[]}`
	})).Return(updateQ).Once()
	updateQ.On("WithContext", mock.Anything).Return(updateQ)
	expectTaskNonTerminalWriteGuard(updateQ)
	updateQ.On("Update", []string(nil)).Return(nil)

	task := taskTestRecord("sess-1", "task-1", TaskStatusCompleted)
	task.Result = json.RawMessage(`{"content":[]}`)

	store := NewDynamoTaskStore(db)
	updated, err := store.Update(context.Background(), task)
	require.NoError(t, err)
	require.Equal(t, TaskStatusCompleted, updated.Task.Status)
	require.JSONEq(t, `{"content":[]}`, string(updated.Result))
}

func TestDynamoTaskStore_UpdatePropagatesWriteAndValidationErrors(t *testing.T) {
	db := new(tablemocks.MockDB)
	getQ := new(tablemocks.MockQuery)
	updateQ := new(tablemocks.MockQuery)
	expected := errors.New("write failed")
	now := time.Now().UTC()

	db.On("Model", mock.AnythingOfType("*mcp.dynamoTaskRecord")).Return(getQ).Once()
	getQ.On("WithContext", mock.Anything).Return(getQ)
	getQ.On("Where", "SessionID", "=", "sess-1").Return(getQ)
	getQ.On("Where", "TaskID", "=", "task-1").Return(getQ)
	getQ.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*dynamoTaskRecord)
		require.True(t, ok)
		*out = dynamoTaskRecord{
			SessionID: "sess-1", TaskID: "task-1", Method: methodToolsCall,
			Status: TaskStatusWorking, CreatedAt: now, LastUpdatedAt: now,
			ExpiresAt: now.Add(time.Hour).Unix(), TTLMillis: int64(time.Hour / time.Millisecond),
		}
	}).Return(nil)
	db.On("Model", mock.MatchedBy(func(in *dynamoTaskRecord) bool {
		return in.TaskID == "task-1"
	})).Return(updateQ).Once()
	updateQ.On("WithContext", mock.Anything).Return(updateQ)
	expectTaskNonTerminalWriteGuard(updateQ)
	updateQ.On("Update", []string(nil)).Return(expected)

	store := NewDynamoTaskStore(db)
	_, err := store.Update(context.Background(), taskTestRecord("sess-1", "task-1", TaskStatusCompleted))
	require.ErrorIs(t, err, expected)

	db = new(tablemocks.MockDB)
	getQ = new(tablemocks.MockQuery)
	db.On("Model", mock.Anything).Return(getQ)
	getQ.On("WithContext", mock.Anything).Return(getQ)
	getQ.On("Where", "SessionID", "=", "sess-2").Return(getQ)
	getQ.On("Where", "TaskID", "=", "task-2").Return(getQ)
	getQ.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*dynamoTaskRecord)
		require.True(t, ok)
		*out = dynamoTaskRecord{
			SessionID: "sess-2", TaskID: "task-2", Method: methodToolsCall,
			Status: TaskStatusWorking, CreatedAt: now, LastUpdatedAt: now,
			ExpiresAt: now.Add(time.Hour).Unix(), TTLMillis: int64(time.Hour / time.Millisecond),
		}
	}).Return(nil)
	invalid := taskTestRecord("sess-2", "task-2", TaskStatus("bogus"))
	_, err = NewDynamoTaskStore(db).Update(context.Background(), invalid)
	require.Error(t, err)
}

func TestDynamoTaskStore_CancelMarksTaskTerminal(t *testing.T) {
	db := new(tablemocks.MockDB)
	getQ := new(tablemocks.MockQuery)
	updateQ := new(tablemocks.MockQuery)
	now := time.Date(2026, 5, 15, 1, 32, 0, 0, time.UTC)
	updated := now.Add(30 * time.Second)

	db.On("Model", mock.AnythingOfType("*mcp.dynamoTaskRecord")).Return(getQ).Once()
	getQ.On("WithContext", mock.Anything).Return(getQ)
	getQ.On("Where", "SessionID", "=", "sess-1").Return(getQ)
	getQ.On("Where", "TaskID", "=", "task-1").Return(getQ)
	getQ.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*dynamoTaskRecord)
		require.True(t, ok)
		*out = dynamoTaskRecord{
			SessionID:     "sess-1",
			TaskID:        "task-1",
			Method:        methodToolsCall,
			Status:        TaskStatusWorking,
			CreatedAt:     now,
			LastUpdatedAt: now,
			ExpiresAt:     now.Add(time.Hour).Unix(),
			TTLMillis:     int64(time.Hour / time.Millisecond),
		}
	}).Return(nil)

	db.On("Model", mock.MatchedBy(func(in *dynamoTaskRecord) bool {
		return in.Status == TaskStatusCanceled &&
			in.StatusMessage == taskCanceledMessage &&
			in.ErrorCode == CodeServerError &&
			in.ErrorMessage == taskCanceledMessage &&
			in.LastUpdatedAt.Equal(updated)
	})).Return(updateQ).Once()
	updateQ.On("WithContext", mock.Anything).Return(updateQ)
	expectTaskNonTerminalWriteGuard(updateQ)
	updateQ.On("Update", []string(nil)).Return(nil)

	store, ok := NewDynamoTaskStore(db).(*DynamoTaskStore)
	require.True(t, ok)
	store.now = func() time.Time { return updated }

	canceled, err := store.Cancel(context.Background(), TaskLookup{SessionID: "sess-1", TaskID: "task-1"})
	require.NoError(t, err)
	require.Equal(t, TaskStatusCanceled, canceled.Task.Status)
	require.True(t, canceled.Task.LastUpdatedAt.Equal(updated))
	require.Equal(t, CodeServerError, canceled.Error.Code)
}

func TestDynamoTaskStore_CancelRejectsTerminalAndPropagatesWriteError(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	now := time.Now().UTC()

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", "sess-1").Return(q)
	q.On("Where", "TaskID", "=", "task-1").Return(q)
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*dynamoTaskRecord)
		require.True(t, ok)
		*out = dynamoTaskRecord{
			SessionID: "sess-1", TaskID: "task-1", Method: methodToolsCall,
			Status: TaskStatusCompleted, CreatedAt: now, LastUpdatedAt: now,
			ExpiresAt: now.Add(time.Hour).Unix(), TTLMillis: int64(time.Hour / time.Millisecond),
		}
	}).Return(nil).Once()

	store := NewDynamoTaskStore(db)
	_, err := store.Cancel(context.Background(), TaskLookup{SessionID: "sess-1", TaskID: "task-1"})
	require.ErrorIs(t, err, ErrTaskTerminal)

	getQ := new(tablemocks.MockQuery)
	updateQ := new(tablemocks.MockQuery)
	expected := errors.New("cancel write failed")
	db = new(tablemocks.MockDB)
	db.On("Model", mock.AnythingOfType("*mcp.dynamoTaskRecord")).Return(getQ).Once()
	getQ.On("WithContext", mock.Anything).Return(getQ)
	getQ.On("Where", "SessionID", "=", "sess-2").Return(getQ)
	getQ.On("Where", "TaskID", "=", "task-2").Return(getQ)
	getQ.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*dynamoTaskRecord)
		require.True(t, ok)
		*out = dynamoTaskRecord{
			SessionID: "sess-2", TaskID: "task-2", Method: methodToolsCall,
			Status: TaskStatusWorking, CreatedAt: now, LastUpdatedAt: now,
			ExpiresAt: now.Add(time.Hour).Unix(), TTLMillis: int64(time.Hour / time.Millisecond),
		}
	}).Return(nil)
	db.On("Model", mock.MatchedBy(func(in *dynamoTaskRecord) bool {
		return in.Status == TaskStatusCanceled
	})).Return(updateQ).Once()
	updateQ.On("WithContext", mock.Anything).Return(updateQ)
	expectTaskNonTerminalWriteGuard(updateQ)
	updateQ.On("Update", []string(nil)).Return(expected)

	_, err = NewDynamoTaskStore(db).Cancel(context.Background(), TaskLookup{SessionID: "sess-2", TaskID: "task-2"})
	require.ErrorIs(t, err, expected)
}

func TestDynamoTaskStore_ListFiltersSortsAndPaginates(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	now := time.Date(2026, 5, 15, 1, 33, 0, 0, time.UTC)

	db.On("Model", mock.Anything).Return(q)
	expectDynamoTaskListQuery(q, "sess-1", 3, 0)
	q.On("All", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*[]dynamoTaskRecord)
		require.True(t, ok)
		*out = []dynamoTaskRecord{
			{
				SessionID:     "sess-1",
				TaskID:        "task-1",
				Method:        methodToolsCall,
				Status:        TaskStatusCompleted,
				CreatedAt:     now,
				LastUpdatedAt: now,
				ExpiresAt:     now.Add(time.Hour).Unix(),
				TTLMillis:     int64(time.Hour / time.Millisecond),
			},
			{
				SessionID:     "sess-1",
				TaskID:        "task-2",
				Method:        methodToolsCall,
				Status:        TaskStatusWorking,
				CreatedAt:     now.Add(2 * time.Second),
				LastUpdatedAt: now.Add(2 * time.Second),
				ExpiresAt:     now.Add(time.Hour).Unix(),
				TTLMillis:     int64(time.Hour / time.Millisecond),
			},
			{
				SessionID:     "sess-1",
				TaskID:        "task-3",
				Method:        methodToolsCall,
				Status:        TaskStatusWorking,
				CreatedAt:     now.Add(3 * time.Second),
				LastUpdatedAt: now.Add(3 * time.Second),
				ExpiresAt:     now.Add(time.Hour).Unix(),
				TTLMillis:     int64(time.Hour / time.Millisecond),
			},
		}
	}).Return(nil)

	store, ok := NewDynamoTaskStore(db).(*DynamoTaskStore)
	require.True(t, ok)
	store.now = func() time.Time { return now }

	page, err := store.List(context.Background(), TaskListRequest{SessionID: " sess-1 ", Limit: 2})
	require.NoError(t, err)
	require.Len(t, page.Tasks, 2)
	require.Equal(t, "task-1", page.Tasks[0].TaskID)
	require.Equal(t, "task-2", page.Tasks[1].TaskID)
	require.Equal(t, "2", page.NextCursor)

	next, err := store.listResult(TaskListRequest{Limit: 2, Cursor: page.NextCursor}, []dynamoTaskRecord{
		{TaskID: "task-1", Status: TaskStatusCompleted, CreatedAt: now, LastUpdatedAt: now, ExpiresAt: now.Add(time.Hour).Unix()},
		{TaskID: "task-2", Status: TaskStatusWorking, CreatedAt: now.Add(time.Second), LastUpdatedAt: now.Add(time.Second), ExpiresAt: now.Add(time.Hour).Unix()},
		{TaskID: "task-3", Status: TaskStatusWorking, CreatedAt: now.Add(2 * time.Second), LastUpdatedAt: now.Add(2 * time.Second), ExpiresAt: now.Add(time.Hour).Unix()},
	})
	require.NoError(t, err)
	require.Len(t, next.Tasks, 1)
	require.Equal(t, "task-3", next.Tasks[0].TaskID)

	paged := store.listQueryResult(2, 2, []dynamoTaskRecord{
		{TaskID: "task-3", Status: TaskStatusWorking, CreatedAt: now.Add(2 * time.Second), LastUpdatedAt: now.Add(2 * time.Second), ExpiresAt: now.Add(time.Hour).Unix()},
		{TaskID: "expired", Status: TaskStatusWorking, CreatedAt: now.Add(3 * time.Second), LastUpdatedAt: now.Add(3 * time.Second), ExpiresAt: now.Add(-time.Second).Unix()},
		{TaskID: "task-4", Status: TaskStatusWorking, CreatedAt: now.Add(4 * time.Second), LastUpdatedAt: now.Add(4 * time.Second), ExpiresAt: now.Add(time.Hour).Unix()},
	})
	require.Len(t, paged.Tasks, 1)
	require.Equal(t, "task-3", paged.Tasks[0].TaskID)
	require.Equal(t, "4", paged.NextCursor)
}

func TestDynamoTaskStore_DeleteSessionAndInvalidWrites(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", "sess-1").Return(q)
	q.On("Delete").Return(nil)
	q.On("All", mock.Anything).Return(nil)

	store := NewDynamoTaskStore(db)
	require.NoError(t, store.DeleteSession(context.Background(), " sess-1 "))
	require.NoError(t, store.DeleteSession(context.Background(), " "))

	_, err := store.Create(context.Background(), TaskRecord{})
	require.Error(t, err)

	badStatus := taskTestRecord("sess-1", "task-1", TaskStatus("bad"))
	_, err = store.Create(context.Background(), badStatus)
	require.Error(t, err)

	_, err = (*DynamoTaskStore)(nil).Get(context.Background(), TaskLookup{SessionID: "sess", TaskID: "task"})
	require.ErrorIs(t, err, errDynamoTaskStoreNotConfigured)

	_, err = store.List(context.Background(), TaskListRequest{SessionID: "sess-1", Cursor: "bad"})
	require.Error(t, err)
}

func TestDynamoTaskStore_ListAndDeleteErrorBranches(t *testing.T) {
	result, err := NewDynamoTaskStore(nil).List(context.Background(), TaskListRequest{SessionID: "sess-1"})
	require.Nil(t, result)
	require.ErrorIs(t, err, errDynamoTaskStoreNotConfigured)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	expected := errors.New("list failed")
	db.On("Model", mock.Anything).Return(q)
	expectDynamoTaskListQuery(q, "sess-1", defaultTaskListLimit+1, 0)
	q.On("All", mock.Anything).Return(expected)

	_, err = NewDynamoTaskStore(db).List(context.Background(), TaskListRequest{SessionID: "sess-1"})
	require.ErrorIs(t, err, expected)

	db = new(tablemocks.MockDB)
	q = new(tablemocks.MockQuery)
	expected = errors.New("delete failed")
	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", "sess-2").Return(q)
	q.On("Delete").Return(expected)

	err = NewDynamoTaskStore(db).DeleteSession(context.Background(), "sess-2")
	require.ErrorIs(t, err, expected)
}

func TestDynamoTaskStore_HelperBranches(t *testing.T) {
	store := &DynamoTaskStore{}
	require.False(t, store.nowUTC().IsZero())

	_, err := store.dynamoToTaskRecord(nil)
	require.ErrorIs(t, err, ErrTaskNotFound)

	now := time.Now().UTC()
	result, err := store.listResult(TaskListRequest{Cursor: "1", Limit: maxTaskListLimit + 1}, []dynamoTaskRecord{
		{
			SessionID:     "sess-1",
			TaskID:        "task-1",
			Method:        methodToolsCall,
			Status:        TaskStatusWorking,
			CreatedAt:     now,
			LastUpdatedAt: now,
			ExpiresAt:     now.Add(time.Hour).Unix(),
		},
	})
	require.NoError(t, err)
	require.Empty(t, result.Tasks)
}

func TestDynamoTaskStore_ListNotFoundReturnsEmpty(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	expectDynamoTaskListQuery(q, "sess-1", defaultTaskListLimit+1, 0)
	q.On("All", mock.Anything).Return(tableerrors.ErrItemNotFound)

	store := NewDynamoTaskStore(db)
	result, err := store.List(context.Background(), TaskListRequest{SessionID: "sess-1"})
	require.NoError(t, err)
	require.Empty(t, result.Tasks)
}

func TestDynamoTaskStore_PropagatesUnexpectedGetError(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	expected := errors.New("dynamo down")

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", "sess-1").Return(q)
	q.On("Where", "TaskID", "=", "task-1").Return(q)
	q.On("First", mock.Anything).Return(expected)

	store := NewDynamoTaskStore(db)
	_, err := store.Get(context.Background(), TaskLookup{SessionID: "sess-1", TaskID: "task-1"})
	require.ErrorIs(t, err, expected)
}
