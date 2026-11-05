package localrunner

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// recordingWebSocketInvoker records every event a route receives and answers
// with a configured response.
type recordingWebSocketInvoker struct {
	mu       sync.Mutex
	events   []map[string]any
	function []string
	respond  func(event map[string]any) LambdaResponse
}

func (i *recordingWebSocketInvoker) Invoke(_ context.Context, payload []byte) ([]byte, error) {
	var event map[string]any
	if err := json.Unmarshal(payload, &event); err != nil {
		return nil, err
	}
	i.mu.Lock()
	i.events = append(i.events, event)
	i.function = append(i.function, eventFunctionOf(event))
	i.mu.Unlock()
	if i.respond == nil {
		return encodeTestLambdaResponse(200, "")
	}
	response := i.respond(event)
	return encodeTestLambdaResponse(response.StatusCode, string(response.Body))
}

// eventFunctionOf is set by the test through the invoker map key; the event
// itself carries no function name, so the test records the route key instead.
func eventFunctionOf(event map[string]any) string {
	if requestContext, ok := event["requestContext"].(map[string]any); ok {
		if routeKey, ok := requestContext["routeKey"].(string); ok {
			return routeKey
		}
	}
	return ""
}

func encodeTestLambdaResponse(status int, body string) ([]byte, error) {
	return json.Marshal(map[string]any{
		"statusCode": status,
		"headers":    map[string]string{"content-type": "application/json"},
		"body":       body,
	})
}

func (i *recordingWebSocketInvoker) recorded() []map[string]any {
	i.mu.Lock()
	defer i.mu.Unlock()
	return append([]map[string]any(nil), i.events...)
}

// testWebSocketAPI is a WebSocket API with the three predefined routes and one
// custom route.
func testWebSocketAPI() WebSocketAPISpec {
	return WebSocketAPISpec{
		Class:                    APIWebSocket,
		LogicalID:                "WsApi",
		Stack:                    "Stack",
		Name:                     "demo",
		Stage:                    "dev",
		RouteSelectionExpression: "$request.body.action",
		APIID:                    "localwsapi",
		Routes: []WebSocketRouteSpec{
			{RouteKey: webSocketConnect, Function: "Fn"},
			{RouteKey: webSocketDisconnect, Function: "Fn"},
			{RouteKey: webSocketDefault, Function: "Fn", TwoWay: true},
			{RouteKey: "chat", Function: "Fn", TwoWay: true},
		},
	}
}

// dialTestWebSocket performs the RFC 6455 handshake against a test server.
func dialTestWebSocket(t *testing.T, serverURL string, header http.Header, query string) (net.Conn, *bufio.Reader) {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	var dialer net.Dialer
	conn, err := dialer.DialContext(context.Background(), "tcp", parsed.Host)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	path := parsed.Path
	if path == "" {
		path = "/"
	}
	if query != "" {
		path += "?" + query
	}
	key := "dGhlIHNhbXBsZSBub25jZQ=="
	request := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + parsed.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n"
	for name, values := range header {
		for _, value := range values {
			request += name + ": " + value + "\r\n"
		}
	}
	request += "\r\n"
	if _, writeErr := conn.Write([]byte(request)); writeErr != nil {
		t.Fatalf("write handshake: %v", writeErr)
	}
	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read handshake status: %v", err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("handshake status = %q", strings.TrimSpace(status))
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read handshake header: %v", err)
		}
		if line == "\r\n" {
			break
		}
	}
	return conn, reader
}

func writeClientFrame(t *testing.T, conn net.Conn, opcode byte, payload []byte) {
	t.Helper()
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		t.Fatalf("mask: %v", err)
	}
	header := []byte{0x80 | opcode}
	switch {
	case len(payload) < 126:
		header = append(header, 0x80|byte(len(payload))) //nolint:gosec // bounded above
	case len(payload) <= 0xFFFF:
		header = append(header, 0x80|126, 0, 0)
		binary.BigEndian.PutUint16(header[len(header)-2:], uint16(len(payload))) //nolint:gosec // bounded above
	default:
		header = append(header, 0x80|127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(header[len(header)-8:], uint64(len(payload)))
	}
	masked := make([]byte, len(payload))
	for index := range payload {
		masked[index] = payload[index] ^ mask[index%4]
	}
	if _, err := conn.Write(append(header, mask[:]...)); err != nil {
		t.Fatalf("write frame header: %v", err)
	}
	if _, err := conn.Write(masked); err != nil {
		t.Fatalf("write frame payload: %v", err)
	}
}

// readServerFrame reads one unmasked server frame.
func readServerFrame(t *testing.T, reader *bufio.Reader) (byte, []byte) {
	t.Helper()
	var header [2]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		t.Fatalf("read frame header: %v", err)
	}
	opcode := header[0] & 0x0F
	length := int(header[1] & 0x7F)
	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(reader, extended[:]); err != nil {
			t.Fatalf("read extended length: %v", err)
		}
		length = int(binary.BigEndian.Uint16(extended[:]))
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(reader, extended[:]); err != nil {
			t.Fatalf("read extended length: %v", err)
		}
		length = int(binary.BigEndian.Uint64(extended[:])) //nolint:gosec // a test client frame
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		t.Fatalf("read frame payload: %v", err)
	}
	return opcode, payload
}

// eventContext returns an event's requestContext, failing the test otherwise.
func eventContext(t *testing.T, event map[string]any) map[string]any {
	t.Helper()
	context, ok := event["requestContext"].(map[string]any)
	require.True(t, ok, "event has no requestContext: %v", event)
	return context
}

func TestWebSocketSelectRoute(t *testing.T) {
	server := &WebSocketServer{API: testWebSocketAPI()}
	cases := map[string]string{
		`{"action":"chat"}`:    "chat",
		`{"action":"unknown"}`: "unknown",
		`{"other":"chat"}`:     webSocketDefault,
		`not-json`:             webSocketDefault,
		`{"action":42}`:        webSocketDefault,
		`{"action":""}`:        webSocketDefault,
	}
	for body, want := range cases {
		if got := server.selectRoute(body); got != want {
			t.Fatalf("%s selected %q, want %q", body, got, want)
		}
	}
	wrapped := &WebSocketServer{API: testWebSocketAPI()}
	wrapped.API.RouteSelectionExpression = "${request.body.action}"
	if got := wrapped.selectRoute(`{"action":"chat"}`); got != "chat" {
		t.Fatalf("the wrapped expression selected %q, want chat", got)
	}
	undefined := &WebSocketServer{API: WebSocketAPISpec{RouteSelectionExpression: "$context.foo"}}
	if got := undefined.selectRoute(`{"action":"chat"}`); got != webSocketDefault {
		t.Fatalf("an unsupported expression selected %q", got)
	}
	multi := &WebSocketServer{API: WebSocketAPISpec{
		RouteSelectionExpression: "${request.body.service}/${request.body.action}",
	}}
	if got := multi.selectRoute(`{"service":"chat","action":"join"}`); got != webSocketDefault {
		t.Fatalf("a multi-variable expression selected %q", got)
	}
}

func TestEvaluateAuthorizerPolicy(t *testing.T) {
	methodARN := "arn:aws:execute-api:us-east-1:123456789012:localwsapi/dev/$connect"
	allow := `{"principalId":"user","policyDocument":{"Version":"2012-10-17","Statement":[` +
		`{"Action":"execute-api:Invoke","Effect":"Allow","Resource":"arn:aws:execute-api:us-east-1:123456789012:localwsapi/dev/*"}]},` +
		`"context":{"tenant":"demo"}}`
	allowed, context, err := evaluateAuthorizerPolicy([]byte(allow), methodARN)
	if err != nil || !allowed || context["tenant"] != "demo" {
		t.Fatalf("allow policy = %t %v %v", allowed, context, err)
	}
	deny := `{"principalId":"user","policyDocument":{"Statement":[{"Action":"execute-api:Invoke","Effect":"Deny","Resource":"*"}]}}`
	denied, _, denyErr := evaluateAuthorizerPolicy([]byte(deny), methodARN)
	require.NoError(t, denyErr)
	require.False(t, denied, "a Deny policy must refuse")
	wrongResource := `{"principalId":"user","policyDocument":{"Statement":[{"Action":"execute-api:Invoke","Effect":"Allow","Resource":"arn:aws:execute-api:us-east-1:123456789012:other/dev/$connect"}]}}`
	otherAllowed, _, otherErr := evaluateAuthorizerPolicy([]byte(wrongResource), methodARN)
	require.NoError(t, otherErr)
	require.False(t, otherAllowed, "a policy for another API must refuse")
	malformedAllowed, _, malformedErr := evaluateAuthorizerPolicy([]byte(`not-json`), methodARN)
	require.Error(t, malformedErr)
	require.False(t, malformedAllowed, "a malformed policy must refuse")
	if !wildcardMatch("arn:aws:execute-api:*:*:*", methodARN) {
		t.Fatal("wildcards must match the method ARN")
	}
	if wildcardMatch("arn:aws:execute-api:us-east-1:123456789012:localwsapi/prod/*", methodARN) {
		t.Fatal("a different stage must not match")
	}
}

func TestWebSocketConnectionLifecycle(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	invoker := &recordingWebSocketInvoker{respond: func(event map[string]any) LambdaResponse {
		requestContext := eventContext(t, event)
		if requestContext["eventType"] == "MESSAGE" && requestContext["routeKey"] == "chat" {
			return LambdaResponse{StatusCode: 200, Body: []byte(`{"route":"chat"}`)}
		}
		return LambdaResponse{StatusCode: 200, Body: []byte(`{"ok":true}`)}
	}}
	management, err := newWebSocketManagement(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("management: %v", err)
	}
	server := &WebSocketServer{
		API:        testWebSocketAPI(),
		Invokers:   map[string]Invoker{"Fn": invoker},
		Clock:      clock,
		Management: management,
		DomainName: "host.docker.internal:9999",
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()

	conn, reader := dialTestWebSocket(t, httpServer.URL, http.Header{"Authorization": {"Bearer good"}}, "")
	defer func() { require.NoError(t, conn.Close()) }()

	// The $connect event carries the documented fields.
	deadline := time.Now().Add(2 * time.Second)
	var connect map[string]any
	for time.Now().Before(deadline) {
		recorded := invoker.recorded()
		if len(recorded) > 0 && eventContext(t, recorded[0])["eventType"] == "CONNECT" {
			connect = recorded[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if connect == nil {
		t.Fatalf("no $connect event: %+v", invoker.recorded())
	}
	requestContext := eventContext(t, connect)
	for _, field := range []string{"connectionId", "routeKey", "eventType", "messageId",
		"domainName", "stage", "connectedAt", "requestId", "apiId", "extendedRequestId"} {
		if field == "messageId" {
			continue // a $connect event has no message id
		}
		if _, ok := requestContext[field]; !ok {
			t.Fatalf("$connect requestContext has no %s: %v", field, requestContext)
		}
	}
	if requestContext["routeKey"] != webSocketConnect || requestContext["domainName"] != "host.docker.internal:9999" ||
		requestContext["stage"] != "dev" {
		t.Fatalf("$connect requestContext = %v", requestContext)
	}
	if _, ok := connect["body"]; !ok {
		t.Fatalf("the event must carry a body field: %v", connect)
	}

	// A message that selects the custom route gets the two-way response.
	writeClientFrame(t, conn, wsOpcodeText, []byte(`{"action":"chat"}`))
	opcode, payload := readServerFrame(t, reader)
	if opcode != wsOpcodeText || string(payload) != `{"route":"chat"}` {
		t.Fatalf("two-way response = %d %q", opcode, payload)
	}
	// A message with no matching route goes to $default, which also answers.
	writeClientFrame(t, conn, wsOpcodeText, []byte(`{"action":"missing"}`))
	opcode, payload = readServerFrame(t, reader)
	if opcode != wsOpcodeText || string(payload) != `{"ok":true}` {
		t.Fatalf("$default response = %d %q", opcode, payload)
	}

	// The connection is registered and GetConnection answers.
	connectionID, ok := requestContext["connectionId"].(string)
	require.True(t, ok, "the $connect event has no connection id: %v", requestContext)
	client := &http.Client{Timeout: 5 * time.Second}
	managementServer := httptest.NewServer(management)
	defer managementServer.Close()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, managementServer.URL+"/@connections/"+connectionID, nil)
	if err != nil {
		t.Fatalf("build get request: %v", err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("get connection: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("get connection status = %d", response.StatusCode)
	}
	var connectionBody struct {
		ConnectedAt  time.Time `json:"connectedAt"`
		LastActiveAt time.Time `json:"lastActiveAt"`
	}
	if decodeErr := json.NewDecoder(response.Body).Decode(&connectionBody); decodeErr != nil {
		t.Fatalf("decode get connection: %v", decodeErr)
	}
	if connectionBody.ConnectedAt.IsZero() || connectionBody.LastActiveAt.IsZero() {
		t.Fatalf("get connection body = %+v", connectionBody)
	}
	require.NoError(t, response.Body.Close())

	// DeleteConnection closes the socket and answers 204.
	request, err = http.NewRequestWithContext(context.Background(), http.MethodDelete, managementServer.URL+"/@connections/"+connectionID, nil)
	if err != nil {
		t.Fatalf("build delete request: %v", err)
	}
	response, err = client.Do(request)
	if err != nil {
		t.Fatalf("delete connection: %v", err)
	}
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("delete connection status = %d", response.StatusCode)
	}
	require.NoError(t, response.Body.Close())

	// A closed connection is GONE.
	request, err = http.NewRequestWithContext(context.Background(), http.MethodGet, managementServer.URL+"/@connections/"+connectionID, nil)
	if err != nil {
		t.Fatalf("build get request: %v", err)
	}
	response, err = client.Do(request)
	if err != nil {
		t.Fatalf("get closed connection: %v", err)
	}
	if response.StatusCode != http.StatusGone {
		t.Fatalf("closed connection status = %d, want 410", response.StatusCode)
	}
	require.NoError(t, response.Body.Close())

	// $disconnect ran with the documented reason.
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, event := range invoker.recorded() {
			context := eventContext(t, event)
			if context["eventType"] == "DISCONNECT" {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no $disconnect event: %+v", invoker.recorded())
}

func TestWebSocketIdleTimeoutOnTheTestClock(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	invoker := &recordingWebSocketInvoker{}
	server := &WebSocketServer{
		API:      testWebSocketAPI(),
		Invokers: map[string]Invoker{"Fn": invoker},
		Clock:    clock,
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	conn, reader := dialTestWebSocket(t, httpServer.URL, nil, "")
	defer func() { require.NoError(t, conn.Close()) }()

	if _, err := clock.Advance(webSocketIdleTimeout + time.Minute); err != nil {
		t.Fatalf("advance: %v", err)
	}
	// The server closes with 1001 for an idle connection.
	opcode, payload := readServerFrame(t, reader)
	if opcode != wsOpcodeClose {
		t.Fatalf("opcode = %d, want close", opcode)
	}
	if code := closeCodeOf(payload); code != wsCloseGoingAway {
		t.Fatalf("close code = %d, want 1001", code)
	}
}

func TestWebSocketOversizeFrameClosesWith1009(t *testing.T) {
	invoker := &recordingWebSocketInvoker{}
	server := &WebSocketServer{
		API:      testWebSocketAPI(),
		Invokers: map[string]Invoker{"Fn": invoker},
		Clock:    RealClock{},
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	conn, reader := dialTestWebSocket(t, httpServer.URL, nil, "")
	defer func() { require.NoError(t, conn.Close()) }()

	// One byte over API Gateway's 32 KB frame quota returns the documented 1009,
	// not 1011.
	writeClientFrame(t, conn, wsOpcodeText, make([]byte, maxWebSocketFrameBytes+1))
	opcode, payload := readServerFrame(t, reader)
	if opcode != wsOpcodeClose {
		t.Fatalf("opcode = %d, want close", opcode)
	}
	if code := closeCodeOf(payload); code != wsCloseTooBig {
		t.Fatalf("close code = %d, want 1009", code)
	}
}

func TestWebSocketConnectAuthorizerRefusal(t *testing.T) {
	invoker := &recordingWebSocketInvoker{respond: func(map[string]any) LambdaResponse {
		return LambdaResponse{StatusCode: 200, Body: []byte(`{"policyDocument":{"Statement":[{"Action":"execute-api:Invoke","Effect":"Deny","Resource":"*"}]}}`)}
	}}
	api := testWebSocketAPI()
	api.Authorizer = &WebSocketAuthorizerSpec{
		Function:        "Fn",
		IdentitySources: []string{"$request.header.Authorization"},
		MethodARN:       "arn:aws:execute-api:us-east-1:123456789012:localwsapi/dev/$connect",
	}
	server := &WebSocketServer{API: api, Invokers: map[string]Invoker{"Fn": invoker}, Clock: RealClock{}}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()

	// A missing identity source is refused before the authorizer runs.
	var dialer net.Dialer
	conn, err := dialer.DialContext(context.Background(), "tcp", strings.TrimPrefix(httpServer.URL, "http://"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if _, writeErr := conn.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")); writeErr != nil {
		t.Fatalf("write handshake: %v", writeErr)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	defer func() { require.NoError(t, response.Body.Close()) }()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing identity source status = %d", response.StatusCode)
	}
	require.NoError(t, conn.Close())

	// A Deny policy is refused with 401.
	denied := func() int {
		var dialer net.Dialer
		conn, err := dialer.DialContext(context.Background(), "tcp", strings.TrimPrefix(httpServer.URL, "http://"))
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer func() { require.NoError(t, conn.Close()) }()
		if _, writeErr := conn.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer good\r\n\r\n")); writeErr != nil {
			t.Fatalf("write handshake: %v", writeErr)
		}
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("read response: %v", err)
		}
		defer func() { require.NoError(t, response.Body.Close()) }()
		return response.StatusCode
	}()
	if denied != http.StatusUnauthorized {
		t.Fatalf("denied status = %d", denied)
	}
	if len(invoker.recorded()) != 1 {
		t.Fatalf("the $connect integration must not run after a denial: %+v", invoker.recorded())
	}
}

func TestManagementConnectionIDPath(t *testing.T) {
	cases := map[string]string{
		"/@connections/abc":       "abc",
		"/dev/@connections/abc":   "abc",
		"@connections/abc":        "abc",
		"/@connections/abc/extra": "",
		"/abc":                    "",
		"/":                       "",
		"/@connections":           "",
	}
	for path, want := range cases {
		got, ok := managementConnectionID(path)
		if want == "" {
			if ok {
				t.Fatalf("%s parsed as %q", path, got)
			}
			continue
		}
		if !ok || got != want {
			t.Fatalf("%s = %q (%t), want %q", path, got, ok, want)
		}
	}
}

func TestWebSocketManagementGone(t *testing.T) {
	management, err := newWebSocketManagement(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("management: %v", err)
	}
	server := httptest.NewServer(management)
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		request, err := http.NewRequestWithContext(context.Background(), method, server.URL+"/@connections/missing-connection", strings.NewReader("x"))
		if err != nil {
			t.Fatalf("%s request: %v", method, err)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		if response.StatusCode != http.StatusGone {
			t.Fatalf("%s unknown connection status = %d, want 410", method, response.StatusCode)
		}
		require.NoError(t, response.Body.Close())
	}
	if _, err := newWebSocketManagement(t.TempDir(), nil); err != nil {
		t.Fatalf("management certificate: %v", err)
	}
	_ = fmt.Sprint(management.connectionCount())
}
