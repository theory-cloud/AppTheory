package mcp

import (
	"context"
	"encoding/json"
)

// SSEEvent is a progress event emitted by a streaming tool handler.
type SSEEvent struct {
	Data any
}

// StreamingToolHandler is a tool handler that can emit progress events via SSE.
type StreamingToolHandler func(ctx context.Context, args json.RawMessage, emit func(SSEEvent)) (*ToolResult, error)

// RegisterStreamingTool registers a tool that supports SSE streaming.
// When invoked with Accept: text/event-stream, progress events are streamed.
// When invoked with Accept: application/json (or absent), the handler runs
// to completion and returns a buffered JSON response.
func (r *ToolRegistry) RegisterStreamingTool(def ToolDef, handler StreamingToolHandler) error {
	// Wrap the streaming handler as a regular ToolHandler that buffers results.
	// The actual SSE streaming is handled at the server level by checking the
	// Accept header and calling the streaming handler directly.
	wrapped := func(ctx context.Context, args json.RawMessage) (*ToolResult, error) {
		// When called as a regular handler, discard progress events.
		return handler(ctx, args, func(_ SSEEvent) {})
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.index[def.Name]; exists {
		return errDuplicateTool(def.Name)
	}

	r.index[def.Name] = len(r.tools)
	r.tools = append(r.tools, registeredTool{
		def:              def,
		handler:          wrapped,
		streamingHandler: handler,
	})
	return nil
}
