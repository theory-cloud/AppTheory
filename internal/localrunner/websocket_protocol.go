package localrunner

import (
	"bufio"
	"crypto/sha1" //nolint:gosec // RFC 6455 defines the handshake digest as SHA-1
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// A minimal RFC 6455 server implementation: the subset a WebSocket API needs.
//
// https://datatracker.ietf.org/doc/html/rfc6455
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html
//
// API Gateway closes a connection with 1001 when the client is idle for ten
// minutes or reaches the two-hour connection lifetime, with 1003 for a binary
// media type and with 1009 for a message that is too big:
// https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html
const (
	webSocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

	wsOpcodeContinuation = 0x0
	wsOpcodeText         = 0x1
	wsOpcodeBinary       = 0x2
	wsOpcodeClose        = 0x8
	wsOpcodePing         = 0x9
	wsOpcodePong         = 0xA

	wsCloseNormal          = 1000
	wsCloseGoingAway       = 1001
	wsCloseUnsupportedData = 1003
	wsClosePolicyViolation = 1008
	wsCloseTooBig          = 1009
	wsCloseInternalError   = 1011

	// maxWebSocketFrameBytes is API Gateway's frame size quota.
	maxWebSocketFrameBytes = 32 * 1024
	// maxWebSocketMessageBytes bounds a fragmented message.
	maxWebSocketMessageBytes = 128 * 1024

	// webSocketWriteTimeout bounds one server write.
	webSocketWriteTimeout = 10 * time.Second
)

// webSocketHandshake validates the upgrade request and returns the accept key.
func webSocketHandshake(request *http.Request) (string, error) {
	if !headerContainsToken(request.Header, "Connection", "upgrade") {
		return "", errors.New("connection header does not request an upgrade")
	}
	if !headerContainsToken(request.Header, "Upgrade", "websocket") {
		return "", errors.New("upgrade header is not websocket")
	}
	if version := strings.TrimSpace(request.Header.Get("Sec-WebSocket-Version")); version != "13" {
		return "", fmt.Errorf("Sec-WebSocket-Version %q is not 13", version)
	}
	key := strings.TrimSpace(request.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return "", errors.New("Sec-WebSocket-Key is missing")
	}
	return webSocketAcceptKey(key), nil
}

func webSocketAcceptKey(key string) string {
	digest := sha1.Sum([]byte(key + webSocketGUID)) //nolint:gosec // RFC 6455 mandates SHA-1 here
	return base64.StdEncoding.EncodeToString(digest[:])
}

func headerContainsToken(header http.Header, name, token string) bool {
	for _, value := range header.Values(name) {
		for _, candidate := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(candidate), token) {
				return true
			}
		}
	}
	return false
}

// hijackUpgrade completes the handshake on the hijacked connection.
func hijackUpgrade(writer http.ResponseWriter, _ *http.Request, accept string) (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("the listener cannot upgrade this connection")
	}
	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		return nil, nil, err
	}
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := buffered.WriteString(response); err != nil {
		_ = conn.Close() //nolint:errcheck // the handshake failed
		return nil, nil, err
	}
	if err := buffered.Flush(); err != nil {
		_ = conn.Close() //nolint:errcheck // the handshake failed
		return nil, nil, err
	}
	return conn, buffered, nil
}

// wsConn is one upgraded connection.
type wsConn struct {
	conn   net.Conn
	reader *bufio.Reader
	// writeMu serializes frames from the reader loop and the management API.
	writeMu sync.Mutex
	closed  bool
}

func newWSConn(conn net.Conn, buffered *bufio.ReadWriter) *wsConn {
	return &wsConn{conn: conn, reader: buffered.Reader}
}

// readMessage returns the next data message, or a control frame result. It
// accepts a fragmented message and answers a ping with a pong. A close frame
// returns io.EOF after the close handshake.
func (c *wsConn) readMessage() (opcode byte, payload []byte, err error) {
	var message []byte
	var messageOpcode byte
	for {
		fin, frameOpcode, framePayload, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch frameOpcode {
		case wsOpcodeClose:
			return wsOpcodeClose, framePayload, nil
		case wsOpcodePing:
			if err := c.writeFrame(wsOpcodePong, framePayload); err != nil {
				return 0, nil, err
			}
			continue
		case wsOpcodePong:
			continue
		case wsOpcodeText, wsOpcodeBinary:
			if messageOpcode != 0 {
				return 0, nil, errors.New("a new data frame started before the fragmented message ended")
			}
			messageOpcode = frameOpcode
			message = append(message, framePayload...)
		case wsOpcodeContinuation:
			if messageOpcode == 0 {
				return 0, nil, errors.New("a continuation frame has no message to continue")
			}
			message = append(message, framePayload...)
		default:
			return 0, nil, fmt.Errorf("unsupported WebSocket opcode %#x", frameOpcode)
		}
		if len(message) > maxWebSocketMessageBytes {
			return 0, nil, errWebSocketTooBig
		}
		if fin {
			return messageOpcode, message, nil
		}
	}
}

var errWebSocketTooBig = errors.New("the WebSocket message exceeds the documented 128 KB limit")

// readFrame reads one frame, unmasks its payload and enforces the client mask
// and the frame size quota.
func (c *wsConn) readFrame() (bool, byte, []byte, error) {
	var header [2]byte
	if _, err := io.ReadFull(c.reader, header[:]); err != nil {
		return false, 0, nil, err
	}
	fin := header[0]&0x80 != 0
	opcode := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	length := int64(header[1] & 0x7F)
	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return false, 0, nil, err
		}
		length = int64(binary.BigEndian.Uint16(extended[:]))
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return false, 0, nil, err
		}
		length = int64(binary.BigEndian.Uint64(extended[:])) //nolint:gosec // bounded by the frame quota below
	}
	if length > maxWebSocketFrameBytes {
		return false, 0, nil, errWebSocketTooBig
	}
	if !masked {
		return false, 0, nil, errors.New("a client frame must be masked")
	}
	var mask [4]byte
	if _, err := io.ReadFull(c.reader, mask[:]); err != nil {
		return false, 0, nil, err
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return false, 0, nil, err
	}
	for index := range payload {
		payload[index] ^= mask[index%4]
	}
	if opcode >= 0x8 && (!fin || length > 125) {
		return false, 0, nil, errors.New("a control frame must be final and at most 125 bytes")
	}
	return fin, opcode, payload, nil
}

// writeFrame writes one unmasked server frame.
func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return net.ErrClosed
	}
	header := []byte{0x80 | opcode}
	switch {
	case len(payload) < 126:
		header = append(header, byte(len(payload))) //nolint:gosec // bounded above
	case len(payload) <= 0xFFFF:
		header = append(header, 126, 0, 0)
		binary.BigEndian.PutUint16(header[len(header)-2:], uint16(len(payload))) //nolint:gosec // bounded above
	default:
		header = append(header, 127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(header[len(header)-8:], uint64(len(payload)))
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(webSocketWriteTimeout)) //nolint:errcheck // a deadline error surfaces on the write
	if _, err := c.conn.Write(header); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := c.conn.Write(payload)
	return err
}

// closeWithCode sends a close frame and closes the transport.
func (c *wsConn) closeWithCode(code int, reason string) error {
	c.writeMu.Lock()
	alreadyClosed := c.closed
	c.closed = true
	c.writeMu.Unlock()
	if alreadyClosed {
		return nil
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(webSocketWriteTimeout)) //nolint:errcheck // closing anyway
	_, _ = c.conn.Write(closeFrame(code, reason))                      //nolint:errcheck // best-effort close handshake
	return c.conn.Close()
}

func closeFrame(code int, reason string) []byte {
	payload := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(payload, uint16(code)) //nolint:gosec // close codes are small
	copy(payload[2:], reason)
	header := make([]byte, 2, 2+len(payload))
	header[0] = 0x80 | wsOpcodeClose
	header[1] = byte(len(payload)) //nolint:gosec // the reason is bounded
	return append(header, payload...)
}

// closeCodeOf reads the code a client sent in its close frame.
func closeCodeOf(payload []byte) int {
	if len(payload) < 2 {
		return 1005
	}
	return int(binary.BigEndian.Uint16(payload))
}
