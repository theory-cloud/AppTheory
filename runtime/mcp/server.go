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
	protocolVersionLegacy = "2025-03-26"

	headerMcpProtocolVersion = "mcp-protocol-version"
	headerMcpSessionID       = "mcp-session-id"
	headerLastEventID        = "last-event-id"
)

const (
	methodInitialize               = "initialize"
	methodNotificationsInitialized = "notifications/initialized"
	methodNotificationsCancelled   = "notifications/cancel" + "led"
	methodPing                     = "ping"
	methodToolsList                = "tools/list"
	methodToolsCall                = "tools/call"
	methodResourcesList            = "resources/list"
	methodResourcesRead            = "resources/read"
	methodPromptsList              = "prompts/list"
	methodPromptsGet               = "prompts/get"
)

const (
	defaultSessionTTLMinutes = 60
	envSessionTTLMinutes     = "MCP_SESSION_TTL_MINUTES"
	sessionInitializedValue  = "true"
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
	streamStore      StreamStore
	idGen            apptheory.IDGenerator
	logger           *slog.Logger
	originValidator  OriginValidator
}

// ServerOption configures a Server.
type ServerOption func(*Server)

// WithSessionStore sets the session store for the server.
func WithSessionStore(store SessionStore) ServerOption {
	return func(s *Server) {
		s.sessionStore = store
	}
}

// WithStreamStore sets the stream store for the server.
func WithStreamStore(store StreamStore) ServerOption {
	return func(s *Server) {
		s.streamStore = store
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

// WithOriginValidator sets the Origin validator for browser-based callers.
//
// If an Origin header is present, the request is rejected unless it passes
// validation (fail closed).
func WithOriginValidator(v OriginValidator) ServerOption {
	return func(s *Server) {
		s.originValidator = v
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
		streamStore:      NewMemoryStreamStore(),
		idGen:            apptheory.RandomIDGenerator{},
		logger:           slog.Default(),
		originValidator:  AllowOrigins("https://claude.ai", "https://claude.com"),
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
//
// Streamable HTTP semantics:
// - POST /mcp accepts JSON-RPC requests, notifications, and responses.
// - GET /mcp replays/resumes previously interrupted SSE streams via Last-Event-ID.
// - DELETE /mcp terminates a session.
//
// Notes:
//   - Clients must initialize first; the server issues Mcp-Session-Id on the
//     initialize response and requires it thereafter.
//   - Disconnects are not treated as cancellation. Streaming tool execution is
//     decoupled from the connection and can be resumed with GET.
func (s *Server) Handler() apptheory.Handler {
	return func(c *apptheory.Context) (*apptheory.Response, error) {
		switch strings.ToUpper(strings.TrimSpace(c.Request.Method)) {
		case "POST":
			return s.handlePOST(c)
		case "GET":
			return s.handleGET(c)
		case "DELETE":
			return s.handleDELETE(c)
		default:
			return &apptheory.Response{
				Status: 405,
				Headers: map[string][]string{
					"content-type": {"application/json"},
				},
				Body: []byte(`{"error":"method not allowed"}`),
			}, nil
		}
	}
}

func (s *Server) handlePOST(c *apptheory.Context) (*apptheory.Response, error) {
	ctx := c.Context()

	if resp := s.validateOrigin(c.Request.Headers); resp != nil {
		return resp, nil
	}

	body := c.Request.Body

	// Batch request support (legacy protocol only).
	trimmed := trimLeftSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		return s.handleBatch(ctx, body, c.Request.Headers)
	}

	raw, err := parseJSONObject(body)
	if err != nil {
		s.logger.ErrorContext(ctx, "parse error", "error", err)
		resp := NewErrorResponse(nil, CodeParseError, "Parse error: "+err.Error())
		return s.marshalSingleResponse(resp, "", false)
	}

	// Request/notification
	if _, hasMethod := raw["method"]; hasMethod {
		return s.handlePOSTRequest(ctx, body, c.Request.Headers)
	}

	// Response
	if _, hasResult := raw["result"]; hasResult || raw["error"] != nil {
		return s.handlePOSTResponse(ctx, body, c.Request.Headers)
	}

	return badRequest("invalid JSON-RPC message"), nil
}

func (s *Server) handlePOSTRequest(ctx context.Context, body []byte, headers map[string][]string) (*apptheory.Response, error) {
	req, parseErr := ParseRequest(body)
	if parseErr != nil {
		s.logger.ErrorContext(ctx, "parse error", "error", parseErr)
		resp := NewErrorResponse(nil, CodeParseError, "Parse error: "+parseErr.Error())
		return s.marshalSingleResponse(resp, "", false)
	}

	// initialize creates and returns a session id.
	if req.Method == methodInitialize {
		return s.handleInitializeHTTP(ctx, req)
	}

	sessionID, sess, errResp := s.requireSession(ctx, headers)
	if errResp != nil {
		return errResp, nil
	}
	if pvResp := s.requireProtocolVersion(headers, sess); pvResp != nil {
		return pvResp, nil
	}

	// Notifications return 202 Accepted with no body.
	if req.ID == nil {
		s.handleNotification(ctx, sess, req)
		return &apptheory.Response{Status: 202}, nil
	}

	return s.handleRequestHTTP(ctx, sessionID, req, headers)
}

func (s *Server) handlePOSTResponse(ctx context.Context, body []byte, headers map[string][]string) (*apptheory.Response, error) {
	_, parseErr := ParseResponse(body)
	if parseErr != nil {
		return badRequest("invalid JSON-RPC response"), nil
	}

	_, sess, errResp := s.requireSession(ctx, headers)
	if errResp != nil {
		return errResp, nil
	}
	if pvResp := s.requireProtocolVersion(headers, sess); pvResp != nil {
		return pvResp, nil
	}

	// Server currently does not issue client-bound requests, but responses
	// are part of the transport and must be accepted.
	return &apptheory.Response{Status: 202}, nil
}

func (s *Server) handleGET(c *apptheory.Context) (*apptheory.Response, error) {
	ctx := c.Context()

	if resp := s.validateOrigin(c.Request.Headers); resp != nil {
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
	if lastEventID == "" {
		// No resumable stream requested.
		return apptheory.SSEResponse(200)
	}

	streamID, err := s.streamStore.StreamForEvent(ctx, sessionID, lastEventID)
	if err != nil {
		if errors.Is(err, ErrEventNotFound) {
			return notFound("event not found"), nil
		}
		s.logger.ErrorContext(ctx, "stream store error", "error", err)
		return internalServerError(), nil
	}

	events, err := s.streamStore.Subscribe(ctx, sessionID, streamID, lastEventID)
	if err != nil {
		if errors.Is(err, ErrStreamNotFound) {
			return notFound("stream not found"), nil
		}
		s.logger.ErrorContext(ctx, "stream store error", "error", err)
		return internalServerError(), nil
	}

	return s.streamToSSE(ctx, sessionID, events)
}

func (s *Server) handleDELETE(c *apptheory.Context) (*apptheory.Response, error) {
	ctx := c.Context()

	if resp := s.validateOrigin(c.Request.Headers); resp != nil {
		return resp, nil
	}

	sessionID := firstHeader(c.Request.Headers, headerMcpSessionID)
	if sessionID == "" {
		return badRequest("missing Mcp-Session-Id"), nil
	}

	_, err := s.sessionStore.Get(ctx, sessionID)
	switch {
	case err == nil:
		// ok
	case errors.Is(err, ErrSessionNotFound):
		return notFound("session not found"), nil
	default:
		s.logger.ErrorContext(ctx, "session store error", "error", err)
		return internalServerError(), nil
	}

	if err := s.sessionStore.Delete(ctx, sessionID); err != nil {
		s.logger.ErrorContext(ctx, "failed to delete session", "sessionId", sessionID, "error", err)
		return internalServerError(), nil
	}
	if s.streamStore != nil {
		if err := s.streamStore.DeleteSession(ctx, sessionID); err != nil {
			s.logger.ErrorContext(ctx, "failed to delete stream session", "sessionId", sessionID, "error", err)
		}
	}

	return &apptheory.Response{Status: 202}, nil
}

// dispatch routes a parsed JSON-RPC request to the appropriate MCP method handler.
func (s *Server) dispatch(ctx context.Context, req *Request) *Response {
	switch req.Method {
	case methodInitialize:
		return s.handleInitialize(req, protocolVersion)
	case methodPing:
		return NewResultResponse(req.ID, map[string]any{})
	case methodToolsList:
		return s.handleToolsList(req)
	case methodToolsCall:
		return s.handleToolsCall(ctx, req)
	case methodResourcesList:
		return s.handleResourcesList(req)
	case methodResourcesRead:
		return s.handleResourcesRead(ctx, req)
	case methodPromptsList:
		return s.handlePromptsList(req)
	case methodPromptsGet:
		return s.handlePromptsGet(ctx, req)
	default:
		s.logger.ErrorContext(ctx, "method not found", "method", req.Method)
		return NewErrorResponse(req.ID, CodeMethodNotFound, fmt.Sprintf("Method not found: %s", req.Method))
	}
}

// handleInitialize responds to the MCP initialize request with server capabilities.
func (s *Server) handleInitialize(req *Request, selectedProtocolVersion string) *Response {
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
		"protocolVersion": selectedProtocolVersion,
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
	Meta      struct {
		ProgressToken string `json:"progressToken,omitempty"`
	} `json:"_meta,omitempty"`
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

// handleBatch processes a JSON-RPC batch request (array of requests).
// It parses each request, dispatches it, and returns an array of responses.
func (s *Server) handleBatch(ctx context.Context, body []byte, headers map[string][]string) (*apptheory.Response, error) {
	// Batch semantics are only supported for legacy clients.
	if pv := firstHeader(headers, headerMcpProtocolVersion); pv != "" && pv != protocolVersionLegacy {
		return badRequest("batch requests are only supported for MCP-Protocol-Version 2025-03-26"), nil
	}

	requests, err := ParseBatchRequest(body)
	if err != nil {
		return s.batchParseErrorResponse(ctx, err)
	}

	sessionID := firstHeader(headers, headerMcpSessionID)
	sess, sessErrResp := s.loadBatchSession(ctx, sessionID)
	if sessErrResp != nil {
		return sessErrResp, nil
	}

	createdSessionID, responses := s.runBatchRequests(ctx, requests, sessionID, sess)

	if len(responses) == 0 {
		return &apptheory.Response{Status: 202}, nil
	}

	data, err := json.Marshal(responses)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal batch response: %w", err)
	}

	outHeaders := map[string][]string{
		"content-type": {"application/json"},
	}
	if createdSessionID != "" {
		outHeaders[headerMcpSessionID] = []string{createdSessionID}
	}

	return &apptheory.Response{Status: 200, Headers: outHeaders, Body: data}, nil
}

func (s *Server) batchParseErrorResponse(ctx context.Context, err error) (*apptheory.Response, error) {
	s.logger.ErrorContext(ctx, "batch parse error", "error", err)
	resp := NewErrorResponse(nil, CodeParseError, "Parse error: "+err.Error())
	data, marshalErr := MarshalResponse(resp)
	if marshalErr != nil {
		return nil, marshalErr
	}
	respHeaders := map[string][]string{
		"content-type": {"application/json"},
	}
	return &apptheory.Response{
		Status:  200,
		Headers: respHeaders,
		Body:    data,
	}, nil
}

func (s *Server) loadBatchSession(ctx context.Context, sessionID string) (*Session, *apptheory.Response) {
	if sessionID == "" {
		return nil, nil
	}

	sess, err := s.getSession(ctx, sessionID)
	switch {
	case err == nil:
		return sess, nil
	case errors.Is(err, ErrSessionNotFound):
		return nil, notFound("session not found")
	default:
		s.logger.ErrorContext(ctx, "session store error", "error", err)
		return nil, internalServerError()
	}
}

func (s *Server) runBatchRequests(ctx context.Context, requests []*Request, sessionID string, sess *Session) (createdSessionID string, responses []*Response) {
	responses = make([]*Response, 0, len(requests))

	for _, req := range requests {
		if req.Method == methodInitialize {
			initResp, newSess, initErr := s.handleInitializeBatch(ctx, req)
			if initErr != nil {
				// Return initialize error as a normal JSON-RPC error response.
				if req.ID != nil {
					responses = append(responses, initErr)
				}
				continue
			}
			if req.ID != nil {
				responses = append(responses, initResp)
			}
			createdSessionID = newSess.ID
			sessionID = newSess.ID
			sess = newSess
			continue
		}

		// Notifications do not produce responses in batch mode.
		if req.ID == nil {
			continue
		}

		if sessionID == "" {
			responses = append(responses, NewErrorResponse(req.ID, CodeInvalidRequest, "missing session; call initialize first"))
			continue
		}

		if sess == nil {
			var sessionErr error
			sess, sessionErr = s.getSession(ctx, sessionID)
			if sessionErr != nil {
				responses = append(responses, NewErrorResponse(req.ID, CodeInternalError, "session error"))
				continue
			}
		}

		responses = append(responses, s.dispatch(ctx, req))
	}

	return createdSessionID, responses
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

// marshalSingleResponse serializes a JSON-RPC response and wraps it in an
// apptheory.Response with the appropriate headers.
func (s *Server) marshalSingleResponse(resp *Response, sessionID string, includeSession bool) (*apptheory.Response, error) {
	data, err := MarshalResponse(resp)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal response: %w", err)
	}

	headers := map[string][]string{
		"content-type": {"application/json"},
	}
	if includeSession && sessionID != "" {
		headers[headerMcpSessionID] = []string{sessionID}
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

func acceptsEventStream(headers map[string][]string) bool {
	for _, v := range headers["accept"] {
		if strings.Contains(strings.ToLower(v), "text/event-stream") {
			return true
		}
	}
	return false
}

func parseJSONObject(data []byte) (map[string]json.RawMessage, error) {
	if len(data) == 0 {
		return nil, errors.New("empty request body")
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func (s *Server) validateOrigin(headers map[string][]string) *apptheory.Response {
	origin := firstHeader(headers, "origin")
	if origin == "" {
		return nil
	}
	if s.originValidator == nil || !s.originValidator(origin) {
		return &apptheory.Response{
			Status: 403,
			Headers: map[string][]string{
				"content-type": {"application/json"},
			},
			Body: []byte(`{"error":"forbidden"}`),
		}
	}
	return nil
}

func isSupportedProtocolVersion(v string) bool {
	return v == protocolVersion || v == protocolVersionLegacy
}

func (s *Server) requireProtocolVersion(headers map[string][]string, sess *Session) *apptheory.Response {
	v := firstHeader(headers, headerMcpProtocolVersion)
	if v == "" {
		// Header is optional. When absent, behavior defaults to the session's
		// negotiated protocol (if any) and otherwise the legacy default.
		return nil
	}
	if !isSupportedProtocolVersion(v) {
		return badRequest("unsupported MCP-Protocol-Version")
	}
	if sess != nil && sess.Data != nil {
		if expected := sess.Data["protocolVersion"]; expected != "" && expected != v {
			return badRequest("MCP-Protocol-Version mismatch")
		}
	}
	return nil
}

func (s *Server) requireSession(ctx context.Context, headers map[string][]string) (string, *Session, *apptheory.Response) {
	sessionID := firstHeader(headers, headerMcpSessionID)
	if sessionID == "" {
		return "", nil, badRequest("missing Mcp-Session-Id")
	}

	sess, err := s.getSession(ctx, sessionID)
	switch {
	case err == nil:
		return sessionID, sess, nil
	case errors.Is(err, ErrSessionNotFound):
		return "", nil, notFound("session not found")
	default:
		s.logger.ErrorContext(ctx, "session store error", "error", err)
		return "", nil, internalServerError()
	}
}

func (s *Server) getSession(ctx context.Context, sessionID string) (*Session, error) {
	now := time.Now().UTC()
	ttl := sessionTTL()

	sess, err := s.sessionStore.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Refresh session TTL on access (sliding window).
	sess.ExpiresAt = now.Add(ttl)
	if sess.CreatedAt.IsZero() {
		sess.CreatedAt = now
	}
	if putErr := s.sessionStore.Put(ctx, sess); putErr != nil {
		return nil, fmt.Errorf("failed to refresh session: %w", putErr)
	}

	return sess, nil
}

func (s *Server) handleInitializeHTTP(ctx context.Context, req *Request) (*apptheory.Response, error) {
	selectedPV, errResp := s.negotiateInitializeProtocolVersion(req)
	if errResp != nil {
		return s.marshalSingleResponse(errResp, "", false)
	}

	sess, err := s.createSession(ctx, selectedPV)
	if err != nil {
		s.logger.ErrorContext(ctx, "failed to create session", "error", err)
		return jsonRPCErrorResponse(req.ID, CodeInternalError, "session error"), nil
	}

	resp := s.handleInitialize(req, selectedPV)
	return s.marshalSingleResponse(resp, sess.ID, true)
}

func (s *Server) negotiateInitializeProtocolVersion(req *Request) (string, *Response) {
	selected := protocolVersion
	if len(req.Params) == 0 {
		return selected, nil
	}

	var params struct {
		ProtocolVersion string `json:"protocolVersion,omitempty"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return "", NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
	}
	if params.ProtocolVersion == "" {
		return selected, nil
	}
	if !isSupportedProtocolVersion(params.ProtocolVersion) {
		return "", NewErrorResponse(req.ID, CodeInvalidParams, fmt.Sprintf("Unsupported protocolVersion: %s", params.ProtocolVersion))
	}
	return params.ProtocolVersion, nil
}

func (s *Server) createSession(ctx context.Context, selectedPV string) (*Session, error) {
	now := time.Now().UTC()
	ttl := sessionTTL()

	newID := s.idGen.NewID()
	sess := &Session{
		ID:        newID,
		CreatedAt: now,
		ExpiresAt: now.Add(ttl),
		Data: map[string]string{
			"protocolVersion": selectedPV,
		},
	}
	if err := s.sessionStore.Put(ctx, sess); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}
	return sess, nil
}

func (s *Server) handleInitializeBatch(ctx context.Context, req *Request) (*Response, *Session, *Response) {
	selectedPV, errResp := s.negotiateInitializeProtocolVersion(req)
	if errResp != nil {
		return nil, nil, errResp
	}
	sess, err := s.createSession(ctx, selectedPV)
	if err != nil {
		return nil, nil, NewErrorResponse(req.ID, CodeInternalError, "session error")
	}
	return s.handleInitialize(req, selectedPV), sess, nil
}

func (s *Server) handleNotification(ctx context.Context, sess *Session, req *Request) {
	switch req.Method {
	case methodNotificationsInitialized:
		if sess == nil {
			return
		}
		if sess.Data == nil {
			sess.Data = map[string]string{}
		}
		sess.Data["initialized"] = sessionInitializedValue
		if err := s.sessionStore.Put(ctx, sess); err != nil {
			s.logger.ErrorContext(ctx, "failed to persist session", "sessionId", sess.ID, "error", err)
		}
	case methodNotificationsCancelled:
		// Accepted for spec compliance; cancellation wiring is handled by higher-level
		// async implementations (e.g. theory-mcp).
	default:
	}
}

func (s *Server) handleRequestHTTP(ctx context.Context, sessionID string, req *Request, headers map[string][]string) (*apptheory.Response, error) {
	if req.Method == methodToolsCall && acceptsEventStream(headers) {
		return s.handleToolsCallStream(ctx, sessionID, req)
	}

	resp := s.dispatch(ctx, req)
	return s.marshalSingleResponse(resp, sessionID, false)
}

func (s *Server) handleToolsCallStream(ctx context.Context, sessionID string, req *Request) (*apptheory.Response, error) {
	if s.streamStore == nil {
		resp := NewErrorResponse(req.ID, CodeInternalError, "streaming not supported")
		return s.marshalSingleResponse(resp, sessionID, false)
	}

	streamID, err := s.streamStore.Create(ctx, sessionID)
	if err != nil {
		s.logger.ErrorContext(ctx, "stream store error", "error", err)
		return internalServerError(), nil
	}

	// Run the tool out-of-band so disconnects do not cancel execution.
	toolCtx := context.WithoutCancel(ctx)
	go s.runStreamingTool(toolCtx, sessionID, streamID, req)

	events, err := s.streamStore.Subscribe(ctx, sessionID, streamID, "")
	if err != nil {
		s.logger.ErrorContext(ctx, "stream store error", "error", err)
		return internalServerError(), nil
	}

	return s.streamToSSE(ctx, sessionID, events)
}

func (s *Server) runStreamingTool(ctx context.Context, sessionID, streamID string, req *Request) {
	defer func() {
		if err := s.streamStore.Close(ctx, sessionID, streamID); err != nil {
			s.logger.ErrorContext(ctx, "stream store close error", "sessionId", sessionID, "streamId", streamID, "error", err)
		}
	}()

	var params toolsCallParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		resp := NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
		if appendErr := s.appendStreamResponse(ctx, sessionID, streamID, resp); appendErr != nil {
			s.logger.ErrorContext(ctx, "stream store append error", "sessionId", sessionID, "streamId", streamID, "error", appendErr)
		}
		return
	}
	if params.Name == "" {
		if err := s.appendStreamResponse(ctx, sessionID, streamID, NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing tool name")); err != nil {
			s.logger.ErrorContext(ctx, "stream store append error", "sessionId", sessionID, "streamId", streamID, "error", err)
		}
		return
	}

	progressToken := strings.TrimSpace(params.Meta.ProgressToken)
	progressSeq := 0.0

	emit := func(ev SSEEvent) {
		if progressToken == "" {
			return
		}

		progressSeq++
		progress, total, message := progressFromSSEEvent(ev, progressSeq)

		notification := Request{
			JSONRPC: jsonrpcVersion,
			Method:  "notifications/progress",
			Params:  mustMarshalJSON(map[string]any{"progressToken": progressToken, "progress": progress, "total": total, "message": message}),
		}

		notificationBytes, err := json.Marshal(notification)
		if err != nil {
			return
		}
		if _, err := s.streamStore.Append(ctx, sessionID, streamID, notificationBytes); err != nil {
			s.logger.ErrorContext(ctx, "stream store append error", "sessionId", sessionID, "streamId", streamID, "error", err)
		}
	}

	result, err := s.registry.CallStreaming(ctx, params.Name, params.Arguments, emit)

	var finalResp *Response
	if err != nil {
		finalResp = s.toolCallError(ctx, req.ID, params.Name, err)
	} else {
		finalResp = NewResultResponse(req.ID, result)
	}

	if err := s.appendStreamResponse(ctx, sessionID, streamID, finalResp); err != nil {
		s.logger.ErrorContext(ctx, "stream store append error", "sessionId", sessionID, "streamId", streamID, "error", err)
	}
}

func progressFromSSEEvent(ev SSEEvent, fallbackProgress float64) (progress float64, total any, message string) {
	switch v := ev.Data.(type) {
	case nil:
		return fallbackProgress, nil, ""
	case string:
		return fallbackProgress, nil, v
	case map[string]any:
		var ok bool
		if progress, ok = floatFromAny(v["progress"]); !ok {
			if progress, ok = floatFromAny(v["seq"]); !ok {
				progress = fallbackProgress
			}
		}
		if t, has := v["total"]; has {
			total = t
		}
		if msg, has := v["message"]; has {
			if s, ok := msg.(string); ok {
				message = s
			}
		}
		return progress, total, message
	default:
		return fallbackProgress, nil, fmt.Sprint(v)
	}
}

func floatFromAny(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case int32:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

func mustMarshalJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func (s *Server) appendStreamResponse(ctx context.Context, sessionID, streamID string, resp *Response) error {
	b, err := MarshalResponse(resp)
	if err != nil {
		return err
	}
	_, err = s.streamStore.Append(ctx, sessionID, streamID, b)
	return err
}

func (s *Server) streamToSSE(ctx context.Context, sessionID string, events <-chan StreamEvent) (*apptheory.Response, error) {
	out := make(chan apptheory.SSEEvent)

	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-events:
				if !ok {
					return
				}
				select {
				case <-ctx.Done():
					return
				case out <- apptheory.SSEEvent{
					ID:    ev.ID,
					Event: "message",
					Data:  ev.Data,
				}:
				}
			}
		}
	}()

	resp, err := apptheory.SSEStreamResponse(ctx, 200, out)
	if err != nil {
		return nil, err
	}
	if resp.Headers == nil {
		resp.Headers = map[string][]string{}
	}
	resp.Headers[headerMcpSessionID] = []string{sessionID}
	return resp, nil
}

func badRequest(msg string) *apptheory.Response {
	return &apptheory.Response{
		Status: 400,
		Headers: map[string][]string{
			"content-type": {"application/json"},
		},
		Body: []byte(fmt.Sprintf(`{"error":%q}`, msg)),
	}
}

func notFound(msg string) *apptheory.Response {
	return &apptheory.Response{
		Status: 404,
		Headers: map[string][]string{
			"content-type": {"application/json"},
		},
		Body: []byte(fmt.Sprintf(`{"error":%q}`, msg)),
	}
}

func internalServerError() *apptheory.Response {
	return &apptheory.Response{
		Status: 500,
		Headers: map[string][]string{
			"content-type": {"application/json"},
		},
		Body: []byte(`{"error":"internal server error"}`),
	}
}
