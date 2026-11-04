package localrunner

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// testTLSConfig trusts one PEM certificate.
func testTLSConfig(t *testing.T, certificatePEM []byte) *tls.Config {
	t.Helper()
	pool := x509.NewCertPool()
	require.True(t, pool.AppendCertsFromPEM(certificatePEM))
	return &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12} //nolint:gosec // a test client
}

func TestWebSocketHandshakeValidation(t *testing.T) {
	base := func() *http.Request {
		request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
		request.Header.Set("Connection", "Upgrade")
		request.Header.Set("Upgrade", "websocket")
		request.Header.Set("Sec-WebSocket-Version", "13")
		request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
		return request
	}
	accept, err := webSocketHandshake(base())
	require.NoError(t, err)
	require.Equal(t, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", accept)

	missing := base()
	missing.Header.Del("Connection")
	_, err = webSocketHandshake(missing)
	require.Error(t, err)

	noUpgrade := base()
	noUpgrade.Header.Set("Upgrade", "h2c")
	_, err = webSocketHandshake(noUpgrade)
	require.Error(t, err)

	badVersion := base()
	badVersion.Header.Set("Sec-WebSocket-Version", "8")
	_, err = webSocketHandshake(badVersion)
	require.Error(t, err)

	noKey := base()
	noKey.Header.Del("Sec-WebSocket-Key")
	_, err = webSocketHandshake(noKey)
	require.Error(t, err)

	tokenHeader := base()
	tokenHeader.Header.Set("Connection", "keep-alive, Upgrade")
	_, err = webSocketHandshake(tokenHeader)
	require.NoError(t, err)
}

// pipeWS builds a server conn and a client conn over a loopback TCP pair. The
// kernel buffers the writes, so a server frame and a client frame never
// deadlock on an unbuffered pipe.
func pipeWS(t *testing.T) (*wsConn, net.Conn) {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = listener.Close() }() //nolint:errcheck // test cleanup
	client, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", listener.Addr().String())
	require.NoError(t, err)
	server, err := listener.Accept()
	require.NoError(t, err)
	return newWSConn(server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server))), client
}

func writeClientsideFrame(t *testing.T, conn net.Conn, fin bool, opcode byte, payload []byte) {
	t.Helper()
	first := opcode
	if fin {
		first |= 0x80
	}
	header := []byte{first}
	length := len(payload)
	switch {
	case length < 126:
		header = append(header, 0x80|byte(length)) //nolint:gosec // a test frame
	case length <= 0xFFFF:
		header = append(header, 0x80|126, 0, 0)
		binary.BigEndian.PutUint16(header[len(header)-2:], uint16(length)) //nolint:gosec // a test frame
	default:
		header = append(header, 0x80|127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(header[len(header)-8:], uint64(length))
	}
	mask := []byte{0, 0, 0, 0}
	if _, err := conn.Write(append(header, mask...)); err != nil {
		t.Fatalf("write header: %v", err)
	}
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
}

func TestWebSocketReadMessageControlAndFragments(t *testing.T) {
	server, client := pipeWS(t)
	defer func() { _ = client.Close() }()      //nolint:errcheck // test cleanup
	defer func() { _ = server.conn.Close() }() //nolint:errcheck // test cleanup

	// A fragmented text message, a ping between the fragments, then a pong.
	writeClientsideFrame(t, client, false, wsOpcodeText, []byte("hel"))
	writeClientsideFrame(t, client, true, wsOpcodePing, []byte("p"))
	writeClientsideFrame(t, client, true, wsOpcodeContinuation, []byte("lo"))
	opcode, payload, err := server.readMessage()
	require.NoError(t, err)
	require.Equal(t, byte(wsOpcodeText), opcode)
	require.Equal(t, "hello", string(payload))
	// The server answered the ping with a pong.
	require.NoError(t, client.SetReadDeadline(time.Now().Add(5*time.Second)))
	header, err := bufio.NewReader(client).ReadByte()
	require.NoError(t, err)
	require.Equal(t, byte(0x8A), header)
}

func TestWebSocketReadMessageErrors(t *testing.T) {
	server, client := pipeWS(t)
	defer func() { _ = client.Close() }()      //nolint:errcheck // test cleanup
	defer func() { _ = server.conn.Close() }() //nolint:errcheck // test cleanup

	// A close frame is reported.
	writeClientsideFrame(t, client, true, wsOpcodeClose, []byte{0x03, 0xE8})
	opcode, _, err := server.readMessage()
	require.NoError(t, err)
	require.Equal(t, byte(wsOpcodeClose), opcode)

	// A continuation without a message fails.
	writeClientsideFrame(t, client, true, wsOpcodeContinuation, []byte("x"))
	_, _, err = server.readMessage()
	require.Error(t, err)

	// An unmasked client frame fails.
	if _, writeErr := client.Write([]byte{0x81, 0x01, 'a'}); writeErr != nil {
		t.Fatalf("write: %v", writeErr)
	}
	_, _, err = server.readMessage()
	require.Error(t, err)
}

func TestWebSocketWriteFrame(t *testing.T) {
	server, client := pipeWS(t)
	defer func() { _ = client.Close() }()      //nolint:errcheck // test cleanup
	defer func() { _ = server.conn.Close() }() //nolint:errcheck // test cleanup
	require.NoError(t, server.writeFrame(wsOpcodeText, []byte("short")))
	require.NoError(t, server.writeFrame(wsOpcodeText, make([]byte, 200)))
	require.NoError(t, server.writeFrame(wsOpcodeText, make([]byte, 70000)))
	reader := bufio.NewReader(client)
	for _, want := range []int{5, 200, 70000} {
		header, err := reader.ReadByte()
		require.NoError(t, err)
		require.Equal(t, byte(0x81), header)
		length := int(mustByte(t, reader))
		if length == 126 {
			var extended [2]byte
			_, err = reader.Read(extended[:])
			require.NoError(t, err)
			length = int(binary.BigEndian.Uint16(extended[:]))
		}
		if length == 127 {
			var extended [8]byte
			_, err = reader.Read(extended[:])
			require.NoError(t, err)
			length = int(binary.BigEndian.Uint64(extended[:])) //nolint:gosec // a test client frame
		}
		require.Equal(t, want, length)
		payload := make([]byte, length)
		_, err = io.ReadFull(reader, payload)
		require.NoError(t, err)
	}
}

func mustByte(t *testing.T, reader *bufio.Reader) byte {
	t.Helper()
	value, err := reader.ReadByte()
	require.NoError(t, err)
	return value
}

func TestWebSocketCloseWithCode(t *testing.T) {
	server, client := pipeWS(t)
	defer func() { _ = client.Close() }() //nolint:errcheck // test cleanup
	require.NoError(t, server.closeWithCode(wsCloseGoingAway, "bye"))
	// A second close is a no-op.
	require.NoError(t, server.closeWithCode(wsCloseGoingAway, "bye"))
	require.Equal(t, 1000, closeCodeOf([]byte{0x03, 0xE8}))
	require.Equal(t, 1005, closeCodeOf(nil))
}

func TestWebSocketManagementTLS(t *testing.T) {
	management, err := newWebSocketManagement(t.TempDir(), nil)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	require.NoError(t, management.start(ctx))
	defer management.close()

	// The TLS endpoint answers 410 for an unknown connection when trusted.
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: testTLSConfig(t, management.certificatePEM)}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, management.URL+"/@connections/missing", nil)
	require.NoError(t, err)
	response, err := client.Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusGone, response.StatusCode)
	require.NoError(t, response.Body.Close())
	require.Equal(t, 0, management.connectionCount())
}

func TestWebSocketManagementOperations(t *testing.T) {
	management, err := newWebSocketManagement(t.TempDir(), nil)
	require.NoError(t, err)
	server := httptest.NewServer(management)
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}

	// Register a connection over a loopback TCP pair so the POST writes a real
	// frame.
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = listener.Close() }() //nolint:errcheck // test cleanup
	clientConn, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", listener.Addr().String())
	require.NoError(t, err)
	defer func() { _ = clientConn.Close() }() //nolint:errcheck // test cleanup
	serverConn, err := listener.Accept()
	require.NoError(t, err)
	connection := &webSocketConnection{
		id: "conn-1", apiID: "api", stage: "dev",
		connectedAt: time.Now(), lastActiveAt: time.Now(),
		conn:           newWSConn(serverConn, bufio.NewReadWriter(bufio.NewReader(serverConn), bufio.NewWriter(serverConn))),
		closeRequested: make(chan struct{}),
	}
	management.register(connection)
	require.Equal(t, 1, management.connectionCount())

	// POST writes a text frame. The pipe is unbuffered, so the frame is read
	// while the request is in flight.
	frame := make(chan byte, 1)
	go func() {
		header, readErr := bufio.NewReader(clientConn).ReadByte()
		require.NoError(t, readErr)
		frame <- header
	}()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, server.URL+"/@connections/conn-1", strings.NewReader("push"))
	require.NoError(t, err)
	response, err := client.Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode)
	require.NoError(t, response.Body.Close())
	require.Equal(t, byte(0x81), <-frame)

	// GET returns the connection document.
	request, err = http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/@connections/conn-1", nil)
	require.NoError(t, err)
	response, err = client.Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode)
	var document map[string]any
	require.NoError(t, json.NewDecoder(response.Body).Decode(&document))
	require.Contains(t, document, "connectedAt")
	require.NoError(t, response.Body.Close())

	// A wrong method is refused.
	request, err = http.NewRequestWithContext(context.Background(), http.MethodPut, server.URL+"/@connections/conn-1", nil)
	require.NoError(t, err)
	response, err = client.Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusMethodNotAllowed, response.StatusCode)
	require.NoError(t, response.Body.Close())

	// DELETE closes and unregisters.
	request, err = http.NewRequestWithContext(context.Background(), http.MethodDelete, server.URL+"/@connections/conn-1", nil)
	require.NoError(t, err)
	response, err = client.Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusNoContent, response.StatusCode)
	require.NoError(t, response.Body.Close())
	require.Equal(t, 0, management.connectionCount())

	// A malformed path is refused.
	request, err = http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/nope", nil)
	require.NoError(t, err)
	response, err = client.Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, response.StatusCode)
	require.NoError(t, response.Body.Close())
}
