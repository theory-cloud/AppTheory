package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
	tablemocks "github.com/theory-cloud/tabletheory/pkg/mocks"
)

func TestDynamoSessionStore_Get_Success(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", "sess-123").Return(q)
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*sessionRecord)
		require.True(t, ok)
		out.SessionID = "sess-123"
		out.CreatedAt = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		out.ExpiresAt = time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC).Unix()
		out.Data = map[string]string{"key": "value"}
	}).Return(nil)

	store := NewDynamoSessionStore(db)
	sess, err := store.Get(context.Background(), "sess-123")
	require.NoError(t, err)
	require.Equal(t, "sess-123", sess.ID)
	require.Equal(t, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), sess.CreatedAt)
	require.Equal(t, "value", sess.Data["key"])
}

func TestDynamoSessionStore_Get_NotFound(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", "missing").Return(q)
	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound)

	store := NewDynamoSessionStore(db)
	_, err := store.Get(context.Background(), "missing")
	require.ErrorIs(t, err, ErrSessionNotFound)
}

func TestDynamoSessionStore_Put_Success(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Create").Return(nil)

	store := NewDynamoSessionStore(db)
	err := store.Put(context.Background(), &Session{
		ID:        "sess-456",
		CreatedAt: time.Now().UTC(),
		ExpiresAt: time.Now().Add(time.Hour).UTC(),
		Data:      map[string]string{"foo": "bar"},
	})
	require.NoError(t, err)
}

func TestDynamoSessionStore_Put_NilSession(t *testing.T) {
	db := new(tablemocks.MockDB)
	store := NewDynamoSessionStore(db)
	err := store.Put(context.Background(), nil)
	require.ErrorIs(t, err, ErrSessionNotFound)
}

func TestDynamoSessionStore_Delete_Success(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "SessionID", "=", "sess-789").Return(q)
	q.On("Delete").Return(nil)

	store := NewDynamoSessionStore(db)
	err := store.Delete(context.Background(), "sess-789")
	require.NoError(t, err)
}

func TestSessionRecord_TableName_Default(t *testing.T) {
	t.Setenv("MCP_SESSION_TABLE", "")
	require.Equal(t, "mcp-sessions", sessionRecord{}.TableName())
}

func TestSessionRecord_TableName_EnvOverride(t *testing.T) {
	t.Setenv("MCP_SESSION_TABLE", "custom-sessions")
	require.Equal(t, "custom-sessions", sessionRecord{}.TableName())
}
