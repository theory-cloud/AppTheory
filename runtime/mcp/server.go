package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

// protocolVersion is the MCP protocol version supported by this server.
const protocolVersion = "2025-06-18"

const (
	defaultSessionTTLMinutes = 60
	envSessionTTLMinutes     = "MCP_SESSION_TTL_MINUTES"
)

// Server is the MCP protocol handler. It dispatches JSON-RPC 2.0 messages
// to the appropriate MCP method handlers (initialize, tools/list, tools/call).
type Server struct {
	name             string
	version          string
	registry         *ToolRegistry
	resourceRegistry *ResourceRegistry
	promptRegistry   *PromptRegistry
	sessionStore     SessionStore
	idGen            apptheory.IDGenerator
	logger           *slog.Logger
}

// ServerOption configures a Server.
type ServerOption func(*Server)

// WithSessionStore sets the session store for the server.
func WithSessionStore(store SessionStore) ServerOption {
	return func(s *Server) {
		s.sessionStore = store
	}
}

// WithIDGenerator sets the ID generator for session IDs.
func WithServerIDGenerator(gen apptheory.IDGenerator) ServerOption {
	return func(s *Server) {
		s.idGen = gen
	}
}

// WithLogger sets the structured logger for the server.
func WithLogger(logger *slog.Logger) ServerOption {
	return func(s *Server) {
		s.logger = logger
	}
}

// NewServer creates an MCP server with the given name, version, and options.
func NewServer(name, version string, opts ...ServerOption) *Server {
	s := &Server{
		name:             name,
		version:          version,
		registry:         NewToolRegistry(),
		resourceRegistry: NewResourceRegistry(),
		promptRegistry:   NewPromptRegistry(),
		sessionStore:     NewMemorySessionStore(),
		idGen:            apptheory.RandomIDGenerator{},
		logger:           slog.Default(),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// Registry returns the server's tool registry for registering tools.
func (s *Server) Registry() *ToolRegistry {
	return s.registry
}

// Resources returns the server's resource registry for registering resources.
func (s *Server) Resources() *ResourceRegistry {
	return s.resourceRegistry
}

// Prompts returns the server's prompt registry for registering prompts.
func (s *Server) Prompts() *PromptRegistry {
	return s.promptRegistry
}

// Handler returns an apptheory.Handler that processes MCP JSON-RPC requests.
// It handles session management via the Mcp-Session-Id header and dispatches
// to initialize, tools/list, and tools/call method handlers.
//
// When the Accept header is text/event-stream and the method is tools/call,
// the response is formatted as SSE. Otherwise, a buffered JSON response is returned.
func (s *Server) Handler() apptheory.Handler {
	return func(c *apptheory.Context) (*apptheory.Response, error) {
		ctx := c.Context()
		body := c.Request.Body

		// Resolve or create session.
		sessionID := firstHeader(c.Request.Headers, "mcp-session-id")
		sessionID, err := s.resolveSession(ctx, sessionID)
		if err != nil {
			s.logger.ErrorContext(ctx, "session error", "error", err)
			return jsonRPCErrorResponse(nil, CodeInternalError, "session error"), nil
		}

		// Try to detect batch vs single request.
		trimmed := trimLeftSpace(body)
		if len(trimmed) > 0 && trimmed[0] == '[' {
			return s.handleBatch(ctx, body, sessionID)
		}

		// Parse single request.
		req, parseErr := ParseRequest(body)
		if parseErr != nil {
			s.logger.ErrorContext(ctx, "parse error", "error", parseErr)
			resp := NewErrorResponse(nil, CodeParseError, "Parse error: "+parseErr.Error())
			return s.marshalSingleResponse(resp, sessionID, c.Request.Headers)
		}

		// Check if client wants SSE for tools/call.
		if req.Method == "tools/call" && wantsSSE(c.Request.Headers) {
			sseResp, sseErr := s.handleToolsCallStreaming(ctx, req)
			if sseErr != nil {
				return nil, sseErr
			}
			if sseResp.Headers == nil {
				sseResp.Headers = map[string][]string{}
			}
			if sessionID != "" {
				sseResp.Headers["mcp-session-id"] = []string{sessionID}
			}
			return sseResp, nil
		}

		resp := s.dispatch(ctx, req)
		return s.marshalSingleResponse(resp, sessionID, c.Request.Headers)
	}
}

// dispatch routes a parsed JSON-RPC request to the appropriate MCP method handler.
func (s *Server) dispatch(ctx context.Context, req *Request) *Response {
	switch req.Method {
	case "initialize":
		return s.handleInitialize(req)
	case "tools/list":
		return s.handleToolsList(req)
	case "tools/call":
		return s.handleToolsCall(ctx, req)
	case "resources/list":
		return s.handleResourcesList(req)
	case "resources/read":
		return s.handleResourcesRead(ctx, req)
	case "prompts/list":
		return s.handlePromptsList(req)
	case "prompts/get":
		return s.handlePromptsGet(ctx, req)
	default:
		s.logger.ErrorContext(ctx, "method not found", "method", req.Method)
		return NewErrorResponse(req.ID, CodeMethodNotFound, fmt.Sprintf("Method not found: %s", req.Method))
	}
}

// handleInitialize responds to the MCP initialize request with server capabilities.
func (s *Server) handleInitialize(req *Request) *Response {
	capabilities := map[string]any{
		"tools": map[string]any{},
	}
	if s.resourceRegistry.Len() > 0 {
		capabilities["resources"] = map[string]any{}
	}
	if s.promptRegistry.Len() > 0 {
		capabilities["prompts"] = map[string]any{}
	}

	result := map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    capabilities,
		"serverInfo": map[string]any{
			"name":    s.name,
			"version": s.version,
		},
	}
	return NewResultResponse(req.ID, result)
}

// handleToolsList responds with all registered tools.
func (s *Server) handleToolsList(req *Request) *Response {
	tools := s.registry.List()
	result := map[string]any{
		"tools": tools,
	}
	return NewResultResponse(req.ID, result)
}

// toolsCallParams holds the parsed parameters for a tools/call request.
type toolsCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// handleToolsCall invokes a registered tool by name (buffered JSON mode).
func (s *Server) handleToolsCall(ctx context.Context, req *Request) *Response {
	var params toolsCallParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
	}

	if params.Name == "" {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing tool name")
	}

	result, err := s.registry.Call(ctx, params.Name, params.Arguments)
	if err != nil {
		return s.toolCallError(ctx, req.ID, params.Name, err)
	}

	return NewResultResponse(req.ID, result)
}

// handleToolsCallStreaming invokes a registered tool with SSE streaming support.
func (s *Server) handleToolsCallStreaming(ctx context.Context, req *Request) (*apptheory.Response, error) {
	var params toolsCallParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		resp := NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
		return marshalSSEResponse(resp)
	}

	if params.Name == "" {
		resp := NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing tool name")
		return marshalSSEResponse(resp)
	}

	events := make(chan apptheory.SSEEvent)

	go func() {
		defer close(events)

		emit := func(ev SSEEvent) {
			select {
			case <-ctx.Done():
				return
			case events <- apptheory.SSEEvent{
				Event: "progress",
				Data:  ev.Data,
			}:
			}
		}

		result, err := s.registry.CallStreaming(ctx, params.Name, params.Arguments, emit)

		var finalResp *Response
		if err != nil {
			finalResp = s.toolCallError(ctx, req.ID, params.Name, err)
		} else {
			finalResp = NewResultResponse(req.ID, result)
		}

		select {
		case <-ctx.Done():
			return
		case events <- apptheory.SSEEvent{
			Event: "message",
			Data:  finalResp,
		}:
		}
	}()

	return apptheory.SSEStreamResponse(ctx, 200, events)
}

// toolCallError maps a tool call error to the appropriate JSON-RPC error response.
// It detects context deadline exceeded (timeout) and wraps handler errors with
// code -32000 (Server error).
func (s *Server) toolCallError(ctx context.Context, reqID any, toolName string, err error) *Response {
	if strings.HasPrefix(err.Error(), "tool not found:") {
		return NewErrorResponse(reqID, CodeInvalidParams, err.Error())
	}

	// Check for context deadline exceeded (timeout).
	if ctx.Err() == context.DeadlineExceeded || errors.Is(err, context.DeadlineExceeded) {
		s.logger.ErrorContext(ctx, "tool timeout",
			"tool", toolName,
			"error", err,
		)
		return NewErrorResponse(reqID, CodeServerError, fmt.Sprintf("tool %q timed out", toolName))
	}

	s.logger.ErrorContext(ctx, "tool error",
		"tool", toolName,
		"error", err,
	)
	return NewErrorResponse(reqID, CodeServerError, err.Error())
}

// marshalSSEResponse wraps a JSON-RPC response as a single SSE event.
func marshalSSEResponse(resp *Response) (*apptheory.Response, error) {
	return apptheory.SSEResponse(200, apptheory.SSEEvent{
		Event: "message",
		Data:  resp,
	})
}

// handleBatch processes a JSON-RPC batch request (array of requests).
// It parses each request, dispatches it, and returns an array of responses.
func (s *Server) handleBatch(ctx context.Context, body []byte, sessionID string) (*apptheory.Response, error) {
	requests, err := ParseBatchRequest(body)
	if err != nil {
		s.logger.ErrorContext(ctx, "batch parse error", "error", err)
		resp := NewErrorResponse(nil, CodeParseError, "Parse error: "+err.Error())
		data, marshalErr := MarshalResponse(resp)
		if marshalErr != nil {
			return nil, marshalErr
		}
		headers := map[string][]string{
			"content-type": {"application/json"},
		}
		if sessionID != "" {
			headers["mcp-session-id"] = []string{sessionID}
		}
		return &apptheory.Response{
			Status:  200,
			Headers: headers,
			Body:    data,
		}, nil
	}

	responses := make([]*Response, len(requests))
	for i, req := range requests {
		responses[i] = s.dispatch(ctx, req)
	}

	data, err := json.Marshal(responses)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal batch response: %w", err)
	}

	headers := map[string][]string{
		"content-type": {"application/json"},
	}
	if sessionID != "" {
		headers["mcp-session-id"] = []string{sessionID}
	}

	return &apptheory.Response{
		Status:  200,
		Headers: headers,
		Body:    data,
	}, nil
}

func sessionTTL() time.Duration {
	raw := strings.TrimSpace(os.Getenv(envSessionTTLMinutes))
	if raw != "" {
		if minutes, err := strconv.Atoi(raw); err == nil && minutes > 0 {
			return time.Duration(minutes) * time.Minute
		}
	}
	return time.Duration(defaultSessionTTLMinutes) * time.Minute
}

// resolveSession looks up an existing session or creates a new one.
// Returns the session ID to use in the response.
func (s *Server) resolveSession(ctx context.Context, sessionID string) (string, error) {
	now := time.Now().UTC()
	ttl := sessionTTL()

	if sessionID != "" {
		sess, err := s.sessionStore.Get(ctx, sessionID)
		switch {
		case err == nil:
			if !sess.ExpiresAt.IsZero() && now.After(sess.ExpiresAt) {
				if delErr := s.sessionStore.Delete(ctx, sessionID); delErr != nil {
					s.logger.ErrorContext(ctx, "failed to delete expired session", "sessionId", sessionID, "error", delErr)
				}
				break
			}

			// Refresh session TTL on access (sliding window).
			sess.ExpiresAt = now.Add(ttl)
			if sess.CreatedAt.IsZero() {
				sess.CreatedAt = now
			}
			if putErr := s.sessionStore.Put(ctx, sess); putErr != nil {
				return "", fmt.Errorf("failed to refresh session: %w", putErr)
			}

			return sessionID, nil
		case errors.Is(err, ErrSessionNotFound):
			// Session expired or invalid — fall through to create new one.
		default:
			return "", fmt.Errorf("failed to get session: %w", err)
		}
	}

	// Create a new session.
	newID := s.idGen.NewID()
	sess := &Session{
		ID:        newID,
		CreatedAt: now,
		ExpiresAt: now.Add(ttl),
	}
	if err := s.sessionStore.Put(ctx, sess); err != nil {
		return "", fmt.Errorf("failed to create session: %w", err)
	}
	return newID, nil
}

// marshalSingleResponse serializes a JSON-RPC response and wraps it in an
// apptheory.Response with the appropriate headers.
func (s *Server) marshalSingleResponse(resp *Response, sessionID string, _ map[string][]string) (*apptheory.Response, error) {
	data, err := MarshalResponse(resp)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal response: %w", err)
	}

	headers := map[string][]string{
		"content-type": {"application/json"},
	}
	if sessionID != "" {
		headers["mcp-session-id"] = []string{sessionID}
	}

	return &apptheory.Response{
		Status:  200,
		Headers: headers,
		Body:    data,
	}, nil
}

// jsonRPCErrorResponse creates an apptheory.Response containing a JSON-RPC error.
func jsonRPCErrorResponse(id any, code int, message string) *apptheory.Response {
	resp := NewErrorResponse(id, code, message)
	data, err := MarshalResponse(resp)
	if err != nil {
		data = []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"internal error"}}`)
	}
	return &apptheory.Response{
		Status: 200,
		Headers: map[string][]string{
			"content-type": {"application/json"},
		},
		Body: data,
	}
}

// firstHeader returns the first value for a header key (case-insensitive lookup
// on already-canonicalized headers).
func firstHeader(headers map[string][]string, key string) string {
	values := headers[strings.ToLower(key)]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

// wantsSSE returns true if the Accept header includes text/event-stream.
func wantsSSE(headers map[string][]string) bool {
	for _, v := range headers["accept"] {
		if strings.Contains(strings.ToLower(v), "text/event-stream") {
			return true
		}
	}
	return false
}
