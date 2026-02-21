package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// ToolDef defines an MCP tool's metadata and input schema.
type ToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// ToolHandler is the function signature for tool implementations.
type ToolHandler func(ctx context.Context, args json.RawMessage) (*ToolResult, error)

// ToolResult is the result of a tool invocation.
type ToolResult struct {
	Content           []ContentBlock `json:"content"`
	IsError           bool           `json:"isError,omitempty"`
	StructuredContent map[string]any `json:"structuredContent,omitempty"`
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
