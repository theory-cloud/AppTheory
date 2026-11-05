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
	// invocationPath is the Runtime Interface Emulator's invoke endpoint. It is
	// used only when the run asks for RIE mode.
	invocationPath = "/2015-03-31/functions/function/invocations"
	// invokeTimeout bounds one handler invocation in RIE mode. A function's own
	// Timeout is applied by the runtime image.
	invokeTimeout = 120 * time.Second
	// readyTimeout bounds container startup: node and python images unpack and
	// start their runtime before the Runtime API answers.
	readyTimeout = 120 * time.Second
)

// FunctionProcess is one function container. In the default mode it serves the
// Lambda Runtime API and the container's own runtime interface client talks to
// it; in RIE mode it posts to the image's embedded Runtime Interface Emulator.
type FunctionProcess struct {
	Function  FunctionSpec
	Container string
	Image     string
	// Port is the loopback port of the embedded Runtime Interface Emulator. It
	// is set only in RIE mode.
	Port int
	// Started is when the container was started; the log follower replays from
	// this instant.
	Started time.Time

	// mu serializes invocations to this container. The runtime processes one
	// invocation at a time outside Managed Instances, so delivery batches and
	// HTTP requests for the same function queue here.
	// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
	mu sync.Mutex

	rie bool
	api *runtimeAPI
	// reset replaces the execution environment after a timeout, a crash or an
	// init failure, as the lifecycle page describes.
	// https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
	reset func(ctx context.Context, process *FunctionProcess) error
	// needsReset is set when the environment must be replaced before the next
	// invocation.
	needsReset bool
	// options is the docker run configuration, reused to replace the
	// environment without rebuilding the function's layers.
	options ContainerOptions
	logf    func(string, ...any)
}

// closeRuntimeAPI stops the process's Runtime API listener.
func (p *FunctionProcess) closeRuntimeAPI() {
	if p.api != nil {
		p.api.close()
		p.api = nil
	}
}

// URL is the RIE invocation endpoint. It is empty outside RIE mode.
func (p *FunctionProcess) URL() string {
	if p.Port == 0 {
		return ""
	}
	return fmt.Sprintf("http://127.0.0.1:%d%s", p.Port, invocationPath)
}

// RuntimeAPIURL is the host address of this function's Runtime API.
func (p *FunctionProcess) RuntimeAPIURL() string {
	if p.api == nil {
		return ""
	}
	return p.api.HostURL()
}

// StreamingIncremental reports whether this process can forward chunks as the
// runtime writes them. The emulator buffers every response, so RIE mode cannot.
func (p *FunctionProcess) StreamingIncremental() bool {
	return !p.rie && p.api != nil
}

// Invoke runs one event and returns the response payload. A Lambda error
// (including a timeout, a crash or an initialization failure) is returned as
// the documented error JSON so existing callers decode it exactly as they
// decoded the emulator's response.
func (p *FunctionProcess) Invoke(ctx context.Context, payload []byte) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.rie || p.api == nil {
		return p.invokeRIE(ctx, payload)
	}
	if err := p.ensureFresh(ctx); err != nil {
		return nil, err
	}
	body, result := p.api.Invoke(ctx, payload)
	p.afterInvocation(ctx, result)
	if len(body) == 0 && result.err != nil {
		return nil, result.err
	}
	return body, nil
}

// InvokeStreamResult is one invocation's outcome on the streaming path.
type InvokeStreamResult struct {
	Body []byte
	// Streamed reports that the runtime sent a chunked response.
	Streamed bool
	// ContentType is the response Content-Type the runtime set.
	ContentType string
	// HandlerError is set when the runtime answered with an error instead of a
	// response: an /error post, a timeout, a crash or an initialization
	// failure. Body then carries the documented error JSON, so a sink can
	// answer the invocation without waiting for a response that will never
	// arrive.
	HandlerError error
	// ErrorType and ErrorBody are the midstream error trailers, when present.
	ErrorType string
	ErrorBody []byte
}

// InvokeStream runs one event and forwards each response chunk to sink as it
// arrives. A nil sink buffers the response. The returned body is always the
// complete payload, which keeps the caller's decode path unchanged.
func (p *FunctionProcess) InvokeStream(ctx context.Context, payload []byte, sink StreamSink) (InvokeStreamResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.rie || p.api == nil {
		body, err := p.invokeRIE(ctx, payload)
		if err != nil {
			return InvokeStreamResult{}, err
		}
		if sink != nil {
			if startErr := sink.Start("", false); startErr != nil {
				return InvokeStreamResult{Body: body}, startErr
			}
			if chunkErr := sink.Chunk(body); chunkErr != nil {
				return InvokeStreamResult{Body: body}, chunkErr
			}
			_ = sink.End("", nil) //nolint:errcheck // the client is gone if this fails
		}
		return InvokeStreamResult{Body: body}, nil
	}
	if err := p.ensureFresh(ctx); err != nil {
		return InvokeStreamResult{}, err
	}
	body, result := p.api.InvokeStream(ctx, payload, sink)
	p.afterInvocation(ctx, result)
	if result.reported != nil {
		// The runtime reported an error instead of a response. The body is the
		// documented error JSON; carrying the error explicitly keeps the
		// outcome distinct from a successful body of the same bytes.
		return InvokeStreamResult{
			Body:         body,
			Streamed:     result.streamed,
			ContentType:  result.contentType,
			HandlerError: result.reported,
		}, nil
	}
	if len(body) == 0 && result.err != nil {
		return InvokeStreamResult{Streamed: result.streamed, ContentType: result.contentType}, result.err
	}
	if result.errorType != "" && p.logf != nil {
		p.logf("function %s: midstream error trailer %s: %s", p.Function.LogicalID, result.errorType, truncateForMessage(string(result.errorBody)))
	}
	return InvokeStreamResult{
		Body:        body,
		Streamed:    result.streamed,
		ContentType: result.contentType,
		ErrorType:   result.errorType,
		ErrorBody:   result.errorBody,
	}, nil
}

// afterInvocation replaces the execution environment when the invocation ended
// in a timeout, a crash or an initialization failure.
func (p *FunctionProcess) afterInvocation(ctx context.Context, result runtimeInvocationResult) {
	if !result.reset {
		return
	}
	p.needsReset = true
	if err := p.resetNow(ctx); err != nil && p.logf != nil {
		p.logf("function %s: %v", p.Function.LogicalID, err)
	}
}

// ensureFresh replaces a failed execution environment before the next
// invocation; a failure to replace it fails the invocation instead of running
// on a dead container.
func (p *FunctionProcess) ensureFresh(ctx context.Context) error {
	if !p.needsReset {
		return nil
	}
	return p.resetNow(ctx)
}

func (p *FunctionProcess) resetNow(ctx context.Context) error {
	if p.reset == nil {
		p.needsReset = false
		return nil
	}
	resetCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	if err := p.reset(resetCtx, p); err != nil {
		return fmt.Errorf("replace the execution environment for %s: %w", p.Function.LogicalID, err)
	}
	p.needsReset = false
	return nil
}

// invokeRIE posts one event to the embedded Runtime Interface Emulator.
func (p *FunctionProcess) invokeRIE(ctx context.Context, payload []byte) ([]byte, error) {
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
// accepts a TCP connection and the container is still running. It is used only
// in RIE mode.
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

// waitForRuntimeAPIReady waits for the runtime's first Next API request, which
// is how the execution-environment page defines the end of the Init phase.
// A runtime that exits (or reports an initialization error) before that is not
// a run failure: the first invocation fails with the documented init error and
// the environment is replaced, exactly as the lifecycle page describes.
// https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
func waitForRuntimeAPIReady(ctx context.Context, docker *Docker, name string, api *runtimeAPI) error {
	deadline := time.Now().Add(readyTimeout)
	// The container's first /next proves the address it was given is reachable.
	// A container that has not asked within the probe window gets the run
	// network's gateway address instead, which is the address it reaches on
	// Linux; Colima and Docker Desktop forward host.docker.internal to the
	// host's loopback, where the gateway bind fails and loopback stays.
	probe := time.Now().Add(runtimeAPIProbeTimeout)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		select {
		case <-api.nextSeen:
			return nil
		default:
		}
		if failure := api.initError(); failure != nil {
			return nil
		}
		running, err := docker.Running(ctx, name)
		if err == nil && !running {
			if failure := api.initError(); failure != nil {
				return nil
			}
			// The runtime may have exited because it could not reach the
			// loopback listener. Move the listener before the one-time restart
			// so the replacement container gets an address it can reach.
			api.rebindToGateway(ctx)
			if api.logf != nil {
				api.logf("function %s: the runtime exited before its first invocation; recent output:\n%s",
					api.function.LogicalID, docker.Logs(ctx, name))
			}
			api.recordInitFailure(startupFailure(ctx, docker, name))
			return nil
		}
		if !probe.IsZero() && time.Now().After(probe) {
			probe = time.Time{}
			api.rebindToGateway(ctx)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("container %s did not ask the runtime API for an invocation: %s", name, docker.Logs(ctx, name))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// startupFailure is the documented init error for a runtime process that exited
// before its first Next API request.
// https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
func startupFailure(ctx context.Context, docker *Docker, name string) *RuntimeAPIError {
	code, err := docker.ExitCode(ctx, name)
	message := "Runtime exited without providing a reason"
	if err == nil && code != 0 {
		message = fmt.Sprintf("Runtime exited with error: exit status %d", code)
	}
	payload := errorPayload("Runtime.ExitError", message)
	return &RuntimeAPIError{Type: "Runtime.ExitError", Message: message, Body: payload}
}
