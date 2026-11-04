package localrunner

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
)

// listenLoopback opens an ephemeral loopback listener and closes it when the
// test ends.
func listenLoopback(t *testing.T) net.Listener {
	t.Helper()
	var config net.ListenConfig
	listener, err := config.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() {
		if closeErr := listener.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			t.Errorf("close listener: %v", closeErr)
		}
	})
	return listener
}

func listenerPort(t *testing.T, listener net.Listener) int {
	t.Helper()
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("unexpected listener address type %T", listener.Addr())
	}
	return address.Port
}

func closeBody(t *testing.T, body io.Closer) {
	t.Helper()
	if err := body.Close(); err != nil {
		t.Errorf("close body: %v", err)
	}
}

func mustSyncBuffer(t *testing.T, writer io.Writer) *syncBuffer {
	t.Helper()
	buffer, ok := writer.(*syncBuffer)
	if !ok {
		t.Fatalf("unexpected writer type %T", writer)
	}
	return buffer
}

func mustMap(t *testing.T, value any) map[string]any {
	t.Helper()
	mapped, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("unexpected value type %T", value)
	}
	return mapped
}

func mustSlice(t *testing.T, value any) []any {
	t.Helper()
	sliced, ok := value.([]any)
	if !ok {
		t.Fatalf("unexpected value type %T", value)
	}
	return sliced
}

func mustString(t *testing.T, value any) string {
	t.Helper()
	text, ok := value.(string)
	if !ok {
		t.Fatalf("unexpected value type %T", value)
	}
	return text
}

// writeTestJSON writes one fake service response and fails the test when the
// write fails.
func writeTestJSON(t *testing.T, writer http.ResponseWriter, body string) {
	t.Helper()
	if _, err := writer.Write([]byte(body)); err != nil {
		t.Errorf("write fake response: %v", err)
	}
}
