package mcp

import (
	"context"
	"os"
	"time"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
)

// sessionRecord is the DynamoDB representation of an MCP session.
type sessionRecord struct {
	SessionID string            `theorydb:"pk" json:"sessionId"`
	CreatedAt time.Time         `json:"createdAt"`
	ExpiresAt int64             `theorydb:"ttl" json:"expiresAt"`
	Data      map[string]string `json:"data,omitempty"`
}

func (sessionRecord) TableName() string {
	if name := os.Getenv("MCP_SESSION_TABLE"); name != "" {
		return name
	}
	return "mcp-sessions"
}

// DynamoSessionStore implements SessionStore using DynamoDB via TableTheory.
type DynamoSessionStore struct {
	db tablecore.DB
}

var _ SessionStore = (*DynamoSessionStore)(nil)

// NewDynamoSessionStore creates a DynamoDB-backed session store.
func NewDynamoSessionStore(db tablecore.DB) SessionStore {
	return &DynamoSessionStore{db: db}
}

// Get retrieves a session by ID. Returns ErrSessionNotFound if the session does not exist.
func (d *DynamoSessionStore) Get(ctx context.Context, id string) (*Session, error) {
	var record sessionRecord
	err := d.db.Model(&sessionRecord{}).
		WithContext(ctx).
		Where("SessionID", "=", id).
		First(&record)
	if err != nil {
		if tableerrors.IsNotFound(err) {
			return nil, ErrSessionNotFound
		}
		return nil, err
	}

	return recordToSession(&record), nil
}

// Put stores a session. Overwrites any existing session with the same ID.
func (d *DynamoSessionStore) Put(ctx context.Context, session *Session) error {
	if session == nil {
		return ErrSessionNotFound
	}

	record := sessionToRecord(session)
	return d.db.Model(record).WithContext(ctx).Create()
}

// Delete removes a session by ID.
func (d *DynamoSessionStore) Delete(ctx context.Context, id string) error {
	return d.db.Model(&sessionRecord{}).
		WithContext(ctx).
		Where("SessionID", "=", id).
		Delete()
}

func sessionToRecord(s *Session) *sessionRecord {
	return &sessionRecord{
		SessionID: s.ID,
		CreatedAt: s.CreatedAt,
		ExpiresAt: s.ExpiresAt.Unix(),
		Data:      s.Data,
	}
}

func recordToSession(r *sessionRecord) *Session {
	return &Session{
		ID:        r.SessionID,
		CreatedAt: r.CreatedAt,
		ExpiresAt: time.Unix(r.ExpiresAt, 0).UTC(),
		Data:      r.Data,
	}
}
