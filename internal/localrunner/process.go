package localrunner

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	// riePort is the port the official runtime images' embedded Runtime
	// Interface Emulator listens on inside the container.
	riePort = 8080
	// invocationPath is the Runtime Interface Emulator's invoke endpoint.
	invocationPath = "/2015-03-31/functions/function/invocations"
	// invokeTimeout bounds one handler invocation. A function's own Timeout is
	// applied by the runtime image.
	invokeTimeout = 120 * time.Second
	// readyTimeout bounds container startup: node and python images unpack and
	// start their runtime before the RIE answers.
	readyTimeout = 120 * time.Second
)

// FunctionProcess is one function container serving the RIE API on a loopback
// port.
type FunctionProcess struct {
	Function  FunctionSpec
	Container string
	Image     string
	Port      int
	// Started is when the container was started; the log follower replays from
	// this instant.
	Started time.Time

	// mu serializes invocations to this container. The official runtime images
	// embed one Runtime Interface Emulator, which reserves a single invocation
	// at a time; a concurrent POST answers "AlreadyReserved" and crashes it.
	// The local runner runs one container per function, so delivery batches and
	// HTTP requests for the same function queue here.
	mu sync.Mutex
}

// URL is the RIE invocation endpoint for this container.
func (p *FunctionProcess) URL() string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", p.Port, invocationPath)
}

// Invoke posts one event to the RIE and returns the raw response body.
func (p *FunctionProcess) Invoke(ctx context.Context, payload []byte) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.URL(), bytes.NewReader(payload)) //nolint:gosec // URL is a loopback RIE port the runner published
	if err != nil {
		return nil, fmt.Errorf("build invocation request for %s: %w", p.Container, err)
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{
		Timeout:   invokeTimeout,
		Transport: &http.Transport{Proxy: nil},
	}
	response, err := client.Do(request) //nolint:gosec // URL is a loopback RIE port the runner published
	if err != nil {
		return nil, fmt.Errorf("invoke %s: %w", p.Container, err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // the body is fully read before close
	body, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		return nil, fmt.Errorf("read invocation response from %s: %w", p.Container, readErr)
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf(
			"invoke %s: runtime interface emulator returned HTTP %d: %s",
			p.Container,
			response.StatusCode,
			truncateForMessage(string(body)),
		)
	}
	return body, nil
}

// portAccepts reports whether a loopback port accepts a TCP connection.
func portAccepts(ctx context.Context, port int) (bool, error) {
	dialer := net.Dialer{Timeout: time.Second}
	connection, err := dialer.DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false, err
	}
	if closeErr := connection.Close(); closeErr != nil {
		return true, closeErr
	}
	return true, nil
}

// waitForContainerReady waits until Docker published the RIE port, the port
// accepts a TCP connection and the container is still running.
func waitForContainerReady(ctx context.Context, docker *Docker, name string) (int, error) {
	deadline := time.Now().Add(readyTimeout)
	var lastErr error
	for {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		running, err := docker.Running(ctx, name)
		if err == nil && !running {
			return 0, fmt.Errorf("container %s exited before the runtime interface emulator was ready:\n%s", name, docker.Logs(ctx, name))
		}
		port, portErr := docker.PublishedPort(ctx, name, riePort)
		switch {
		case portErr != nil:
			lastErr = portErr
		case port == 0:
			lastErr = fmt.Errorf("the runtime interface emulator port is not published yet")
		default:
			ready, dialErr := portAccepts(ctx, port)
			if ready {
				return port, nil
			}
			lastErr = dialErr
		}
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("container %s did not become ready: %w\n%s", name, lastErr, docker.Logs(ctx, name))
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}
