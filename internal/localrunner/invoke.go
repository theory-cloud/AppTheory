package localrunner

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// HandlerSpec describes one handler to run without a CDK definition. It is for
// examples that ship a Lambda handler but no CDK app: the caller supplies the
// built code directory and every request event. No routing is derived or
// invented.
type HandlerSpec struct {
	CodeDir      string
	Runtime      string
	Handler      string
	Architecture string
	MemoryMB     int
	Timeout      int
	Environment  map[string]string
}

// InvokeResult is one handler response. Proxy is true when the handler returned
// a Lambda proxy response (statusCode/headers/body); otherwise Raw carries the
// handler's JSON result unchanged.
type InvokeResult struct {
	Proxy        bool                `json:"proxy"`
	StatusCode   int                 `json:"statusCode,omitempty"`
	Headers      map[string][]string `json:"headers,omitempty"`
	Body         string              `json:"body,omitempty"`
	Streamed     bool                `json:"streamed,omitempty"`
	Raw          json.RawMessage     `json:"raw,omitempty"`
	RawText      string              `json:"rawText,omitempty"`
	HandlerError string              `json:"handlerError,omitempty"`
}

func normalizeHandlerSpec(spec *HandlerSpec) error {
	if strings.TrimSpace(spec.CodeDir) == "" {
		return errors.New("handler mode needs a code directory (--handler-dir)")
	}
	absolute, err := filepath.Abs(spec.CodeDir)
	if err != nil {
		return fmt.Errorf("resolve handler code directory %q: %w", spec.CodeDir, err)
	}
	info, statErr := os.Stat(absolute)
	if statErr != nil || !info.IsDir() {
		return fmt.Errorf("handler code directory %s is not a directory", absolute)
	}
	spec.CodeDir = absolute
	if _, err := RuntimeClass(spec.Runtime); err != nil {
		return err
	}
	if strings.TrimSpace(spec.Handler) == "" {
		return errors.New("handler mode needs a handler name (--handler)")
	}
	if spec.Architecture == "" {
		if strings.HasPrefix(spec.Runtime, "provided.") {
			spec.Architecture = archARM64
		} else {
			spec.Architecture = archAMD64
		}
	}
	if spec.MemoryMB == 0 {
		spec.MemoryMB = 128
	}
	if spec.Timeout == 0 {
		spec.Timeout = 3
	}
	return nil
}

// RunInvoke starts the target function once and sends newline-delimited JSON
// events read from in, writing one JSON result per event to out. The container
// stays warm for the whole stream, so session state persists across requests.
func (r *Runner) RunInvoke(ctx context.Context, functionID string, in io.Reader, out io.Writer) error {
	cleanup := r.cleanupFunc()
	defer cleanup()
	r.options.AllowNoSurface = true

	spec, err := r.invokeSpec(ctx)
	if err != nil {
		return err
	}
	functionID, _, err = r.invokeTarget(spec, functionID)
	if err != nil {
		return err
	}
	if err = r.prepareInvoke(ctx, spec, functionID); err != nil {
		return err
	}
	function, _ := spec.Function(functionID)
	image, err := r.imageFor(ctx, function)
	if err != nil {
		return err
	}
	if err := r.startFunction(ctx, function, image); err != nil {
		return err
	}
	process, ok := r.invokers[functionID]
	if !ok {
		return fmt.Errorf("function %s did not start", functionID)
	}
	return r.streamInvocations(ctx, process, in, out)
}

// prepareInvoke creates the run's network, starts its backends, provisions the
// local resources and proves the environment before the target starts.
func (r *Runner) prepareInvoke(ctx context.Context, spec *Spec, functionID string) error {
	if err := r.docker.Available(ctx); err != nil {
		return err
	}
	arch, err := r.docker.ServerArch(ctx)
	if err != nil {
		return err
	}
	if err = r.resolveImages(spec, arch, []string{functionID}); err != nil {
		return err
	}
	if err = r.prepareScratch(spec); err != nil {
		return err
	}
	if err = r.docker.CreateNetwork(ctx, r.network, r.labels()); err != nil {
		return err
	}
	r.logf("network %s", r.network)
	r.chooseRuntimeAPIAddress(ctx)
	if err = r.startBackends(ctx); err != nil {
		return err
	}
	if err = r.provisionResources(ctx, spec); err != nil {
		return err
	}
	if err = r.startCognitoIssuer(ctx, spec); err != nil {
		return err
	}
	if err = r.resolveEnvironment(spec, []string{functionID}); err != nil {
		return err
	}
	preflight, err := r.Preflight(ctx, r.network, r.options.AddHosts)
	if err != nil {
		return err
	}
	for _, check := range sortedKeys(preflight.Checks) {
		r.logf("preflight %s: %s", check, preflight.Checks[check])
	}
	return nil
}

func (r *Runner) invokeSpec(ctx context.Context) (*Spec, error) {
	if r.options.Handler != nil {
		spec := &Spec{}
		handler := *r.options.Handler
		function := FunctionSpec{
			LogicalID:    "Handler",
			Stack:        "handler",
			Runtime:      handler.Runtime,
			Handler:      handler.Handler,
			Architecture: handler.Architecture,
			MemoryMB:     handler.MemoryMB,
			Timeout:      handler.Timeout,
			Environment:  map[string]string{},
			AssetDir:     handler.CodeDir,
		}
		for name, value := range handler.Environment {
			function.Environment[name] = value
		}
		spec.Functions = append(spec.Functions, function)
		return spec, nil
	}
	return r.Plan(ctx)
}

func (r *Runner) invokeTarget(spec *Spec, functionID string) (string, FunctionSpec, error) {
	if r.options.Handler != nil {
		if functionID == "" {
			functionID = "Handler"
		}
		if functionID != "Handler" {
			return "", FunctionSpec{}, fmt.Errorf("handler mode has one target, Handler, not %q", functionID)
		}
		function, _ := spec.Function("Handler")
		return functionID, function, nil
	}
	if strings.TrimSpace(functionID) == "" {
		return "", FunctionSpec{}, errors.New("--function is required when invoking a CDK app")
	}
	function, ok := spec.Function(functionID)
	if !ok {
		return "", FunctionSpec{}, fmt.Errorf("assembly defines no function %q", functionID)
	}
	if function.CodeProblem != "" {
		return "", FunctionSpec{}, unsupported(functionID, "%s", function.CodeProblem)
	}
	if function.LayerProblem != "" {
		return "", FunctionSpec{}, unsupported(functionID, "%s", function.LayerProblem)
	}
	if err := unresolvedLimitsError(function); err != nil {
		return "", FunctionSpec{}, err
	}
	return functionID, function, nil
}

func (r *Runner) streamInvocations(ctx context.Context, process *FunctionProcess, in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 16<<20)
	writer := bufio.NewWriter(out)
	defer func() { _ = writer.Flush() }() //nolint:errcheck // the caller sees the last write error
	count := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if !json.Valid([]byte(line)) {
			return fmt.Errorf("event %d is not valid JSON", count+1)
		}
		var result InvokeResult
		if r.options.StreamChunks {
			sink := &chunkEventWriter{writer: writer, invocation: count + 1}
			streamed, streamErr := process.InvokeStream(ctx, []byte(line), sink)
			if streamErr != nil {
				return streamErr
			}
			result = decodeInvokeResult(streamed.Body)
		} else {
			raw, err := process.Invoke(ctx, []byte(line))
			if err != nil {
				return err
			}
			result = decodeInvokeResult(raw)
		}
		encoded, err := encodeInvokeResult(result, r.options.StreamChunks, count+1)
		if err != nil {
			return err
		}
		if _, err := writer.Write(append(encoded, '\n')); err != nil {
			return fmt.Errorf("write invocation result: %w", err)
		}
		if err := writer.Flush(); err != nil {
			return fmt.Errorf("flush invocation result: %w", err)
		}
		count++
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read invoke events: %w", err)
	}
	if count == 0 {
		return errors.New("no invocation event was supplied")
	}
	return nil
}

// chunkEvent is one chunk of a streamed response. It precedes the result line
// only when the caller asks for chunk events, so the default protocol stays one
// result line per event.
type chunkEvent struct {
	Event       string `json:"event"`
	Invocation  int    `json:"invocation"`
	Index       int    `json:"index"`
	ContentType string `json:"contentType,omitempty"`
	Data        string `json:"data"`
}

type resultEvent struct {
	Event      string `json:"event"`
	Invocation int    `json:"invocation"`
	InvokeResult
}

// chunkEventWriter writes one JSON chunk event per chunk the runtime produces.
type chunkEventWriter struct {
	writer      *bufio.Writer
	invocation  int
	index       int
	contentType string
	streamed    bool
}

func (w *chunkEventWriter) Start(contentType string, streamed bool) error {
	w.contentType = contentType
	w.streamed = streamed
	return nil
}

func (w *chunkEventWriter) Chunk(chunk []byte) error {
	if !w.streamed {
		return nil
	}
	encoded, err := json.Marshal(chunkEvent{
		Event:       "chunk",
		Invocation:  w.invocation,
		Index:       w.index,
		ContentType: w.contentType,
		Data:        base64.StdEncoding.EncodeToString(chunk),
	})
	if err != nil {
		return fmt.Errorf("encode invocation chunk: %w", err)
	}
	if _, err := w.writer.Write(append(encoded, '\n')); err != nil {
		return fmt.Errorf("write invocation chunk: %w", err)
	}
	if err := w.writer.Flush(); err != nil {
		return fmt.Errorf("flush invocation chunk: %w", err)
	}
	w.index++
	return nil
}

func (w *chunkEventWriter) End(string, []byte) error { return nil }

func encodeInvokeResult(result InvokeResult, chunks bool, invocation int) ([]byte, error) {
	if !chunks {
		encoded, err := json.Marshal(result)
		if err != nil {
			return nil, fmt.Errorf("encode invocation result: %w", err)
		}
		return encoded, nil
	}
	encoded, err := json.Marshal(resultEvent{Event: "result", Invocation: invocation, InvokeResult: result})
	if err != nil {
		return nil, fmt.Errorf("encode invocation result: %w", err)
	}
	return encoded, nil
}

func decodeInvokeResult(raw []byte) InvokeResult {
	response, err := DecodeResponse(raw)
	if err == nil {
		return InvokeResult{
			Proxy:      true,
			StatusCode: response.StatusCode,
			Headers:    response.Headers,
			Body:       string(response.Body),
			Streamed:   response.Streamed,
		}
	}
	var handlerErr *HandlerError
	if errors.As(err, &handlerErr) {
		return InvokeResult{HandlerError: handlerErr.Error(), Raw: json.RawMessage(raw)}
	}
	if json.Valid(raw) {
		return InvokeResult{Raw: json.RawMessage(raw)}
	}
	return InvokeResult{RawText: string(raw)}
}
