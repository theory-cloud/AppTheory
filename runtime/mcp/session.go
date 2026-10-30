package mcp

import (
	"context"
	"errors"
	"sync"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
)

// Session holds per-session state for an MCP connection.
type Session struct {
	ID        string            `json:"id"`
	CreatedAt time.Time         `json:"createdAt"`
	ExpiresAt time.Time         `json:"expiresAt"`
	Principal string            `json:"principal,omitempty"`
	Data      map[string]string `json:"data,omitempty"`
}

func sessionExpiredAt(now time.Time, sess *Session) bool {
	if sess == nil || sess.ExpiresAt.IsZero() {
		return false
	}
	return !sess.ExpiresAt.After(now)
}

// SessionStore is the interface for session persistence backends.
type SessionStore interface {
	Get(ctx context.Context, id string) (*Session, error)
	Put(ctx context.Context, session *Session) error
	Delete(ctx context.Context, id string) error
}

// SessionExpirySweeper is the built-in-only optional capability used by the
// server to learn which expired session IDs an atomic Put removed, so the
// associated stream, task, replay, and cancellation state can be cleaned up.
// Custom external stores keep the base SessionStore SPI.
type SessionExpirySweeper interface {
	PutAndCollectExpired(ctx context.Context, session *Session) ([]string, error)
}

// ErrSessionNotFound is returned when a session ID does not exist in the store.
var ErrSessionNotFound = errors.New("session not found")

// ErrSessionExpired is returned by a built-in store when an incoming session
// record is already expired. Expired state is never revived.
var ErrSessionExpired = errors.New("session expired")

// ErrSessionCapacityExceeded is the fixed-capacity refusal of the built-in
// in-memory session store. Its message is the public JSON-RPC error message, so
// every runtime maps it identically.
var ErrSessionCapacityExceeded = errors.New("Session capacity exceeded")

const defaultMemorySessionStoreCapacity = 1000

// MemorySessionStore is an in-memory SessionStore for testing and local development.
//
// A store instance keeps at most 1000 live sessions. Every Put first removes
// expired sessions, then refuses a new live session when the store is at
// capacity; no live session is ever evicted to admit another. The bound is a
// fixed framework constant. WithSessionCapacityLimit exists only so tests can
// select a small bound; production wiring never sets it.
type MemorySessionStore struct {
	mu          sync.RWMutex
	store       map[string]*Session
	clock       apptheory.Clock
	maxSessions int
}

// MemorySessionStoreOption configures a MemorySessionStore.
type MemorySessionStoreOption func(*MemorySessionStore)

// WithClock sets the clock used for TTL expiration checks.
func WithClock(c apptheory.Clock) MemorySessionStoreOption {
	return func(m *MemorySessionStore) {
		m.clock = c
	}
}

// WithSessionCapacityLimit selects a different live-session bound. It is a
// test-only seam: production servers never call it, and the fixed framework
// default remains 1000.
func WithSessionCapacityLimit(limit int) MemorySessionStoreOption {
	return func(m *MemorySessionStore) {
		if limit > 0 {
			m.maxSessions = limit
		}
	}
}

// NewMemorySessionStore creates an in-memory session store.
func NewMemorySessionStore(opts ...MemorySessionStoreOption) *MemorySessionStore {
	m := &MemorySessionStore{
		store:       make(map[string]*Session),
		clock:       apptheory.RealClock{},
		maxSessions: defaultMemorySessionStoreCapacity,
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
	if sessionExpiredAt(m.clock.Now(), sess) {
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

// Put stores a session. It sweeps expired sessions first, refuses an expired
// incoming record, allows a live same-ID overwrite without consuming new
// capacity, and refuses a new live session at capacity without evicting any
// live session.
func (m *MemorySessionStore) Put(ctx context.Context, session *Session) error {
	_, err := m.PutAndCollectExpired(ctx, session)
	return err
}

// PutAndCollectExpired performs the atomic sweep/count/insert and returns the
// expired session IDs it removed so the server can clean their associated
// stream, task, replay, and cancellation state.
func (m *MemorySessionStore) PutAndCollectExpired(_ context.Context, session *Session) ([]string, error) {
	if session == nil {
		return nil, errors.New("nil session")
	}
	stored := cloneSession(session)
	if stored.ID == "" {
		return nil, errors.New("missing session id")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	now := m.clock.Now()
	if sessionExpiredAt(now, &stored) {
		return nil, ErrSessionExpired
	}

	var expiredIDs []string
	for id, existing := range m.store {
		if sessionExpiredAt(now, existing) {
			delete(m.store, id)
			expiredIDs = append(expiredIDs, id)
		}
	}

	if _, liveSameID := m.store[stored.ID]; !liveSameID && len(m.store) >= m.maxSessions {
		return nil, ErrSessionCapacityExceeded
	}

	m.store[stored.ID] = &stored
	return expiredIDs, nil
}

func cloneSession(session *Session) Session {
	stored := *session
	if session.Data != nil {
		stored.Data = make(map[string]string, len(session.Data))
		for k, v := range session.Data {
			stored.Data[k] = v
		}
	}
	return stored
}

// Seed stores a session exactly as supplied, without the Put admission checks.
// It exists only for deterministic fixtures that must model state retained by
// an earlier process (for example, an already-expired session). Production
// callers must use Put.
func (m *MemorySessionStore) Seed(session *Session) {
	if m == nil || session == nil || session.ID == "" {
		return
	}
	stored := cloneSession(session)
	m.mu.Lock()
	m.store[stored.ID] = &stored
	m.mu.Unlock()
}

// Delete removes a session by ID. It is a no-op if the session does not exist.
func (m *MemorySessionStore) Delete(_ context.Context, id string) error {
	m.mu.Lock()
	delete(m.store, id)
	m.mu.Unlock()
	return nil
}
