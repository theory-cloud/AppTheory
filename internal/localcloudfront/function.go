package localcloudfront

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

//go:embed engine.js
var engineSource string

// Event is the CloudFront Functions event object, version 1.0.
type Event struct {
	Version  string         `json:"version"`
	Context  EventContext   `json:"context"`
	Viewer   Viewer         `json:"viewer"`
	Request  *EventRequest  `json:"request,omitempty"`
	Response *EventResponse `json:"response,omitempty"`
}

// EventContext is the context object CloudFront passes to a function.
type EventContext struct {
	DistributionDomainName string `json:"distributionDomainName,omitempty"`
	DistributionID         string `json:"distributionId"`
	EventType              string `json:"eventType"`
	RequestID              string `json:"requestId"`
}

// Viewer is the viewer object.
type Viewer struct {
	IP string `json:"ip"`
}

// HeaderValue is one header, cookie or query string value. MultiValue is set
// when the request carried the name more than once.
type HeaderValue struct {
	Value      string        `json:"value"`
	MultiValue []HeaderValue `json:"multiValue,omitempty"`
}

// QueryString is either the object form or the documented string shortcut a
// function may return.
type QueryString struct {
	Values map[string]HeaderValue `json:"-"`
	Raw    string                 `json:"-"`
}

// MarshalJSON writes the string form when a function returned one, otherwise
// the object form.
func (q QueryString) MarshalJSON() ([]byte, error) {
	if q.Raw != "" {
		return json.Marshal(q.Raw)
	}
	if q.Values == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(q.Values)
}

// UnmarshalJSON accepts the object form and the documented string shortcut.
func (q *QueryString) UnmarshalJSON(raw []byte) error {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		q.Raw = text
		q.Values = nil
		return nil
	}
	var values map[string]HeaderValue
	if err := json.Unmarshal(raw, &values); err != nil {
		return fmt.Errorf("querystring must be an object or a string: %w", err)
	}
	q.Values = values
	q.Raw = ""
	return nil
}

// EventRequest is the request object.
type EventRequest struct {
	Method      string                 `json:"method"`
	URI         string                 `json:"uri"`
	Querystring QueryString            `json:"querystring"`
	Headers     map[string]HeaderValue `json:"headers"`
	Cookies     map[string]HeaderValue `json:"cookies"`
}

// CookieValue is one response cookie: its value and the Set-Cookie attributes.
// MultiValue is set when the response carried the cookie name more than once.
type CookieValue struct {
	Value      string        `json:"value"`
	Attributes string        `json:"attributes,omitempty"`
	MultiValue []CookieValue `json:"multiValue,omitempty"`
}

// EventResponse is the response object. The body is optional: when it is
// absent the origin body is returned unchanged.
type EventResponse struct {
	StatusCode        int                    `json:"statusCode"`
	StatusDescription string                 `json:"statusDescription,omitempty"`
	Headers           map[string]HeaderValue `json:"headers"`
	Cookies           map[string]CookieValue `json:"cookies"`
	Body              *ResponseBody          `json:"body,omitempty"`
}

// ResponseBody is a replaced viewer-response body.
type ResponseBody struct {
	Encoding string `json:"encoding,omitempty"`
	Data     string `json:"data"`
}

// ResultKind says which object a function returned.
type ResultKind string

const (
	ResultRequest  ResultKind = "request"
	ResultResponse ResultKind = "response"
)

// FunctionResult is one validated function execution.
type FunctionResult struct {
	Kind     ResultKind
	Request  *EventRequest
	Response *EventResponse
	Logs     []string
}

// FunctionError is a function that threw, returned an invalid object or could
// not run. CloudFront turns it into a 503; the gateway must not pass the
// request through.
type FunctionError struct {
	Function  string
	EventType string
	Code      string
	Message   string
	Logs      []string
}

func (e *FunctionError) Error() string {
	return fmt.Sprintf("cloudfront function %s (%s): %s: %s", e.Function, e.EventType, e.Code, e.Message)
}

// Executor runs CloudFront Function code in a fresh Node vm context. The code
// is the exact FunctionCode string from the template.
type Executor struct {
	// NodePath is the Node executable. An empty value means "node" on PATH.
	NodePath string
	// Timeout bounds one function execution. CloudFront's own limit is 1 ms;
	// the local executor uses a watchdog because Node and process startup cost
	// more than the CloudFront CPU budget.
	Timeout time.Duration
}

// NewExecutor returns an executor with the default Node path and timeout.
func NewExecutor() *Executor {
	return &Executor{NodePath: "node", Timeout: 5 * time.Second}
}

type engineInput struct {
	Runtime string       `json:"runtime"`
	Code    string       `json:"code"`
	Timeout int          `json:"timeoutMs"`
	Cases   []engineCase `json:"cases"`
}

type engineCase struct {
	Event *Event `json:"event"`
}

type engineOutput struct {
	Results []engineResult `json:"results"`
	Error   *engineError   `json:"error,omitempty"`
}

type engineResult struct {
	OK       bool            `json:"ok"`
	Kind     string          `json:"kind"`
	Request  json.RawMessage `json:"request,omitempty"`
	Response json.RawMessage `json:"response,omitempty"`
	Logs     []string        `json:"logs,omitempty"`
	Error    *engineError    `json:"error,omitempty"`
}

type engineError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Stack   string `json:"stack,omitempty"`
}

// Execute runs one event through the function.
func (e *Executor) Execute(ctx context.Context, function *Function, event *Event) (*FunctionResult, error) {
	results, err := e.ExecuteBatch(ctx, function, []*Event{event})
	if err != nil {
		return nil, err
	}
	if len(results) == 0 || results[0] == nil {
		return nil, &FunctionError{
			Function: function.LogicalID, EventType: eventTypeOf(event),
			Code: "function-error", Message: "the function returned no result",
		}
	}
	return results[0], nil
}

// ExecuteBatch runs events in one Node process, each in a fresh vm context.
// The first function error stops the batch; CloudFront would return a 503 for
// that request, and the caller must not treat the remaining cases as passes.
//
//nolint:gocyclo // runtime gate, process run and result decoding form one transaction
func (e *Executor) ExecuteBatch(
	ctx context.Context,
	function *Function,
	events []*Event,
) ([]*FunctionResult, error) {
	if function == nil {
		return nil, errors.New("cloudfront function is nil")
	}
	if len(events) == 0 {
		return nil, nil
	}
	switch function.Runtime {
	case runtimeJS20:
	case runtimeJS10:
		if err := checkRuntime10Syntax(function.Code); err != nil {
			return nil, &FunctionError{
				Function: function.LogicalID, EventType: eventTypeOf(events[0]),
				Code: "runtime-mismatch", Message: err.Error(),
			}
		}
	default:
		return nil, &FunctionError{
			Function: function.LogicalID, EventType: eventTypeOf(events[0]),
			Code: "unsupported-runtime", Message: fmt.Sprintf("runtime %q is not a CloudFront Functions JavaScript runtime", function.Runtime),
		}
	}
	node, err := e.nodeExecutable()
	if err != nil {
		return nil, err
	}
	timeout := e.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	input := engineInput{
		Runtime: function.Runtime,
		Code:    function.Code,
		Timeout: int(timeout / time.Millisecond),
		Cases:   make([]engineCase, 0, len(events)),
	}
	for _, event := range events {
		input.Cases = append(input.Cases, engineCase{Event: event})
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("encode function input: %w", err)
	}

	runCtx, cancel := context.WithTimeout(ctx, timeout+5*time.Second)
	defer cancel()
	command := exec.CommandContext(runCtx, node, "-e", engineSource) //nolint:gosec // the script is embedded and the Node path is operator configuration
	command.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if runCtx.Err() != nil {
			return nil, &FunctionError{
				Function: function.LogicalID, EventType: eventTypeOf(events[0]),
				Code: "timeout", Message: "the local executor timed out",
			}
		}
		return nil, fmt.Errorf("run CloudFront Function %s: %w: %s", function.LogicalID, err, strings.TrimSpace(stderr.String()))
	}
	var output engineOutput
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		return nil, fmt.Errorf("decode CloudFront Function %s output: %w: %s", function.LogicalID, err, strings.TrimSpace(stdout.String()))
	}
	if output.Error != nil {
		return nil, &FunctionError{
			Function: function.LogicalID, EventType: eventTypeOf(events[0]),
			Code: output.Error.Code, Message: output.Error.Message,
		}
	}
	if len(output.Results) != len(events) {
		return nil, fmt.Errorf("CloudFront Function %s returned %d results for %d events", function.LogicalID, len(output.Results), len(events))
	}
	results := make([]*FunctionResult, 0, len(output.Results))
	for index := range output.Results {
		result, resultErr := decodeEngineResult(function, events[index], output.Results[index]) //nolint:gosec // the lengths are compared above
		if resultErr != nil {
			return nil, resultErr
		}
		results = append(results, result)
	}
	return results, nil
}

func decodeEngineResult(function *Function, event *Event, result engineResult) (*FunctionResult, error) {
	if !result.OK {
		code := "function-error"
		message := "the function failed"
		if result.Error != nil {
			if result.Error.Code != "" {
				code = result.Error.Code
			}
			if result.Error.Message != "" {
				message = result.Error.Message
			}
		}
		return nil, &FunctionError{
			Function: function.LogicalID, EventType: eventTypeOf(event),
			Code: code, Message: message, Logs: result.Logs,
		}
	}
	switch ResultKind(result.Kind) {
	case ResultRequest:
		var request EventRequest
		if err := json.Unmarshal(result.Request, &request); err != nil {
			return nil, fmt.Errorf("decode request return: %w", err)
		}
		return &FunctionResult{Kind: ResultRequest, Request: &request, Logs: result.Logs}, nil
	case ResultResponse:
		var response EventResponse
		if err := json.Unmarshal(result.Response, &response); err != nil {
			return nil, fmt.Errorf("decode response return: %w", err)
		}
		return &FunctionResult{Kind: ResultResponse, Response: &response, Logs: result.Logs}, nil
	default:
		return nil, fmt.Errorf("function returned kind %q", result.Kind)
	}
}

func eventTypeOf(event *Event) string {
	if event == nil {
		return ""
	}
	return event.Context.EventType
}

func (e *Executor) nodeExecutable() (string, error) {
	path := e.NodePath
	if path == "" {
		path = "node"
	}
	resolved, err := exec.LookPath(path)
	if err != nil {
		return "", fmt.Errorf("CloudFront Functions need Node.js on PATH (looked for %q): %w", path, err)
	}
	return resolved, nil
}

// Available reports whether the executor can find Node.js. The runner checks
// it before serving a distribution that has CloudFront Functions.
func (e *Executor) Available() error {
	_, err := e.nodeExecutable()
	return err
}
