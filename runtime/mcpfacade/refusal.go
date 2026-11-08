package mcpfacade

import (
	"encoding/json"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/refusal"
)

// observeFacadeRefusal wraps one facade route handler so every 400, 401, 403,
// 404, and 405 it renders produces exactly one structured refusal event. The MCP
// transport routes are deliberately not wrapped here: they report through
// mcp.WithRefusalHook on the MCP handler, so a transport refusal is not counted
// twice.
func observeFacadeRefusal(hook refusal.Hook, next apptheory.Handler) apptheory.Handler {
	if hook == nil {
		return next
	}
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		response, err := next(ctx)
		if response == nil || !refusal.IsRefusalStatus(response.Status) {
			return response, err
		}
		code := facadeResponseErrorCode(response.Body)
		reason := code
		if reason == "" {
			reason = refusal.ReasonUnclassified
		}
		refusal.Emit(ctx.Context(), hook, refusal.Event{
			At:        ctx.Now(),
			Class:     refusal.ClassFacade,
			Reason:    reason,
			Status:    response.Status,
			Method:    ctx.Request.Method,
			Path:      ctx.Request.Path,
			ErrorCode: code,
			Challenge: responseChallenge(response.Headers),
		})
		return response, err
	}
}

// facadeResponseErrorCode reads the client-facing error code from either facade
// error shape: the OAuth {"error":"invalid_grant",...} body and the app
// {"error":{"code":"app.unauthorized",...}} body. A body that is neither reports
// no code.
func facadeResponseErrorCode(body []byte) string {
	var envelope struct {
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return ""
	}
	var code string
	if err := json.Unmarshal(envelope.Error, &code); err == nil {
		return strings.TrimSpace(code)
	}
	var nested struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(envelope.Error, &nested); err == nil {
		return strings.TrimSpace(nested.Code)
	}
	return ""
}

// responseChallenge names the WWW-Authenticate form a refusal carried, so an
// operator can tell a bare challenge from one that points at the discovery
// document or at a scope remediation.
func responseChallenge(headers map[string][]string) string {
	for name, values := range headers {
		if !strings.EqualFold(name, "www-authenticate") || len(values) == 0 {
			continue
		}
		challenge := values[0]
		switch {
		case strings.Contains(challenge, "insufficient_scope"):
			return "insufficient_scope"
		case strings.Contains(challenge, "resource_metadata"):
			return "resource_metadata"
		default:
			return "bare"
		}
	}
	return ""
}
