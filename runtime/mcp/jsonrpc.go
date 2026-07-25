package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Standard JSON-RPC 2.0 error codes.
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
	CodeServerError    = -32000

	// CodeHeaderMismatch identifies missing, malformed, or mismatched
	// 2026-07-28 Streamable HTTP routing headers.
	CodeHeaderMismatch = -32020
	// CodeMissingRequiredClientCapability identifies a 2026-07-28 request
	// whose per-request client capabilities cannot satisfy the result.
	CodeMissingRequiredClientCapability = -32021
	// CodeUnsupportedProtocolVersion identifies a request for a protocol
	// version that this server does not implement.
	CodeUnsupportedProtocolVersion = -32022
)

// ResultType identifies whether a 2026-07-28 result is final or requires
// another client-input round trip.
type ResultType string

const (
	ResultTypeComplete      ResultType = "complete"
	ResultTypeInputRequired ResultType = "input_required"
)

// jsonrpcVersion is the JSON-RPC protocol version string.
const jsonrpcVersion = "2.0"

// Request is a JSON-RPC 2.0 request message.
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
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
// It validates the required fields: jsonrpc must be "2.0" and method must be
// non-empty.
//
// This function accepts both JSON-RPC requests and notifications:
// - Requests include an "id" field.
// - Notifications omit the "id" field.
//
// If an "id" field is present, it MUST NOT be null.
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
	if idRaw, ok := raw["id"]; ok {
		if len(trimLeftSpace(idRaw)) == 0 || string(trimLeftSpace(idRaw)) == "null" {
			return nil, errors.New("id must not be null")
		}
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

// ParseResponse parses a single JSON-RPC 2.0 response from raw bytes.
//
// It validates:
// - jsonrpc must be "2.0"
// - id must be present (it may be null for certain error cases)
// - exactly one of result or error is present
func ParseResponse(data []byte) (*Response, error) {
	if len(data) == 0 {
		return nil, errors.New("empty response body")
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}

	if _, ok := raw["jsonrpc"]; !ok {
		return nil, errors.New("missing required field: jsonrpc")
	}
	if _, ok := raw["id"]; !ok {
		return nil, errors.New("missing required field: id")
	}
	_, hasResult := raw["result"]
	_, hasError := raw["error"]
	if hasResult == hasError {
		return nil, errors.New("response must have exactly one of result or error")
	}

	var resp Response
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	if resp.JSONRPC != jsonrpcVersion {
		return nil, fmt.Errorf("unsupported jsonrpc version: %s", resp.JSONRPC)
	}

	return &resp, nil
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

func marshalResultWithType(result any, resultType ResultType) ([]byte, error) {
	data, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("marshal result: %w", err)
	}
	var object map[string]json.RawMessage
	if unmarshalErr := json.Unmarshal(data, &object); unmarshalErr != nil || object == nil {
		return nil, errors.New("MCP result must be a JSON object")
	}
	encodedType, err := json.Marshal(resultType)
	if err != nil {
		return nil, fmt.Errorf("marshal resultType: %w", err)
	}
	object["resultType"] = encodedType
	return json.Marshal(object)
}

func requestProtocolVersionMetadata(req *Request) string {
	meta := requestMetadata(req)
	rawVersion, ok := meta[protocolVersionMetaKey]
	if !ok {
		return ""
	}
	var version string
	if err := json.Unmarshal(rawVersion, &version); err != nil {
		return ""
	}
	return strings.TrimSpace(version)
}

func requestMetadata(req *Request) map[string]json.RawMessage {
	if req == nil || len(req.Params) == 0 {
		return nil
	}
	var params struct {
		Meta map[string]json.RawMessage `json:"_meta"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return nil
	}
	return params.Meta
}

func missingRequiredClientCapabilities(req *Request, resp *Response) map[string]any {
	required := requiredClientCapabilities(resp)
	if len(required) == 0 {
		return nil
	}
	declared := declaredClientCapabilities(req)
	missing := missingCapabilityTree(required, declared)
	if len(missing) == 0 {
		return nil
	}
	return missing
}

func declaredClientCapabilities(req *Request) map[string]any {
	meta := requestMetadata(req)
	raw, ok := meta[clientCapabilitiesMetaKey]
	if !ok {
		return nil
	}
	var capabilities map[string]any
	if err := json.Unmarshal(raw, &capabilities); err != nil {
		return nil
	}
	return capabilities
}

func requiredClientCapabilities(resp *Response) map[string]any {
	if resp == nil || resp.Error != nil {
		return nil
	}
	var inputRequests map[string]InputRequest
	switch result := resp.Result.(type) {
	case InputRequiredResult:
		inputRequests = result.InputRequests
	case *InputRequiredResult:
		if result != nil {
			inputRequests = result.InputRequests
		}
	default:
		return nil
	}
	required := make(map[string]any)
	for _, request := range inputRequests {
		method := strings.TrimSpace(request.Method)
		firstSlash := strings.IndexByte(method, '/')
		if firstSlash <= 0 {
			continue
		}
		lastSlash := strings.LastIndexByte(method, '/')
		if firstSlash == lastSlash {
			required[method[:firstSlash]] = map[string]any{}
			continue
		}
		extensionIdentifier := method[:lastSlash]
		if validExtensionIdentifier(extensionIdentifier) {
			extensions, _ := required["extensions"].(map[string]any)
			if extensions == nil {
				extensions = map[string]any{}
				required["extensions"] = extensions
			}
			extensions[extensionIdentifier] = map[string]any{}
		}
	}
	if len(required) == 0 {
		return nil
	}
	return required
}

func missingCapabilityTree(required map[string]any, declared map[string]any) map[string]any {
	missing := make(map[string]any)
	for capability, rawRequired := range required {
		requiredChildren, _ := rawRequired.(map[string]any)
		rawDeclared, ok := declared[capability]
		declaredChildren, isObject := rawDeclared.(map[string]any)
		if !ok || !isObject {
			missing[capability] = cloneCapabilityRequirement(requiredChildren)
			continue
		}
		if len(requiredChildren) == 0 {
			continue
		}
		childMissing := missingCapabilityTree(requiredChildren, declaredChildren)
		if len(childMissing) > 0 {
			missing[capability] = childMissing
		}
	}
	return missing
}

func cloneCapabilityRequirement(required map[string]any) map[string]any {
	if len(required) == 0 {
		return map[string]any{}
	}
	cloned := make(map[string]any, len(required))
	for key, raw := range required {
		children, _ := raw.(map[string]any)
		cloned[key] = cloneCapabilityRequirement(children)
	}
	return cloned
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
