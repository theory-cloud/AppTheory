package mcp

import (
	"context"
	"errors"
	"sync"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

// Session holds per-session state for an MCP connection.
type Session struct {
	ID        string            `json:"id"`
	CreatedAt time.Time         `json:"createdAt"`
	ExpiresAt time.Time         `json:"expiresAt"`
	Data      map[string]string `json:"data,omitempty"`
}

// SessionStore is the interface for session persistence backends.
type SessionStore interface {
	Get(ctx context.Context, id string) (*Session, error)
	Put(ctx context.Context, session *Session) error
	Delete(ctx context.Context, id string) error
}

// ErrSessionNotFound is returned when a session ID does not exist in the store.
var ErrSessionNotFound = errors.New("session not found")

// MemorySessionStore is an in-memory SessionStore for testing and local development.
type MemorySessionStore struct {
	mu    sync.RWMutex
	store map[string]*Session
	clock apptheory.Clock
}

// MemorySessionStoreOption configures a MemorySessionStore.
type MemorySessionStoreOption func(*MemorySessionStore)

// WithClock sets the clock used for TTL expiration checks.
func WithClock(c apptheory.Clock) MemorySessionStoreOption {
	return func(m *MemorySessionStore) {
		m.clock = c
	}
}

// NewMemorySessionStore creates an in-memory session store.
func NewMemorySessionStore(opts ...MemorySessionStoreOption) *MemorySessionStore {
	m := &MemorySessionStore{
		store: make(map[string]*Session),
		clock: apptheory.RealClock{},
	}
	for _, opt := range opts {
		opt(m)
	}
	return m
}

// Get retrieves a session by ID. It returns ErrSessionNotFound if the session
// does not exist or has expired.
func (m *MemorySessionStore) Get(_ context.Context, id string) (*Session, error) {
	m.mu.RLock()
	sess, ok := m.store[id]
	m.mu.RUnlock()

	if !ok {
		return nil, ErrSessionNotFound
	}

	// Check TTL expiration.
	if !sess.ExpiresAt.IsZero() && m.clock.Now().After(sess.ExpiresAt) {
		// Lazily remove expired session.
		m.mu.Lock()
		delete(m.store, id)
		m.mu.Unlock()
		return nil, ErrSessionNotFound
	}

	// Return a copy to prevent mutation of internal state.
	out := *sess
	if sess.Data != nil {
		out.Data = make(map[string]string, len(sess.Data))
		for k, v := range sess.Data {
			out.Data[k] = v
		}
	}
	return &out, nil
}

// Put stores a session. It overwrites any existing session with the same ID.
func (m *MemorySessionStore) Put(_ context.Context, session *Session) error {
	if session == nil {
		return errors.New("nil session")
	}

	// Store a copy to prevent external mutation.
	stored := *session
	if session.Data != nil {
		stored.Data = make(map[string]string, len(session.Data))
		for k, v := range session.Data {
			stored.Data[k] = v
		}
	}

	m.mu.Lock()
	m.store[stored.ID] = &stored
	m.mu.Unlock()
	return nil
}

// Delete removes a session by ID. It is a no-op if the session does not exist.
func (m *MemorySessionStore) Delete(_ context.Context, id string) error {
	m.mu.Lock()
	delete(m.store, id)
	m.mu.Unlock()
	return nil
}
