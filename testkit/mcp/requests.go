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
