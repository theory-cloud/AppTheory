package mcp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// createSession admits a new built-in session. The built-in store's sweeper is
// used when available so the associated state of expired sessions is cleaned
// before initialization returns.
func (s *Server) createSession(ctx context.Context, selectedPV string) (*Session, error) {
	now := time.Now().UTC()
	ttl := sessionTTL()

	newID := s.idGen.NewID()
	sess := &Session{
		ID:        newID,
		CreatedAt: now,
		ExpiresAt: now.Add(ttl),
		Principal: callerIdentityFromContext(ctx),
		Data: map[string]string{
			"protocolVersion": selectedPV,
		},
	}

	if sweeper, ok := s.sessionStore.(SessionExpirySweeper); ok {
		expiredIDs, err := sweeper.PutAndCollectExpired(ctx, sess)
		if err != nil {
			return nil, fmt.Errorf("failed to create session: %w", err)
		}
		for _, expiredID := range expiredIDs {
			if cleanupErr := s.cleanupSessionState(ctx, expiredID); cleanupErr != nil {
				if deleteErr := s.sessionStore.Delete(ctx, sess.ID); deleteErr != nil {
					cleanupErr = errors.Join(cleanupErr, deleteErr)
				}
				return nil, fmt.Errorf("failed to clean expired session state: %w", cleanupErr)
			}
		}
		return sess, nil
	}

	if err := s.sessionStore.Put(ctx, sess); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}
	return sess, nil
}

// cleanupSessionState removes every associated stream, task, replay, and
// cancellation record owned by sessionID. It is shared by explicit DELETE,
// Get-observed expiry, and the expired-first sweep performed by the built-in
// session store during initialization.
func (s *Server) cleanupSessionState(ctx context.Context, sessionID string) error {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil
	}

	var errs []error
	if s.streamStore != nil {
		if err := s.streamStore.DeleteSession(ctx, sessionID); err != nil {
			errs = append(errs, fmt.Errorf("delete stream session: %w", err))
		}
	}
	if s.taskRuntime.store != nil {
		if err := s.taskRuntime.store.DeleteSession(ctx, sessionID); err != nil {
			errs = append(errs, fmt.Errorf("delete task session: %w", err))
		}
	}
	if s.cancellations != nil {
		s.cancellations.cancelSession(sessionID)
	}
	return errors.Join(errs...)
}

// initializeStoreErrorResponse keeps the capacity refusal distinct from every
// other session-store failure: only the typed capacity error becomes JSON-RPC
// CodeServerError with the fixed public message; other errors keep the generic
// internal-error mapping.
func initializeStoreErrorResponse(req *Request, err error) *Response {
	if errors.Is(err, ErrSessionCapacityExceeded) {
		return NewErrorResponse(req.ID, CodeServerError, ErrSessionCapacityExceeded.Error())
	}
	return NewErrorResponse(req.ID, CodeInternalError, "session error")
}
