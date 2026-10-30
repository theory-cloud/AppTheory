package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
)

type cancellationTracker struct {
	mu       sync.Mutex
	requests map[string]*cancellationEntry
}

type cancellationEntry struct {
	cancel context.CancelFunc
}

func newCancellationTracker() *cancellationTracker {
	return &cancellationTracker{
		requests: make(map[string]*cancellationEntry),
	}
}

func (t *cancellationTracker) track(ctx context.Context, sessionID string, requestID any) (context.Context, func()) {
	if t == nil {
		return ctx, func() {}
	}
	key, ok := cancellationKey(sessionID, requestID)
	if !ok {
		return ctx, func() {}
	}

	trackedCtx, cancel := context.WithCancel(ctx)
	entry := &cancellationEntry{cancel: cancel}
	t.mu.Lock()
	t.requests[key] = entry
	t.mu.Unlock()

	finish := func() {
		t.mu.Lock()
		if t.requests[key] == entry {
			delete(t.requests, key)
		}
		t.mu.Unlock()
		cancel()
	}
	return trackedCtx, finish
}

func (t *cancellationTracker) cancel(sessionID string, requestID any) bool {
	if t == nil {
		return false
	}
	key, ok := cancellationKey(sessionID, requestID)
	if !ok {
		return false
	}

	t.mu.Lock()
	entry := t.requests[key]
	t.mu.Unlock()
	if entry == nil || entry.cancel == nil {
		return false
	}
	entry.cancel()
	return true
}

func cancellationKey(sessionID string, requestID any) (string, bool) {
	if sessionID == "" {
		return "", false
	}
	idKey, ok := requestIDKey(requestID)
	if !ok {
		return "", false
	}
	return sessionID + "\x00" + idKey, true
}

// cancelSession cancels and forgets every in-flight request owned by sessionID.
// It is part of DeleteSession cleanup so a deleted or expired session cannot
// leave cancellation entries or live handler contexts behind.
func (t *cancellationTracker) cancelSession(sessionID string) int {
	if t == nil {
		return 0
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return 0
	}
	prefix := sessionID + "\x00"

	t.mu.Lock()
	entries := make([]*cancellationEntry, 0)
	for key, entry := range t.requests {
		if strings.HasPrefix(key, prefix) {
			entries = append(entries, entry)
			delete(t.requests, key)
		}
	}
	t.mu.Unlock()

	for _, entry := range entries {
		if entry != nil && entry.cancel != nil {
			entry.cancel()
		}
	}
	return len(entries)
}

func requestIDKey(requestID any) (string, bool) {
	switch id := requestID.(type) {
	case nil:
		return "", false
	case json.RawMessage:
		raw := bytes.TrimSpace(id)
		if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
			return "", false
		}
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return "", false
		}
		return requestIDKey(decoded)
	default:
		encoded, err := json.Marshal(id)
		if err != nil {
			return "", false
		}
		encoded = bytes.TrimSpace(encoded)
		if len(encoded) == 0 || bytes.Equal(encoded, []byte("null")) {
			return "", false
		}
		return string(encoded), true
	}
}

type cancelledNotificationParams struct {
	RequestID json.RawMessage `json:"requestId"`
	Reason    string          `json:"reason,omitempty"`
}

func (s *Server) trackRequest(ctx context.Context, sessionID string, requestID any) (context.Context, func()) {
	if s == nil || s.cancellations == nil {
		return ctx, func() {}
	}
	return s.cancellations.track(ctx, sessionID, requestID)
}

func (s *Server) handleCancellationNotification(ctx context.Context, sess *Session, req *Request) {
	if s == nil || sess == nil {
		return
	}
	var params cancelledNotificationParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		s.logCancellationDebug(ctx, "invalid cancellation params", "sessionId", sess.ID, "error", err)
		return
	}
	if len(bytes.TrimSpace(params.RequestID)) == 0 {
		s.logCancellationDebug(ctx, "missing cancellation request id", "sessionId", sess.ID)
		return
	}
	if !s.cancellations.cancel(sess.ID, params.RequestID) {
		s.logCancellationDebug(ctx, "cancellation target not active", "sessionId", sess.ID)
	}
}

func (s *Server) logCancellationDebug(ctx context.Context, msg string, args ...any) {
	if s == nil || s.logger == nil {
		return
	}
	s.logger.Log(ctx, slog.LevelDebug, msg, args...)
}
