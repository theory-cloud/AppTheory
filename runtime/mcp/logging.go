package mcp

import (
	"context"
	"encoding/json"
)

// LoggingLevel is an MCP logging level.
type LoggingLevel string

const (
	LoggingLevelDebug     LoggingLevel = "debug"
	LoggingLevelInfo      LoggingLevel = "info"
	LoggingLevelNotice    LoggingLevel = "notice"
	LoggingLevelWarning   LoggingLevel = "warning"
	LoggingLevelError     LoggingLevel = "error"
	LoggingLevelCritical  LoggingLevel = "critical"
	LoggingLevelAlert     LoggingLevel = "alert"
	LoggingLevelEmergency LoggingLevel = "emergency"
)

// LoggingLevelRequest identifies a logging/setLevel request for a session.
type LoggingLevelRequest struct {
	SessionID string       `json:"sessionId"`
	Level     LoggingLevel `json:"level"`
}

// LoggingLevelHook handles a logging/setLevel request.
type LoggingLevelHook func(ctx context.Context, req LoggingLevelRequest) error

type loggingSetLevelParams struct {
	Level LoggingLevel `json:"level"`
}

func validLoggingLevel(level LoggingLevel) bool {
	switch level {
	case LoggingLevelDebug,
		LoggingLevelInfo,
		LoggingLevelNotice,
		LoggingLevelWarning,
		LoggingLevelError,
		LoggingLevelCritical,
		LoggingLevelAlert,
		LoggingLevelEmergency:
		return true
	default:
		return false
	}
}

func (s *Server) handleLoggingSetLevel(ctx context.Context, req *Request, sessionID string) *Response {
	if s.loggingLevelHook == nil {
		return NewErrorResponse(req.ID, CodeMethodNotFound, "Method not found: "+req.Method)
	}

	var params loggingSetLevelParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
	}
	if params.Level == "" {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing level")
	}
	if !validLoggingLevel(params.Level) {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: unknown logging level")
	}

	if err := s.loggingLevelHook(ctx, LoggingLevelRequest{SessionID: sessionID, Level: params.Level}); err != nil {
		return NewErrorResponse(req.ID, CodeServerError, err.Error())
	}

	return NewResultResponse(req.ID, map[string]any{})
}
