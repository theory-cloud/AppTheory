package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"pgregory.net/rapid"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

// newTestServer creates an MCP server with a single echo tool for testing.
func newTestServer() *Server {
	s := NewServer("test-server", "1.0.0")
	if err := s.registry.RegisterTool(
		ToolDef{
			Name:        "echo",
			Description: "Echoes input back",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`),
		},
		func(_ context.Context, args json.RawMessage) (*ToolResult, error) {
			var p struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return nil, err
			}
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: p.Message}}}, nil
		},
	); err != nil {
		panic(err)
	}
	return s
}

// invokeHandler sends a raw body to the MCP server handler and returns the
// apptheory.Response. Headers can be provided for Accept, Mcp-Session-Id, etc.
func invokeHandler(s *Server, body []byte, headers map[string][]string) (*apptheory.Response, error) {
	handler := s.Handler()
	app := apptheory.New()
	app.Post("/mcp", handler)

	if headers == nil {
		headers = map[string][]string{}
	}
	if _, ok := headers["content-type"]; !ok {
		headers["content-type"] = []string{"application/json"}
	}

	req := apptheory.Request{
		Method:  "POST",
		Path:    "/mcp",
		Headers: headers,
		Body:    body,
	}

	resp := app.Serve(context.Background(), req)
	return &resp, nil
}

// parseJSONRPCResponse parses a JSON-RPC response from an apptheory.Response body.
func parseJSONRPCResponse(resp *apptheory.Response) (*Response, error) {
	var rpcResp Response
	if err := json.Unmarshal(resp.Body, &rpcResp); err != nil {
		return nil, err
	}
	return &rpcResp, nil
}

// Feature: cloud-mcp-gateway, Property 6: Protocol Error Code Correctness
// Validates: Requirements 2.5, 2.6, 2.7
//
// For any malformed JSON input, the server SHALL return error code -32700.
// For any valid JSON-RPC request with an unrecognized method, the server SHALL
// return error code -32601. For any tools/call request with invalid arguments,
// the server SHALL return error code -32602.
func TestProperty6_ProtocolErrorCodeCorrectness(t *testing.T) {
	s := newTestServer()

	rapid.Check(t, func(t *rapid.T) {
		scenario := rapid.IntRange(0, 2).Draw(t, "scenario")

		switch scenario {
		case 0:
			// Malformed JSON → -32700
			garbage := rapid.SliceOfN(rapid.Byte(), 1, 64).Draw(t, "garbage")
			// Ensure it's not valid JSON by prepending an invalid byte.
			garbage = append([]byte{0xFF}, garbage...)

			resp, err := invokeHandler(s, garbage, nil)
			if err != nil {
				t.Fatalf("handler error: %v", err)
			}
			rpcResp, err := parseJSONRPCResponse(resp)
			if err != nil {
				t.Fatalf("failed to parse response: %v", err)
			}
			if rpcResp.Error == nil {
				t.Fatal("expected error response for malformed JSON")
			}
			if rpcResp.Error.Code != CodeParseError {
				t.Fatalf("expected error code %d, got %d", CodeParseError, rpcResp.Error.Code)
			}

		case 1:
			// Unknown method → -32601
			unknownMethod := "unknown/" + genAlphanumericString(1, 16).Draw(t, "method")
			reqID := genRequestID().Draw(t, "id")
			body, err := json.Marshal(Request{
				JSONRPC: "2.0",
				ID:      reqID,
				Method:  unknownMethod,
			})
			if err != nil {
				t.Fatalf("failed to marshal request: %v", err)
			}

			resp, err := invokeHandler(s, body, nil)
			if err != nil {
				t.Fatalf("handler error: %v", err)
			}
			rpcResp, err := parseJSONRPCResponse(resp)
			if err != nil {
				t.Fatalf("failed to parse response: %v", err)
			}
			if rpcResp.Error == nil {
				t.Fatalf("expected error response for unknown method %q", unknownMethod)
			}
			if rpcResp.Error.Code != CodeMethodNotFound {
				t.Fatalf("expected error code %d, got %d for method %q", CodeMethodNotFound, rpcResp.Error.Code, unknownMethod)
			}

		case 2:
			// Invalid params for tools/call → -32602
			reqID := genRequestID().Draw(t, "id")
			// Send tools/call with invalid params (not a valid JSON object for tool params).
			body, err := json.Marshal(Request{
				JSONRPC: "2.0",
				ID:      reqID,
				Method:  "tools/call",
				Params:  json.RawMessage(`"not an object"`),
			})
			if err != nil {
				t.Fatalf("failed to marshal request: %v", err)
			}

			resp, err := invokeHandler(s, body, nil)
			if err != nil {
				t.Fatalf("handler error: %v", err)
			}
			rpcResp, err := parseJSONRPCResponse(resp)
			if err != nil {
				t.Fatalf("failed to parse response: %v", err)
			}
			if rpcResp.Error == nil {
				t.Fatal("expected error response for invalid params")
			}
			if rpcResp.Error.Code != CodeInvalidParams {
				t.Fatalf("expected error code %d, got %d", CodeInvalidParams, rpcResp.Error.Code)
			}
		}
	})
}

// Feature: cloud-mcp-gateway, Property 7: Tool Handler Error Wrapping
// Validates: Requirements 8.1
//
// For any tool whose handler returns a Go error, invoking that tool via
// tools/call SHALL produce a JSON-RPC error response with code -32000 and
// a message containing the original error text.
func TestProperty7_ToolHandlerErrorWrapping(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		errMsg := genAlphanumericString(1, 64).Draw(t, "errorMessage")
		reqID := genRequestID().Draw(t, "id")

		s := NewServer("test-server", "1.0.0")
		if err := s.registry.RegisterTool(
			ToolDef{
				Name:        "failing_tool",
				Description: "Always fails",
				InputSchema: json.RawMessage(`{"type":"object"}`),
			},
			func(_ context.Context, _ json.RawMessage) (*ToolResult, error) {
				return nil, fmt.Errorf("%s", errMsg)
			},
		); err != nil {
			t.Fatalf("failed to register tool: %v", err)
		}

		params, err := json.Marshal(toolsCallParams{
			Name:      "failing_tool",
			Arguments: json.RawMessage(`{}`),
		})
		if err != nil {
			t.Fatalf("failed to marshal params: %v", err)
		}
		body, err := json.Marshal(Request{
			JSONRPC: "2.0",
			ID:      reqID,
			Method:  "tools/call",
			Params:  params,
		})
		if err != nil {
			t.Fatalf("failed to marshal request: %v", err)
		}

		resp, err := invokeHandler(s, body, nil)
		if err != nil {
			t.Fatalf("handler error: %v", err)
		}

		rpcResp, err := parseJSONRPCResponse(resp)
		if err != nil {
			t.Fatalf("failed to parse response: %v", err)
		}

		if rpcResp.Error == nil {
			t.Fatal("expected error response for failing tool")
		}
		if rpcResp.Error.Code != CodeServerError {
			t.Fatalf("expected error code %d, got %d", CodeServerError, rpcResp.Error.Code)
		}
		if rpcResp.Error.Message != errMsg {
			t.Fatalf("error message mismatch: got %q, want %q", rpcResp.Error.Message, errMsg)
		}
	})
}

// Feature: cloud-mcp-gateway, Property 10: Response Format Matches Accept Header
// Validates: Requirements 5.1, 5.4
//
// For any valid tools/call request, when the Accept header is text/event-stream
// the response content type SHALL be text/event-stream, and when the Accept
// header is application/json (or absent) the response content type SHALL be
// application/json.
func TestProperty10_ResponseFormatMatchesAcceptHeader(t *testing.T) {
	s := newTestServer()

	rapid.Check(t, func(t *rapid.T) {
		reqID := genRequestID().Draw(t, "id")
		acceptType := rapid.SampledFrom([]string{
			"text/event-stream",
			"application/json",
			"", // absent
		}).Draw(t, "accept")

		params, err := json.Marshal(toolsCallParams{
			Name:      "echo",
			Arguments: json.RawMessage(`{"message":"hello"}`),
		})
		if err != nil {
			t.Fatalf("failed to marshal params: %v", err)
		}
		body, err := json.Marshal(Request{
			JSONRPC: "2.0",
			ID:      reqID,
			Method:  "tools/call",
			Params:  params,
		})
		if err != nil {
			t.Fatalf("failed to marshal request: %v", err)
		}

		headers := map[string][]string{
			"content-type": {"application/json"},
		}
		if acceptType != "" {
			headers["accept"] = []string{acceptType}
		}

		resp, err := invokeHandler(s, body, headers)
		if err != nil {
			t.Fatalf("handler error: %v", err)
		}

		ct := ""
		if vals, ok := resp.Headers["content-type"]; ok && len(vals) > 0 {
			ct = vals[0]
		}

		if acceptType == "text/event-stream" {
			if ct != "text/event-stream" {
				t.Fatalf("expected content-type text/event-stream, got %q", ct)
			}
		} else {
			// application/json or absent → expect JSON
			if ct != "application/json" && ct != "application/json; charset=utf-8" {
				t.Fatalf("expected content-type application/json, got %q", ct)
			}
		}
	})
}

// Feature: cloud-mcp-gateway, Property 11: Batch Request Handling
// Validates: Requirements 7.5
//
// For any array of N valid JSON-RPC requests (N > 0), sending them as a batch
// SHALL produce an array of exactly N responses, where each response's id
// matches the corresponding request's id.
func TestProperty11_BatchRequestHandling(t *testing.T) {
	s := newTestServer()

	rapid.Check(t, func(t *rapid.T) {
		n := rapid.IntRange(1, 10).Draw(t, "batchSize")

		// Build N requests with unique IDs.
		requests := make([]Request, n)
		for i := range n {
			method := rapid.SampledFrom([]string{"initialize", "tools/list"}).Draw(t, fmt.Sprintf("method_%d", i))
			requests[i] = Request{
				JSONRPC: "2.0",
				ID:      i + 1, // sequential integer IDs
				Method:  method,
			}
		}

		body, err := json.Marshal(requests)
		if err != nil {
			t.Fatalf("failed to marshal batch: %v", err)
		}

		resp, err := invokeHandler(s, body, nil)
		if err != nil {
			t.Fatalf("handler error: %v", err)
		}

		// Parse the batch response.
		var responses []Response
		if err := json.Unmarshal(resp.Body, &responses); err != nil {
			t.Fatalf("failed to parse batch response: %v (body: %s)", err, resp.Body)
		}

		if len(responses) != n {
			t.Fatalf("expected %d responses, got %d", n, len(responses))
		}

		for i, rpcResp := range responses {
			// Verify jsonrpc version.
			if rpcResp.JSONRPC != "2.0" {
				t.Fatalf("response[%d] jsonrpc: got %q, want %q", i, rpcResp.JSONRPC, "2.0")
			}

			// Verify ID matches. JSON numbers unmarshal as float64.
			expectedID := float64(i + 1)
			gotID, ok := rpcResp.ID.(float64)
			if !ok {
				t.Fatalf("response[%d] id type: got %T, want float64", i, rpcResp.ID)
			}
			if gotID != expectedID {
				t.Fatalf("response[%d] id: got %v, want %v", i, gotID, expectedID)
			}

			// Each response must have exactly one of result or error.
			hasResult := rpcResp.Result != nil
			hasError := rpcResp.Error != nil
			if hasResult == hasError {
				t.Fatalf("response[%d] must have exactly one of result or error", i)
			}
		}
	})
}
