package mcp

import (
	"context"
	"errors"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
)

// GET /mcp handling: origin and shape checks, the two declined-GET orderings,
// and the stream or replay tail shared by both.
func (s *Server) handleGET(c *apptheory.Context) (*apptheory.Response, error) {
	ctx := withCallerIdentity(c.Context(), callerIdentity(c))

	if resp := s.validateOrigin(c.Request.Headers); resp != nil {
		return resp, nil
	}
	if DetectProtocolVersion(c.Request.Headers, nil) == ProtocolShape20260728 {
		return methodNotAllowed("POST"), nil
	}
	if s.declinedGETValidationFirst {
		return s.handleDeclinedGETValidationFirst(ctx, c)
	}
	// An unsupported MCP-Protocol-Version is 400 before anything else: the spec
	// makes that response mandatory for an invalid or unsupported version.
	if _, resp := requestProtocolVersion(c.Request.Headers, nil); resp != nil {
		return resp, nil
	}
	// A server that does not offer an SSE stream must answer every plain GET with
	// 405 ("Listening for Messages from the Server", MCP 2025-06-18: the server
	// MUST either return text/event-stream or 405). This is decided before the
	// session checks on purpose: a buffered deployment that cannot stream would
	// otherwise answer a pre-session GET with 400, which a per-call client that
	// probes GET first reads as a client error, and the stream is absent either
	// way. WithDeclinedGETValidationFirst selects the validation-first order
	// instead. Last-Event-ID replay keeps its own path below.
	lastEventID := firstHeader(c.Request.Headers, headerLastEventID)
	if !s.initialSessionListenerEnabled && lastEventID == "" {
		return methodNotAllowed("DELETE, GET, POST"), nil
	}
	if resp := validateGETHeaders(c.Request.Headers); resp != nil {
		return resp, nil
	}

	sessionID, sess, errResp := s.requireSession(ctx, c.Request.Headers)
	if errResp != nil {
		return errResp, nil
	}
	if pvResp := s.requireProtocolVersion(c.Request.Headers, sess); pvResp != nil {
		return pvResp, nil
	}

	return s.serveGETStream(ctx, c, sessionID, lastEventID)
}

// handleDeclinedGETValidationFirst answers a plain GET /mcp in the
// validation-first order selected by WithDeclinedGETValidationFirst: origin and
// protocol shape (already checked by handleGET), then GET headers, session
// (whose sliding-TTL refresh is the point of the option), protocol version, and
// only then the stream-less 405 or the stream itself. This is the order the
// Go runtime used before v7.1.0 and the order TypeScript and Python still use.
func (s *Server) handleDeclinedGETValidationFirst(ctx context.Context, c *apptheory.Context) (*apptheory.Response, error) {
	if resp := validateGETHeaders(c.Request.Headers); resp != nil {
		return resp, nil
	}

	sessionID, sess, errResp := s.requireSession(ctx, c.Request.Headers)
	if errResp != nil {
		return errResp, nil
	}
	if pvResp := s.requireProtocolVersion(c.Request.Headers, sess); pvResp != nil {
		return pvResp, nil
	}

	lastEventID := firstHeader(c.Request.Headers, headerLastEventID)
	return s.serveGETStream(ctx, c, sessionID, lastEventID)
}

// serveGETStream answers the part of GET /mcp shared by both orderings: a
// stream-less request without Last-Event-ID is declined with 405 when the
// session listener is disabled, otherwise it opens the keepalive listener, and
// a Last-Event-ID request replays the identified stream.
func (s *Server) serveGETStream(ctx context.Context, c *apptheory.Context, sessionID, lastEventID string) (*apptheory.Response, error) {
	if lastEventID == "" {
		if !s.initialSessionListenerEnabled {
			return methodNotAllowed("DELETE, GET, POST"), nil
		}
		// No resumable stream requested. Keep the connection open as a session-level
		// SSE listener (clients will reconnect in a tight loop if we return EOF).
		return s.openSessionListener(ctx, sessionID, c.RemainingMS)
	}

	streamID, err := s.streamStore.StreamForEvent(ctx, sessionID, lastEventID)
	if err != nil {
		if errors.Is(err, ErrEventNotFound) {
			return notFound("event not found"), nil
		}
		s.logger.ErrorContext(ctx, "stream store error", "error", err)
		return internalServerError(), nil
	}

	// The replay body is produced by the store's subscription pump and the SSE
	// writer; the scope keeps both joined to the response body.
	scope := newStreamScope(ctx)
	events, err := s.streamStore.Subscribe(scope.context(), sessionID, streamID, lastEventID)
	if err != nil {
		scope.stop()
		if errors.Is(err, ErrStreamNotFound) {
			return notFound("stream not found"), nil
		}
		s.logger.ErrorContext(ctx, "stream store error", "error", err)
		return internalServerError(), nil
	}

	return s.streamToSSE(scope, sessionID, events)
}
