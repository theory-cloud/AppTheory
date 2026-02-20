package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Standard JSON-RPC 2.0 error codes.
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
	CodeServerError    = -32000
)

// jsonrpcVersion is the JSON-RPC protocol version string.
const jsonrpcVersion = "2.0"

// Request is a JSON-RPC 2.0 request message.
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response is a JSON-RPC 2.0 response message.
type Response struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id"`
	Result  any       `json:"result,omitempty"`
	Error   *RPCError `json:"error,omitempty"`
}

// RPCError is a JSON-RPC 2.0 error object.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// ParseRequest parses a single JSON-RPC 2.0 request from raw bytes.
// It validates the required fields: jsonrpc must be "2.0", method must be
// non-empty, and id must be present.
func ParseRequest(data []byte) (*Request, error) {
	if len(data) == 0 {
		return nil, errors.New("empty request body")
	}

	// Use a raw map first to check for required fields.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}

	// Validate required fields exist.
	if _, ok := raw["jsonrpc"]; !ok {
		return nil, errors.New("missing required field: jsonrpc")
	}
	if _, ok := raw["method"]; !ok {
		return nil, errors.New("missing required field: method")
	}
	if _, ok := raw["id"]; !ok {
		return nil, errors.New("missing required field: id")
	}

	var req Request
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, fmt.Errorf("failed to parse request: %w", err)
	}

	if req.JSONRPC != jsonrpcVersion {
		return nil, fmt.Errorf("unsupported jsonrpc version: %s", req.JSONRPC)
	}
	if req.Method == "" {
		return nil, errors.New("method must not be empty")
	}

	return &req, nil
}

// ParseBatchRequest parses a JSON-RPC batch request (array of requests) from
// raw bytes. If the input is a single object (not an array), it returns a
// slice containing that single parsed request.
func ParseBatchRequest(data []byte) ([]*Request, error) {
	if len(data) == 0 {
		return nil, errors.New("empty request body")
	}

	// Trim whitespace to detect array vs object.
	trimmed := trimLeftSpace(data)
	if len(trimmed) == 0 {
		return nil, errors.New("empty request body")
	}

	if trimmed[0] == '[' {
		// Batch request: array of raw messages.
		var rawMessages []json.RawMessage
		if err := json.Unmarshal(data, &rawMessages); err != nil {
			return nil, fmt.Errorf("invalid JSON array: %w", err)
		}
		if len(rawMessages) == 0 {
			return nil, errors.New("empty batch request")
		}

		requests := make([]*Request, 0, len(rawMessages))
		for i, raw := range rawMessages {
			req, err := ParseRequest(raw)
			if err != nil {
				return nil, fmt.Errorf("batch element %d: %w", i, err)
			}
			requests = append(requests, req)
		}
		return requests, nil
	}

	// Single request.
	req, err := ParseRequest(data)
	if err != nil {
		return nil, err
	}
	return []*Request{req}, nil
}

// MarshalResponse serializes a JSON-RPC 2.0 response to bytes.
// It ensures the jsonrpc field is always set to "2.0".
func MarshalResponse(resp *Response) ([]byte, error) {
	if resp == nil {
		return nil, errors.New("nil response")
	}
	// Ensure jsonrpc version is set.
	out := *resp
	out.JSONRPC = jsonrpcVersion
	return json.Marshal(out)
}

// NewErrorResponse creates a JSON-RPC error response with the given request ID
// and error details.
func NewErrorResponse(id any, code int, message string) *Response {
	return &Response{
		JSONRPC: jsonrpcVersion,
		ID:      id,
		Error: &RPCError{
			Code:    code,
			Message: message,
		},
	}
}

// NewResultResponse creates a JSON-RPC success response with the given request
// ID and result value.
func NewResultResponse(id any, result any) *Response {
	return &Response{
		JSONRPC: jsonrpcVersion,
		ID:      id,
		Result:  result,
	}
}

// trimLeftSpace trims leading whitespace bytes (space, tab, newline, carriage return).
func trimLeftSpace(data []byte) []byte {
	for i, b := range data {
		if b != ' ' && b != '\t' && b != '\n' && b != '\r' {
			return data[i:]
		}
	}
	return nil
}
