// Package refusal carries the framework's structured refusal telemetry: one
// redacted event for every 400, 401, 403, 404, and 405 the framework renders on
// an OAuth or MCP surface.
//
// The event exists because the alternative is unanswerable: a client that is
// refused needs an operator to know which refusal it hit and why, and a
// framework that renders a bare status leaves most refusals invisible. It is
// schema-redacted by construction: an event carries a status, a closed reason
// slug, the request method, the request path (never the query string), the
// client-facing error code, and the challenge shape. It never carries a bearer
// token, an authorization code, a refresh handle, a cookie, or a request body.
package refusal

import (
	"context"
	"time"
)

// Class names the surface that rendered the refusal.
type Class string

const (
	// ClassBearer is the OAuth bearer middleware or route guard.
	ClassBearer Class = "bearer"
	// ClassTransport is the MCP streamable-HTTP endpoint (POST, GET, DELETE).
	ClassTransport Class = "transport"
	// ClassFacade is the framework-owned MCP auth facade (authorize, callback,
	// token, register, metadata).
	ClassFacade Class = "facade"
)

// Reason is the closed refusal vocabulary. A reason names why the request was
// refused, not what the client should do about it: the status and the
// client-facing error code carry that.
const (
	// ReasonUnclassified is emitted when a refusal has no more specific reason.
	// It still makes the refusal visible, which is the point of the event.
	ReasonUnclassified = "unclassified"

	// Bearer reasons.
	ReasonMissingCredential = "missing_credential"
	ReasonInvalidCredential = "invalid_credential"
	ReasonExpiredCredential = "expired_credential"
	ReasonAudienceMismatch  = "audience_mismatch"
	ReasonInsufficientScope = "insufficient_scope"

	// Transport reasons.
	ReasonMethodNotAllowed      = "method_not_allowed"
	ReasonOriginRefused         = "origin_refused"
	ReasonMissingSessionID      = "missing_session_id"
	ReasonUnknownSession        = "unknown_session"
	ReasonUnknownEvent          = "unknown_event"
	ReasonUnknownStream         = "unknown_stream"
	ReasonMissingContentType    = "missing_content_type"
	ReasonMissingAccept         = "missing_accept"
	ReasonInvalidJSONRPC        = "invalid_jsonrpc"
	ReasonProtocolVersion       = "protocol_version"
	ReasonBatchUnsupported      = "batch_unsupported"
	ReasonSessionPrincipal      = "session_principal_mismatch"
	ReasonParseError            = "parse_error"
	ReasonInternal              = "internal_error"
	ReasonUnsupportedMethod     = "unsupported_method"
	ReasonInvalidMessage        = "invalid_message"
	ReasonMissingRequiredClient = "missing_required_client_capability"

	// Facade reasons fall back to the client-facing OAuth error code, for
	// example invalid_grant, invalid_request, invalid_client, invalid_scope,
	// invalid_target, unsupported_grant_type, temporarily_unavailable, or the
	// app.unauthorized / app.forbidden JSON envelope codes.
)

// Event is one schema-redacted refusal.
type Event struct {
	// At is the framework clock instant the refusal was rendered.
	At time.Time
	// Class is the surface that rendered it.
	Class Class
	// Reason is the closed reason slug above, or the client-facing OAuth error
	// code for a facade refusal.
	Reason string
	// Status is the HTTP status the client received.
	Status int
	// Method is the request method.
	Method string
	// Path is the request path. It never includes the query string.
	Path string
	// ErrorCode is the client-facing error code the response body carried, when
	// the body is the framework's own error shape.
	ErrorCode string
	// Challenge names the WWW-Authenticate form: resource_metadata,
	// insufficient_scope, bare, or empty when no challenge was sent.
	Challenge string
}

// Hook receives one refusal event. It runs synchronously on the response path,
// before the response is written. A hook must not block; a panic is recovered so
// telemetry can never fail a request.
type Hook func(ctx context.Context, event Event)

// Emit delivers event to hook. A nil hook is a no-op and a panicking hook is
// contained.
func Emit(ctx context.Context, hook Hook, event Event) {
	if hook == nil {
		return
	}
	defer func() {
		//nolint:errcheck // recover is the containment mechanism; its value is intentionally discarded.
		_ = recover()
	}()
	hook(ctx, event)
}

// IsRefusalStatus reports whether status is one the framework reports: 400,
// 401, 403, 404, or 405.
func IsRefusalStatus(status int) bool {
	switch status {
	case 400, 401, 403, 404, 405:
		return true
	default:
		return false
	}
}
