package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// ToolDef defines an MCP tool's metadata and input schema.
type ToolDef struct {
	Name        string           `json:"name"`
	Title       string           `json:"title,omitempty"`
	Description string           `json:"description,omitempty"`
	Annotations *ToolAnnotations `json:"annotations,omitempty"`

	Icons        []Icon          `json:"icons,omitempty"`
	Execution    *ToolExecution  `json:"execution,omitempty"`
	InputSchema  json.RawMessage `json:"inputSchema"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
}

type ToolAnnotations struct {
	Title           string `json:"title,omitempty"`
	ReadOnlyHint    *bool  `json:"readOnlyHint,omitempty"`
	DestructiveHint *bool  `json:"destructiveHint,omitempty"`
	IdempotentHint  *bool  `json:"idempotentHint,omitempty"`
	OpenWorldHint   *bool  `json:"openWorldHint,omitempty"`
}

type ToolExecution struct {
	// TaskSupport indicates if the tool supports task-augmented execution.
	// Values: "forbidden", "optional", "required".
	TaskSupport TaskSupport `json:"taskSupport,omitempty"`
}

type Icon struct {
	Src      string   `json:"src"`
	MimeType string   `json:"mimeType,omitempty"`
	Sizes    []string `json:"sizes,omitempty"`
	Theme    string   `json:"theme,omitempty"` // "light" or "dark"
}

// ToolHandler is the function signature for tool implementations.
type ToolHandler func(ctx context.Context, args json.RawMessage) (*ToolResult, error)

// InputRequest is a server-initiated request that a 2026-07-28 client must
// fulfill before retrying the original tool call.
type InputRequest struct {
	Method string `json:"method"`
	Params any    `json:"params,omitempty"`
}

// InputRequiredResult describes the client input needed before a request can
// complete. At least one of InputRequests or RequestState must be present.
type InputRequiredResult struct {
	ResultType    ResultType              `json:"resultType,omitempty"`
	InputRequests map[string]InputRequest `json:"inputRequests,omitempty"`
	RequestState  string                  `json:"requestState,omitempty"`
	Meta          map[string]any          `json:"_meta,omitempty"`
}

// ToolResult is the result of a tool invocation.
type ToolResult struct {
	Content           []ContentBlock          `json:"content"`
	IsError           bool                    `json:"isError,omitempty"`
	StructuredContent map[string]any          `json:"structuredContent,omitempty"`
	ResultType        ResultType              `json:"resultType,omitempty"`
	InputRequests     map[string]InputRequest `json:"inputRequests,omitempty"`
	RequestState      string                  `json:"requestState,omitempty"`
}

// ToolInput contains client responses supplied when retrying a 2026-07-28
// multi-round tool call.
type ToolInput struct {
	InputResponses map[string]any
	RequestState   string
}

type toolInputContextKey struct{}

// ToolInputFromContext returns the multi-round client input associated with a
// tool invocation. It returns the zero value for ordinary calls.
func ToolInputFromContext(ctx context.Context) ToolInput {
	if ctx == nil {
		return ToolInput{}
	}
	input, ok := ctx.Value(toolInputContextKey{}).(ToolInput)
	if !ok {
		return ToolInput{}
	}
	input.InputResponses = cloneStringAnyMap(input.InputResponses)
	return input
}

func withToolInput(ctx context.Context, input ToolInput) context.Context {
	input.InputResponses = cloneStringAnyMap(input.InputResponses)
	return context.WithValue(ctx, toolInputContextKey{}, input)
}

func cloneStringAnyMap(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

type ContentBlock struct {
	Type string `json:"type"` // "text", "image", "audio", "resource_link", "resource"

	// Text content (type = "text").
	Text string `json:"text,omitempty"`

	// Image/audio content (type = "image" or "audio").
	Data     string `json:"data,omitempty"`     // base64-encoded
	MimeType string `json:"mimeType,omitempty"` // e.g. "image/png"

	// Resource link content (type = "resource_link").
	URI         string `json:"uri,omitempty"`
	Name        string `json:"name,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Size        int64  `json:"size,omitempty"`

	// Embedded resource content (type = "resource").
	Resource *ResourceContent `json:"resource,omitempty"`
}

// registeredTool pairs a tool definition with its handler.
type registeredTool struct {
	def              ToolDef
	handler          ToolHandler
	streamingHandler StreamingToolHandler
}

// ToolRegistry manages registered MCP tools.
type ToolRegistry struct {
	mu    sync.RWMutex
	tools []registeredTool
	index map[string]int
}

// NewToolRegistry creates an empty tool registry.
func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{
		index: make(map[string]int),
	}
}

// errDuplicateTool returns an error for a duplicate tool registration.
func errDuplicateTool(name string) error {
	return fmt.Errorf("tool already registered: %s", name)
}

// RegisterTool adds a tool to the registry. It returns an error if a tool
// with the same name is already registered.
func (r *ToolRegistry) RegisterTool(def ToolDef, handler ToolHandler) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.index[def.Name]; exists {
		return errDuplicateTool(def.Name)
	}

	r.index[def.Name] = len(r.tools)
	r.tools = append(r.tools, registeredTool{def: def, handler: handler})
	return nil
}

// List returns all registered tool definitions in registration order.
func (r *ToolRegistry) List() []ToolDef {
	r.mu.RLock()
	defer r.mu.RUnlock()

	defs := make([]ToolDef, len(r.tools))
	for i, t := range r.tools {
		defs[i] = t.def
	}
	return defs
}

// Len returns the number of registered tools.
func (r *ToolRegistry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.tools)
}

func (r *ToolRegistry) supportsStreaming(name string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	idx, ok := r.index[name]
	if !ok {
		return false
	}
	return r.tools[idx].streamingHandler != nil
}

func (r *ToolRegistry) supportsTasks() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, tool := range r.tools {
		if tool.def.Execution == nil {
			continue
		}
		switch tool.def.Execution.TaskSupport {
		case TaskSupportOptional, TaskSupportRequired:
			return true
		}
	}
	return false
}

func (r *ToolRegistry) taskSupport(name string) TaskSupport {
	r.mu.RLock()
	defer r.mu.RUnlock()

	idx, ok := r.index[name]
	if !ok || r.tools[idx].def.Execution == nil {
		return TaskSupportForbidden
	}
	switch r.tools[idx].def.Execution.TaskSupport {
	case TaskSupportOptional, TaskSupportRequired:
		return r.tools[idx].def.Execution.TaskSupport
	default:
		return TaskSupportForbidden
	}
}

// Call looks up a tool by name and invokes its handler with the given arguments.
// It returns an error if the tool is not found.
func (r *ToolRegistry) Call(ctx context.Context, name string, args json.RawMessage) (*ToolResult, error) {
	r.mu.RLock()
	idx, ok := r.index[name]
	if !ok {
		r.mu.RUnlock()
		return nil, fmt.Errorf("tool not found: %s", name)
	}
	handler := r.tools[idx].handler
	r.mu.RUnlock()

	return handler(ctx, args)
}

// CallStreaming looks up a tool by name and invokes its streaming handler if
// available, otherwise falls back to the regular handler (discarding emit).
func (r *ToolRegistry) CallStreaming(ctx context.Context, name string, args json.RawMessage, emit func(SSEEvent)) (*ToolResult, error) {
	r.mu.RLock()
	idx, ok := r.index[name]
	if !ok {
		r.mu.RUnlock()
		return nil, fmt.Errorf("tool not found: %s", name)
	}
	tool := r.tools[idx]
	r.mu.RUnlock()

	if tool.streamingHandler != nil {
		return tool.streamingHandler(ctx, args, emit)
	}
	return tool.handler(ctx, args)
}
