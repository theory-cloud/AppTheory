package mcp

import (
	"context"
	"errors"
	"testing"
)

func TestLoggingSetLevelHook_RoundTrip(t *testing.T) {
	var got LoggingLevelRequest
	s := NewServer("test", "1.0.0", WithLoggingLevelHook(func(_ context.Context, req LoggingLevelRequest) error {
		got = req
		return nil
	}))
	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	params := mustMarshal(t, map[string]any{"level": string(LoggingLevelNotice)})
	req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodLoggingSetLevel, Params: params})
	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
	if err != nil {
		t.Fatalf("invoke logging/setLevel: %v", err)
	}
	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("parse logging/setLevel: %v", err)
	}
	if rpcResp.Error != nil {
		t.Fatalf("unexpected error: %+v", rpcResp.Error)
	}
	if got.SessionID != sessionID || got.Level != LoggingLevelNotice {
		t.Fatalf("unexpected logging hook request: %+v", got)
	}
}

func TestLoggingSetLevelHook_FailClosedWhenUnconfigured(t *testing.T) {
	s := NewServer("test", "1.0.0")
	sessionID := initializeSession(t, s)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	params := mustMarshal(t, map[string]any{"level": string(LoggingLevelInfo)})
	req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodLoggingSetLevel, Params: params})
	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
	if err != nil {
		t.Fatalf("invoke logging/setLevel: %v", err)
	}
	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("parse logging/setLevel: %v", err)
	}
	if rpcResp.Error == nil || rpcResp.Error.Code != CodeMethodNotFound {
		t.Fatalf("expected method-not-found for unconfigured logging, got: %+v", rpcResp.Error)
	}
}

func TestLoggingSetLevelHook_ValidatesLevelsAndErrors(t *testing.T) {
	t.Run("missing level", func(t *testing.T) {
		s := NewServer("test", "1.0.0", WithLoggingLevelHook(func(context.Context, LoggingLevelRequest) error { return nil }))
		sessionID := initializeSession(t, s)
		headers := sessionHeaders(sessionID)
		headers["accept"] = []string{"application/json, text/event-stream"}

		req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodLoggingSetLevel, Params: mustMarshal(t, map[string]any{})})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
		if err != nil {
			t.Fatalf("invoke logging/setLevel: %v", err)
		}
		rpcResp, err := parseJSONRPCResponse(resp)
		if err != nil {
			t.Fatalf("parse logging/setLevel: %v", err)
		}
		if rpcResp.Error == nil || rpcResp.Error.Code != CodeInvalidParams {
			t.Fatalf("expected invalid params for missing level, got: %+v", rpcResp.Error)
		}
	})

	t.Run("unknown level", func(t *testing.T) {
		s := NewServer("test", "1.0.0", WithLoggingLevelHook(func(context.Context, LoggingLevelRequest) error { return nil }))
		sessionID := initializeSession(t, s)
		headers := sessionHeaders(sessionID)
		headers["accept"] = []string{"application/json, text/event-stream"}

		params := mustMarshal(t, map[string]any{"level": "verbose"})
		req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodLoggingSetLevel, Params: params})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
		if err != nil {
			t.Fatalf("invoke logging/setLevel: %v", err)
		}
		rpcResp, err := parseJSONRPCResponse(resp)
		if err != nil {
			t.Fatalf("parse logging/setLevel: %v", err)
		}
		if rpcResp.Error == nil || rpcResp.Error.Code != CodeInvalidParams {
			t.Fatalf("expected invalid params for unknown level, got: %+v", rpcResp.Error)
		}
	})

	t.Run("hook error", func(t *testing.T) {
		s := NewServer("test", "1.0.0", WithLoggingLevelHook(func(context.Context, LoggingLevelRequest) error {
			return errors.New("logging denied")
		}))
		sessionID := initializeSession(t, s)
		headers := sessionHeaders(sessionID)
		headers["accept"] = []string{"application/json, text/event-stream"}

		params := mustMarshal(t, map[string]any{"level": string(LoggingLevelError)})
		req := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodLoggingSetLevel, Params: params})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", req, headers)
		if err != nil {
			t.Fatalf("invoke logging/setLevel: %v", err)
		}
		rpcResp, err := parseJSONRPCResponse(resp)
		if err != nil {
			t.Fatalf("parse logging/setLevel: %v", err)
		}
		if rpcResp.Error == nil || rpcResp.Error.Code != CodeServerError {
			t.Fatalf("expected server error for hook error, got: %+v", rpcResp.Error)
		}
	})
}

func TestValidLoggingLevel(t *testing.T) {
	for _, level := range []LoggingLevel{
		LoggingLevelDebug,
		LoggingLevelInfo,
		LoggingLevelNotice,
		LoggingLevelWarning,
		LoggingLevelError,
		LoggingLevelCritical,
		LoggingLevelAlert,
		LoggingLevelEmergency,
	} {
		if !validLoggingLevel(level) {
			t.Fatalf("expected %q to be valid", level)
		}
	}
	if validLoggingLevel("verbose") {
		t.Fatalf("expected verbose to be invalid")
	}
}
