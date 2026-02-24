package mcp

import (
	"encoding/json"

	mcpruntime "github.com/theory-cloud/apptheory/runtime/mcp"
)

// InitializeRequest builds a JSON-RPC initialize request.
func InitializeRequest(id any) *mcpruntime.Request {
	return &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "initialize",
	}
}

// ListToolsRequest builds a JSON-RPC tools/list request.
func ListToolsRequest(id any) *mcpruntime.Request {
	return &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "tools/list",
	}
}

// CallToolRequest builds a JSON-RPC tools/call request for the named tool.
func CallToolRequest(id any, name string, args any) (*mcpruntime.Request, error) {
	argsBytes, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	params, err := json.Marshal(map[string]any{
		"name":      name,
		"arguments": json.RawMessage(argsBytes),
	})
	if err != nil {
		return nil, err
	}
	return &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "tools/call",
		Params:  params,
	}, nil
}

// ListResourcesRequest builds a JSON-RPC resources/list request.
func ListResourcesRequest(id any) *mcpruntime.Request {
	return &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "resources/list",
	}
}

// ReadResourceRequest builds a JSON-RPC resources/read request for the given URI.
func ReadResourceRequest(id any, uri string) (*mcpruntime.Request, error) {
	params, err := json.Marshal(map[string]any{
		"uri": uri,
	})
	if err != nil {
		return nil, err
	}
	return &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "resources/read",
		Params:  params,
	}, nil
}

// ListPromptsRequest builds a JSON-RPC prompts/list request.
func ListPromptsRequest(id any) *mcpruntime.Request {
	return &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "prompts/list",
	}
}

// GetPromptRequest builds a JSON-RPC prompts/get request for the given name and arguments.
func GetPromptRequest(id any, name string, args any) (*mcpruntime.Request, error) {
	var argsRaw json.RawMessage
	if args != nil {
		b, err := json.Marshal(args)
		if err != nil {
			return nil, err
		}
		argsRaw = json.RawMessage(b)
	}

	params, err := json.Marshal(map[string]any{
		"name":      name,
		"arguments": argsRaw,
	})
	if err != nil {
		return nil, err
	}
	return &mcpruntime.Request{
		JSONRPC: "2.0",
		ID:      id,
		Method:  "prompts/get",
		Params:  params,
	}, nil
}
