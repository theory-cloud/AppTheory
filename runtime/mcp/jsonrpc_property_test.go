package mcp

import (
	"encoding/json"
	"testing"

	"pgregory.net/rapid"
)

// Feature: cloud-mcp-gateway, Property 2: Tool Definition Serialization Round-Trip
// Validates: Requirements 7.3
//
// For any valid ToolDef struct, serializing it to JSON and deserializing back
// SHALL produce a ToolDef that is deeply equal to the original.
func TestProperty2_ToolDefSerializationRoundTrip(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		original := genToolDef().Draw(t, "toolDef")

		// Marshal to JSON.
		data, err := json.Marshal(original)
		if err != nil {
			t.Fatalf("marshal failed: %v", err)
		}

		// Unmarshal back.
		var roundTripped ToolDef
		if err := json.Unmarshal(data, &roundTripped); err != nil {
			t.Fatalf("unmarshal failed: %v", err)
		}

		// Verify name matches.
		if roundTripped.Name != original.Name {
			t.Fatalf("name mismatch: got %q, want %q", roundTripped.Name, original.Name)
		}

		// Verify description matches.
		if roundTripped.Description != original.Description {
			t.Fatalf("description mismatch: got %q, want %q", roundTripped.Description, original.Description)
		}

		// Verify inputSchema matches by comparing normalized JSON.
		if !jsonEqual(original.InputSchema, roundTripped.InputSchema) {
			t.Fatalf("inputSchema mismatch:\n  got:  %s\n  want: %s", roundTripped.InputSchema, original.InputSchema)
		}
	})
}

// Feature: cloud-mcp-gateway, Property 1: JSON-RPC Response Invariant
// Validates: Requirements 2.8, 2.9, 7.4
//
// For any valid JSON-RPC 2.0 request, the response SHALL be a valid JSON-RPC
// 2.0 message containing the same id as the request, a jsonrpc field equal to
// "2.0", and exactly one of result or error.
func TestProperty1_JSONRPCResponseInvariant(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Generate a random valid JSON-RPC request.
		reqID := genRequestID().Draw(t, "id")
		method := rapid.SampledFrom([]string{"initialize", "tools/list", "tools/call", "unknown/method"}).Draw(t, "method")

		reqBytes, err := json.Marshal(Request{
			JSONRPC: "2.0",
			ID:      reqID,
			Method:  method,
		})
		if err != nil {
			t.Fatalf("failed to marshal request: %v", err)
		}

		// Parse the request to verify round-trip.
		parsed, err := ParseRequest(reqBytes)
		if err != nil {
			t.Fatalf("ParseRequest failed on valid input: %v", err)
		}

		// Build a response (either success or error, randomly).
		isError := rapid.Bool().Draw(t, "isError")
		var resp *Response
		if isError {
			code := rapid.SampledFrom([]int{
				CodeParseError, CodeInvalidRequest, CodeMethodNotFound,
				CodeInvalidParams, CodeInternalError, CodeServerError,
			}).Draw(t, "errorCode")
			resp = NewErrorResponse(parsed.ID, code, "test error")
		} else {
			resp = NewResultResponse(parsed.ID, map[string]string{"status": "ok"})
		}

		// Marshal the response.
		data, err := MarshalResponse(resp)
		if err != nil {
			t.Fatalf("MarshalResponse failed: %v", err)
		}

		// Unmarshal and verify invariants.
		var decoded Response
		if unmarshalErr := json.Unmarshal(data, &decoded); unmarshalErr != nil {
			t.Fatalf("failed to unmarshal response: %v", unmarshalErr)
		}

		// Invariant 1: jsonrpc must be "2.0".
		if decoded.JSONRPC != "2.0" {
			t.Fatalf("jsonrpc field: got %q, want %q", decoded.JSONRPC, "2.0")
		}

		// Invariant 2: id must match the request id.
		decodedID, err := json.Marshal(decoded.ID)
		if err != nil {
			t.Fatalf("failed to marshal decoded id: %v", err)
		}
		originalID, err := json.Marshal(reqID)
		if err != nil {
			t.Fatalf("failed to marshal original id: %v", err)
		}
		if string(decodedID) != string(originalID) {
			t.Fatalf("id mismatch: got %s, want %s", decodedID, originalID)
		}

		// Invariant 3: exactly one of result or error must be present.
		hasResult := decoded.Result != nil
		hasError := decoded.Error != nil
		if hasResult == hasError {
			t.Fatalf("response must have exactly one of result or error, got result=%v error=%v", hasResult, hasError)
		}
	})
}
