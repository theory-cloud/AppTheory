package mcp

import (
	"encoding/json"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/refusal"
)

// transportRefusalReason maps a transport refusal response to the closed reason
// vocabulary. The transport's refusal bodies are a fixed, small set produced by
// badRequest, notFound, and methodNotAllowed; a body outside the set is still
// reported, as unclassified, so no refusal is invisible.
func transportRefusalReason(response *apptheory.Response) string {
	if response == nil {
		return refusal.ReasonUnclassified
	}
	switch response.Status {
	case 400:
		return transportBadRequestReason(responseErrorMessage(response.Body))
	case 403:
		if responseErrorMessage(response.Body) == "forbidden" {
			return refusal.ReasonOriginRefused
		}
		return refusal.ReasonUnclassified
	case 404:
		return transportNotFoundReason(responseErrorMessage(response.Body))
	case 405:
		return refusal.ReasonMethodNotAllowed
	default:
		return refusal.ReasonUnclassified
	}
}

// transportNotFoundReason maps the transport's 404 bodies.
func transportNotFoundReason(message string) string {
	switch message {
	case "event not found":
		return refusal.ReasonUnknownEvent
	case "stream not found":
		return refusal.ReasonUnknownStream
	default:
		return refusal.ReasonUnknownSession
	}
}

// transportBadRequestReason maps the transport's 400 bodies.
func transportBadRequestReason(message string) string {
	switch message {
	case "missing Mcp-Session-Id":
		return refusal.ReasonMissingSessionID
	case "GET /mcp requires Accept: text/event-stream",
		"POST /mcp requires Accept: application/json and text/event-stream":
		return refusal.ReasonMissingAccept
	case "POST /mcp requires Content-Type: application/json":
		return refusal.ReasonMissingContentType
	case "unsupported MCP-Protocol-Version", "MCP-Protocol-Version mismatch":
		return refusal.ReasonProtocolVersion
	case "batch requests are only supported for MCP-Protocol-Version 2025-03-26":
		return refusal.ReasonBatchUnsupported
	case "invalid JSON-RPC message", "invalid JSON-RPC response":
		return refusal.ReasonInvalidJSONRPC
	default:
		return refusal.ReasonUnclassified
	}
}

// responseErrorMessage reads the message member of the transport's error body
// shape, {"error":"..."}; any other shape reports no message.
func responseErrorMessage(body []byte) string {
	var payload struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	return payload.Error
}

// observeRefusal emits one structured event for every refusal status the
// transport rendered. It never reads the request body, the query string, or a
// credential: the event carries the method, the path, the status, and the reason.
func (s *Server) observeRefusal(c *apptheory.Context, response *apptheory.Response) {
	if s == nil || s.refusalHook == nil || c == nil || response == nil {
		return
	}
	if !refusal.IsRefusalStatus(response.Status) {
		return
	}
	refusal.Emit(c.Context(), s.refusalHook, refusal.Event{
		At:     c.Now(),
		Class:  refusal.ClassTransport,
		Reason: transportRefusalReason(response),
		Status: response.Status,
		Method: c.Request.Method,
		Path:   c.Request.Path,
	})
}
