package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// WebSocket API server.
//
// A WebSocket API is served on its own listener. The upgrade request runs the
// $connect authorizer and the $connect integration before the handshake
// completes, so a refusal is an HTTP 401/403/5xx the client sees instead of an
// established connection:
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-keys-connect-disconnect.html
//
// After the upgrade every text frame is routed by the API's route selection
// expression; a message that does not evaluate to a route key goes to
// $default. The $default and custom routes are two-way: an integration response
// body is sent back to the client. $connect and $disconnect are one-way.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-develop-routes.html

const (
	// webSocketIdleTimeout is API Gateway's idle connection quota.
	webSocketIdleTimeout = 10 * time.Minute
	// webSocketMaxConnectionDuration is API Gateway's maximum connection
	// lifetime. API Gateway closes an idle or expired connection with 1001.
	webSocketMaxConnectionDuration = 2 * time.Hour
	// webSocketDisconnectInternal is the documented disconnectReason for a close
	// the server initiates.
	webSocketDisconnectInternal = "INTERNAL_ERROR"
	// webSocketDisconnectClient is the documented disconnectReason for a close
	// the client initiates.
	webSocketDisconnectClient = "CLIENT_INITIATED_DISCONNECT"
)

// WebSocketServer serves one WebSocket API.
type WebSocketServer struct {
	API        WebSocketAPISpec
	Invokers   map[string]Invoker
	Clock      Clock
	Semaphore  chan struct{}
	Management *webSocketManagement
	Logf       func(format string, args ...any)
	Now        func() time.Time
	// DomainName is the host:port the event reports in requestContext; it is
	// the management endpoint, so a handler that builds the management client
	// from the request context reaches the local endpoint.
	DomainName string

	// surfaceMu guards the route table and invoker set a watch reload swaps.
	surfaceMu sync.RWMutex
}

// currentAPI returns the WebSocket API the server routes now.
func (s *WebSocketServer) currentAPI() WebSocketAPISpec {
	s.surfaceMu.RLock()
	defer s.surfaceMu.RUnlock()
	return s.API
}

// invoker returns the running process for one function.
func (s *WebSocketServer) invoker(id string) (Invoker, bool) {
	s.surfaceMu.RLock()
	defer s.surfaceMu.RUnlock()
	invoker, ok := s.Invokers[id]
	return invoker, ok
}

// SetSurface swaps the route table and invoker set after a watch reload.
func (s *WebSocketServer) SetSurface(api WebSocketAPISpec, invokers map[string]Invoker) {
	s.surfaceMu.Lock()
	defer s.surfaceMu.Unlock()
	s.API = api
	s.Invokers = invokers
}

// webSocketConnection is one live connection.
type webSocketConnection struct {
	id           string
	apiID        string
	stage        string
	connectedAt  time.Time
	lastActiveAt time.Time
	sourceIP     string
	userAgent    string
	conn         *wsConn
	// authorizerContext is the context the $connect authorizer returned.
	authorizerContext map[string]any
	// closeRequested is closed by the @connections DeleteConnection call.
	closeRequested chan struct{}
	closeOnce      sync.Once
}

func (c *webSocketConnection) requestClose() {
	c.closeOnce.Do(func() { close(c.closeRequested) })
}

// ServeHTTP upgrades the connection and serves it until it closes.
//
//nolint:gocyclo // the handshake, authorization and routing are explicit steps.
func (s *WebSocketServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	accept, err := webSocketHandshake(request)
	if err != nil {
		s.logf("websocket %s: upgrade refused: %v", s.currentAPI().LogicalID, err)
		writer.Header().Set("Sec-WebSocket-Version", "13")
		http.Error(writer, "Bad Request", http.StatusBadRequest)
		return
	}
	now := s.now()
	connection := &webSocketConnection{
		id:             NewRequestID(),
		apiID:          s.currentAPI().APIID,
		stage:          s.currentAPI().Stage,
		connectedAt:    now,
		lastActiveAt:   now,
		sourceIP:       sourceIP(request.RemoteAddr),
		userAgent:      request.Header.Get("User-Agent"),
		closeRequested: make(chan struct{}),
	}

	if s.currentAPI().Authorizer != nil {
		context, status, authorizeErr := s.authorize(request, connection)
		if authorizeErr != nil {
			s.logf("websocket %s: $connect authorizer failed: %v", s.currentAPI().LogicalID, authorizeErr)
			http.Error(writer, "Internal Server Error", http.StatusInternalServerError)
			return
		}
		if status != 0 {
			s.logf("websocket %s: $connect refused with %d by the authorizer", s.currentAPI().LogicalID, status)
			http.Error(writer, http.StatusText(status), status)
			return
		}
		connection.authorizerContext = context
	}

	if route, ok := s.currentAPI().Route(webSocketConnect); ok {
		event := s.buildEvent(connection, webSocketConnect, "CONNECT", "", nil, false, "")
		response, invokeErr := s.invoke(request.Context(), route.Function, event)
		if invokeErr != nil {
			s.logf("websocket %s: $connect integration failed: %v", s.currentAPI().LogicalID, invokeErr)
			http.Error(writer, "Internal Server Error", http.StatusInternalServerError)
			return
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			s.logf("websocket %s: $connect returned %d; the connection is not established", s.currentAPI().LogicalID, response.StatusCode)
			http.Error(writer, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
			return
		}
	}

	// Register the idle and lifetime timers before the upgrade response reaches
	// the client. A deterministic clock advanced as soon as the handshake is
	// observed must not be able to outrun the timer registration.
	idle := s.clock().After(webSocketIdleTimeout)
	lifetime := s.clock().After(webSocketMaxConnectionDuration)

	conn, buffered, err := hijackUpgrade(writer, request, accept)
	if err != nil {
		s.logf("websocket %s: upgrade failed: %v", s.currentAPI().LogicalID, err)
		return
	}
	connection.conn = newWSConn(conn, buffered)
	if s.Management != nil {
		s.Management.register(connection)
	}
	defer func() {
		if s.Management != nil {
			s.Management.unregister(connection.id)
		}
	}()
	s.logf("websocket %s: connection %s established", s.currentAPI().LogicalID, connection.id)

	reason, code := s.serveConnection(request.Context(), connection, idle, lifetime)
	if err := connection.conn.closeWithCode(code, reason); err != nil {
		_ = err // the peer may already have closed the transport
	}
	if route, ok := s.currentAPI().Route(webSocketDisconnect); ok {
		event := s.buildEvent(connection, webSocketDisconnect, "DISCONNECT", "", nil, false, reason)
		if _, err := s.invoke(context.Background(), route.Function, event); err != nil {
			s.logf("websocket %s: $disconnect integration failed: %v", s.currentAPI().LogicalID, err)
		}
	}
	s.logf("websocket %s: connection %s closed (%s)", s.currentAPI().LogicalID, connection.id, reason)
}

// serveConnection reads frames until the client closes, the idle or lifetime
// timer fires, or the management API deletes the connection. It returns the
// documented disconnectReason. The callers register both timers before the
// upgrade completes so a client can never act on the handshake before they
// exist.
func (s *WebSocketServer) serveConnection(ctx context.Context, connection *webSocketConnection, idle, lifetime <-chan time.Time) (string, int) {
	type frameResult struct {
		opcode  byte
		payload []byte
		err     error
	}
	frames := make(chan frameResult, 1)
	go func() {
		for {
			opcode, payload, err := connection.conn.readMessage()
			select {
			case frames <- frameResult{opcode: opcode, payload: payload, err: err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return webSocketDisconnectInternal, wsCloseGoingAway
		case <-connection.closeRequested:
			return webSocketDisconnectInternal, wsCloseGoingAway
		case <-idle:
			s.logf("websocket %s: connection %s idle for %s", s.currentAPI().LogicalID, connection.id, webSocketIdleTimeout)
			return webSocketDisconnectInternal, wsCloseGoingAway
		case <-lifetime:
			s.logf("websocket %s: connection %s reached the %s lifetime", s.currentAPI().LogicalID, connection.id, webSocketMaxConnectionDuration)
			return webSocketDisconnectInternal, wsCloseGoingAway
		case frame := <-frames:
			if frame.err != nil {
				return s.frameErrorResult(connection, frame.opcode, frame.err)
			}
			if frame.opcode == wsOpcodeClose {
				return webSocketDisconnectClient, wsCloseNormal
			}
			if frame.opcode == wsOpcodeBinary {
				s.logf("websocket %s: connection %s sent a binary frame; binary media types are not supported", s.currentAPI().LogicalID, connection.id)
				return webSocketDisconnectInternal, wsCloseUnsupportedData
			}
			connection.lastActiveAt = s.now()
			idle = s.clock().After(webSocketIdleTimeout)
			s.routeMessage(ctx, connection, string(frame.payload))
		}
	}
}

// frameErrorResult maps a read error to the documented disconnectReason and
// close code. A close frame is a client close; an oversize frame or message is
// 1009; every other read failure is an internal error (1011).
func (s *WebSocketServer) frameErrorResult(connection *webSocketConnection, opcode byte, err error) (string, int) {
	if opcode == wsOpcodeClose {
		return webSocketDisconnectClient, wsCloseNormal
	}
	if errors.Is(err, errWebSocketTooBig) {
		s.logf("websocket %s: connection %s sent a frame or message over the documented limit", s.currentAPI().LogicalID, connection.id)
		return webSocketDisconnectInternal, wsCloseTooBig
	}
	return webSocketDisconnectInternal, wsCloseInternalError
}

// routeMessage selects a route for one text message and invokes it.
func (s *WebSocketServer) routeMessage(ctx context.Context, connection *webSocketConnection, body string) {
	routeKey := s.selectRoute(body)
	route, ok := s.currentAPI().Route(routeKey)
	if !ok && routeKey != webSocketDefault {
		routeKey = webSocketDefault
		route, ok = s.currentAPI().Route(webSocketDefault)
	}
	if !ok {
		s.logf("websocket %s: message has no route (selected %q) and the API declares no $default", s.currentAPI().LogicalID, routeKey)
		return
	}
	messageID := NewRequestID()
	event := s.buildEvent(connection, route.RouteKey, "MESSAGE", messageID, []byte(body), false, "")
	response, err := s.invoke(ctx, route.Function, event)
	if err != nil {
		s.logf("websocket %s: route %s integration failed: %v", s.currentAPI().LogicalID, route.RouteKey, err)
		return
	}
	if !route.TwoWay || response.StatusCode < 200 || response.StatusCode >= 300 || len(response.Body) == 0 {
		return
	}
	if err := connection.conn.writeFrame(wsOpcodeText, response.Body); err != nil {
		s.logf("websocket %s: writing the route response failed: %v", s.currentAPI().LogicalID, err)
	}
}

// selectRoute evaluates the API's route selection expression against the
// message. The single-field $request.body.<field> form and its wrapped
// ${request.body.<field>} equivalent are supported; a form the runner does not
// implement was refused at derive time, and here it, a non-JSON message and a
// missing field all select $default.
func (s *WebSocketServer) selectRoute(body string) string {
	expression := strings.TrimSpace(s.currentAPI().RouteSelectionExpression)
	if expression == "" {
		expression = defaultWebSocketRouteSelectionExpression
	}
	field, ok := webSocketRouteSelectionField(expression)
	if !ok {
		return webSocketDefault
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(body), &document); err != nil {
		return webSocketDefault
	}
	value, ok := document[field].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return webSocketDefault
	}
	return value
}

// buildEvent builds the documented WebSocket proxy event.
func (s *WebSocketServer) buildEvent(
	connection *webSocketConnection,
	routeKey, eventType, messageID string,
	body []byte,
	isBase64 bool,
	disconnectReason string,
) []byte {
	encoded := ""
	if len(body) > 0 {
		encoded = string(body)
	}
	requestContext := map[string]any{
		"routeKey":          routeKey,
		"eventType":         eventType,
		"extendedRequestId": NewRequestID(),
		"requestTime":       s.now().UTC().Format("02/Jan/2006:15:04:05 -0700"),
		"messageDirection":  "IN",
		"stage":             s.currentAPI().Stage,
		"connectedAt":       connection.connectedAt.UnixMilli(),
		"requestTimeEpoch":  s.now().UnixMilli(),
		"identity": map[string]any{
			"sourceIp":  connection.sourceIP,
			"userAgent": connection.userAgent,
		},
		"requestId":    NewRequestID(),
		"domainName":   s.DomainName,
		"connectionId": connection.id,
		"apiId":        s.currentAPI().APIID,
	}
	if messageID != "" {
		requestContext["messageId"] = messageID
	}
	if disconnectReason != "" {
		requestContext["disconnectReason"] = disconnectReason
	}
	if len(connection.authorizerContext) > 0 {
		requestContext["authorizer"] = connection.authorizerContext
	}
	event := map[string]any{
		"requestContext":  requestContext,
		"body":            encoded,
		"isBase64Encoded": isBase64,
	}
	encodedEvent, err := json.Marshal(event)
	if err != nil {
		return []byte(`{"requestContext":{},"body":"","isBase64Encoded":false}`)
	}
	return encodedEvent
}

// authorize invokes the $connect authorizer and matches its policy against the
// $connect method ARN. A missing identity source, a malformed response and a
// Deny all refuse the connection; the status is 401 for a missing identity
// source or a Deny and 0 when the request may connect.
func (s *WebSocketServer) authorize(request *http.Request, connection *webSocketConnection) (map[string]any, int, error) {
	authorizer := s.currentAPI().Authorizer
	missing, err := missingIdentitySource(request.Header, request.URL.RawQuery, authorizer.IdentitySources)
	if err != nil {
		return nil, 0, err
	}
	if missing != "" {
		s.logf("websocket %s: identity source %s is missing; the authorizer was not invoked", s.currentAPI().LogicalID, missing)
		return nil, http.StatusUnauthorized, nil
	}
	event := s.buildAuthorizerEvent(request, connection)
	// A Lambda authorizer returns a policy document, not a proxy response, so
	// the raw invocation result is decoded directly.
	raw, err := s.invokeRaw(request.Context(), authorizer.Function, event)
	if err != nil {
		return nil, 0, err
	}
	decision, context, err := evaluateAuthorizerPolicy(raw, authorizer.MethodARN)
	if err != nil {
		s.logf("websocket %s: the authorizer returned no usable policy: %v", s.currentAPI().LogicalID, err)
		return nil, http.StatusUnauthorized, nil
	}
	if !decision {
		return nil, http.StatusUnauthorized, nil
	}
	return context, 0, nil
}

// buildAuthorizerEvent builds the documented WebSocket REQUEST authorizer event.
func (s *WebSocketServer) buildAuthorizerEvent(request *http.Request, connection *webSocketConnection) []byte {
	headers := map[string]string{}
	multi := map[string][]string{}
	for name, values := range request.Header {
		lower := strings.ToLower(name)
		multi[lower] = append([]string(nil), values...)
		if len(values) > 0 {
			headers[lower] = values[0]
		}
	}
	query := map[string]string{}
	multiQuery := map[string][]string{}
	for name, values := range request.URL.Query() {
		multiQuery[name] = append([]string(nil), values...)
		if len(values) > 0 {
			query[name] = values[0]
		}
	}
	event := map[string]any{
		"type":                            "REQUEST",
		"methodArn":                       s.currentAPI().Authorizer.MethodARN,
		"headers":                         headers,
		"multiValueHeaders":               multi,
		"queryStringParameters":           query,
		"multiValueQueryStringParameters": multiQuery,
		"stageVariables":                  map[string]any{},
		"requestContext": map[string]any{
			"routeKey":          webSocketConnect,
			"eventType":         "CONNECT",
			"extendedRequestId": NewRequestID(),
			"requestTime":       s.now().UTC().Format("02/Jan/2006:15:04:05 -0700"),
			"messageDirection":  "IN",
			"stage":             s.currentAPI().Stage,
			"connectedAt":       connection.connectedAt.UnixMilli(),
			"requestTimeEpoch":  s.now().UnixMilli(),
			"identity":          map[string]any{"sourceIp": connection.sourceIP},
			"requestId":         NewRequestID(),
			"domainName":        s.DomainName,
			"connectionId":      connection.id,
			"apiId":             s.currentAPI().APIID,
		},
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return []byte(`{"type":"REQUEST","methodArn":""}`)
	}
	return encoded
}

// invoke sends one event to a function container under the shared concurrency
// bound.
func (s *WebSocketServer) invoke(ctx context.Context, function string, event []byte) (LambdaResponse, error) {
	invoker, ok := s.invoker(function)
	if !ok {
		return LambdaResponse{}, fmt.Errorf("no running container for function %s", function)
	}
	if s.Semaphore != nil {
		select {
		case s.Semaphore <- struct{}{}:
		case <-ctx.Done():
			return LambdaResponse{}, ctx.Err()
		}
		defer func() { <-s.Semaphore }()
	}
	raw, err := invoker.Invoke(ctx, event)
	if err != nil {
		return LambdaResponse{}, err
	}
	return DecodeResponse(raw)
}

// invokeRaw sends one event and returns the function's raw result.
func (s *WebSocketServer) invokeRaw(ctx context.Context, function string, event []byte) ([]byte, error) {
	invoker, ok := s.invoker(function)
	if !ok {
		return nil, fmt.Errorf("no running container for function %s", function)
	}
	if s.Semaphore != nil {
		select {
		case s.Semaphore <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		defer func() { <-s.Semaphore }()
	}
	return invoker.Invoke(ctx, event)
}

// clock returns the run clock, defaulting to the wall clock when a server was
// built without one (unit tests that never serve a connection).
func (s *WebSocketServer) clock() Clock {
	if s.Clock != nil {
		return s.Clock
	}
	return RealClock{}
}

func (s *WebSocketServer) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	if s.Clock != nil {
		return s.Clock.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *WebSocketServer) logf(format string, args ...any) {
	if s.Logf != nil {
		s.Logf(format, args...)
	}
}
