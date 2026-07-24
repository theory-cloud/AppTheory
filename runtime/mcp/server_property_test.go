package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"

	"pgregory.net/rapid"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
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

// invokeHandlerWithMethod sends a raw body to the MCP server handler and returns the
// apptheory.Response. Headers can be provided for Accept, Mcp-Session-Id, etc.
func invokeHandlerWithMethod(ctx context.Context, s *Server, method string, body []byte, headers map[string][]string) (*apptheory.Response, error) {
	handler := s.Handler()
	app := apptheory.New()
	app.Post("/mcp", handler)
	app.Get("/mcp", handler)
	app.Delete("/mcp", handler)

	if headers == nil {
		headers = map[string][]string{}
	}
	if method == "POST" {
		if _, ok := headers["content-type"]; !ok {
			headers["content-type"] = []string{"application/json"}
		}
		if _, ok := headers["accept"]; !ok {
			headers["accept"] = []string{"application/json, text/event-stream"}
		}
	}

	req := apptheory.Request{
		Method:  method,
		Path:    "/mcp",
		Headers: headers,
		Body:    body,
	}

	resp := app.Serve(ctx, req)
	return &resp, nil
}

func invokeHandler(s *Server, body []byte, headers map[string][]string) (*apptheory.Response, error) {
	return invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
}

// parseJSONRPCResponse parses a JSON-RPC response from an apptheory.Response body.
func parseJSONRPCResponse(resp *apptheory.Response) (*Response, error) {
	var rpcResp Response
	if err := json.Unmarshal(resp.Body, &rpcResp); err != nil {
		return nil, err
	}
	return &rpcResp, nil
}

type tbFatalf interface {
	Fatalf(format string, args ...any)
}

func initializeSession(t tbFatalf, s *Server) string {
	return initializeSessionWithProtocol(t, s, "")
}

func initializeSessionWithProtocol(t tbFatalf, s *Server, requestedProtocolVersion string) string {
	if h, ok := any(t).(interface{ Helper() }); ok {
		h.Helper()
	}

	var params json.RawMessage
	if requestedProtocolVersion != "" {
		paramsBytes, err := json.Marshal(map[string]any{"protocolVersion": requestedProtocolVersion})
		if err != nil {
			t.Fatalf("marshal initialize params: %v", err)
		}
		params = paramsBytes
	}

	body, err := json.Marshal(Request{JSONRPC: "2.0", ID: 1, Method: "initialize", Params: params})
	if err != nil {
		t.Fatalf("marshal initialize: %v", err)
	}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, map[string][]string{
		"content-type": {"application/json"},
		"accept":       {"application/json, text/event-stream"},
	})
	if err != nil {
		t.Fatalf("invoke initialize: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("initialize status: got %d, want %d (body: %s)", resp.Status, 200, resp.Body)
	}
	ids := resp.Headers["mcp-session-id"]
	if len(ids) == 0 || ids[0] == "" {
		t.Fatalf("expected mcp-session-id header on initialize response")
	}
	return ids[0]
}

func sessionHeaders(sessionID string) map[string][]string {
	return map[string][]string{
		"content-type":         {"application/json"},
		"mcp-session-id":       {sessionID},
		"mcp-protocol-version": {protocolVersion},
	}
}

func sseSessionHeaders(sessionID string) map[string][]string {
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}
	return headers
}

func TestToolsCallBuffered_PanicReturnsInternalError(t *testing.T) {
	s := NewServer("test-server", "1.0.0")
	sessionID := initializeSession(t, s)

	if err := s.registry.RegisterTool(
		ToolDef{
			Name:        "panic_tool",
			Description: "Panics during buffered execution",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(context.Context, json.RawMessage) (*ToolResult, error) {
			panic("boom")
		},
	); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	body := mustMarshal(t, Request{
		JSONRPC: "2.0",
		ID:      1,
		Method:  methodToolsCall,
		Params:  mustMarshal(t, toolsCallParams{Name: "panic_tool", Arguments: json.RawMessage(`{}`)}),
	})

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, sessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("status: got %d want 200", resp.Status)
	}
	if strings.Contains(string(resp.Body), "boom") {
		t.Fatalf("panic text leaked into response: %s", string(resp.Body))
	}
	rpcResp, parseErr := parseJSONRPCResponse(resp)
	if parseErr != nil {
		t.Fatalf("parse: %v", parseErr)
	}
	if rpcResp.Error == nil || rpcResp.Error.Code != CodeInternalError || rpcResp.Error.Message != "internal error" {
		t.Fatalf("expected sanitized internal error, got: %+v", rpcResp.Error)
	}

	listBody := mustMarshal(t, Request{JSONRPC: "2.0", ID: 2, Method: methodToolsList})
	resp, err = invokeHandlerWithMethod(context.Background(), s, "POST", listBody, sessionHeaders(sessionID))
	if err != nil {
		t.Fatalf("invoke after panic: %v", err)
	}
	if resp.Status != 200 {
		t.Fatalf("status after panic: got %d want 200", resp.Status)
	}
	rpcResp, parseErr = parseJSONRPCResponse(resp)
	if parseErr != nil {
		t.Fatalf("parse after panic: %v", parseErr)
	}
	if rpcResp.Error != nil {
		t.Fatalf("expected server to remain reusable, got error: %+v", rpcResp.Error)
	}
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
			sessionID := initializeSession(t, s)

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

			headers := sessionHeaders(sessionID)
			headers["accept"] = []string{"application/json, text/event-stream"}

			resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
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
			sessionID := initializeSession(t, s)

			// Invalid params for tools/call → -32602
			reqID := genRequestID().Draw(t, "id")
			// Send tools/call with invalid params (not a valid JSON object for tool params).
			body, err := json.Marshal(Request{
				JSONRPC: "2.0",
				ID:      reqID,
				Method:  methodToolsCall,
				Params:  json.RawMessage(`"not an object"`),
			})
			if err != nil {
				t.Fatalf("failed to marshal request: %v", err)
			}

			headers := sessionHeaders(sessionID)
			headers["accept"] = []string{"application/json, text/event-stream"}

			resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
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
			Method:  methodToolsCall,
			Params:  params,
		})
		if err != nil {
			t.Fatalf("failed to marshal request: %v", err)
		}

		sessionID := initializeSession(t, s)
		headers := sessionHeaders(sessionID)
		headers["accept"] = []string{"application/json, text/event-stream"}

		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
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

// Feature: cloud-mcp-gateway, Property 10: Response Format Matches Streaming Support
// Validates: Requirements 5.1, 5.4
//
// For any valid tools/call request with the strict Streamable HTTP Accept
// header, AppTheory SHALL return SSE only for tools registered with streaming
// support. Non-streaming tools return buffered JSON even though the client also
// advertises text/event-stream support.
func TestProperty10_ResponseFormatMatchesStreamingSupport(t *testing.T) {
	s := newTestServer()
	if err := s.registry.RegisterStreamingTool(
		ToolDef{
			Name:        "stream_echo",
			Description: "Streams echo input back",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`),
		},
		func(_ context.Context, args json.RawMessage, _ func(SSEEvent)) (*ToolResult, error) {
			var p struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return nil, err
			}
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: p.Message}}}, nil
		},
	); err != nil {
		t.Fatalf("failed to register streaming tool: %v", err)
	}

	rapid.Check(t, func(t *rapid.T) {
		sessionID := initializeSession(t, s)

		reqID := genRequestID().Draw(t, "id")
		streaming := rapid.Bool().Draw(t, "streaming")
		toolName := "echo"
		if streaming {
			toolName = "stream_echo"
		}

		params, err := json.Marshal(toolsCallParams{
			Name:      toolName,
			Arguments: json.RawMessage(`{"message":"hello"}`),
		})
		if err != nil {
			t.Fatalf("failed to marshal params: %v", err)
		}
		body, err := json.Marshal(Request{
			JSONRPC: "2.0",
			ID:      reqID,
			Method:  methodToolsCall,
			Params:  params,
		})
		if err != nil {
			t.Fatalf("failed to marshal request: %v", err)
		}

		headers := sessionHeaders(sessionID)
		headers["accept"] = []string{"application/json, text/event-stream"}

		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
		if err != nil {
			t.Fatalf("handler error: %v", err)
		}
		if resp.BodyReader != nil {
			if _, readErr := io.ReadAll(resp.BodyReader); readErr != nil {
				t.Fatalf("read streaming response: %v", readErr)
			}
		}

		ct := ""
		if vals, ok := resp.Headers["content-type"]; ok && len(vals) > 0 {
			ct = vals[0]
		}

		if streaming {
			if ct != "text/event-stream" {
				t.Fatalf("expected content-type text/event-stream, got %q", ct)
			}
		} else {
			if ct != "application/json" && ct != "application/json; charset=utf-8" {
				t.Fatalf("expected content-type application/json, got %q", ct)
			}
		}
	})
}

func TestToolsCall_AcceptsNumericProgressToken(t *testing.T) {
	s := newTestServer()
	sessionID := initializeSession(t, s)

	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello"},"_meta":{"progressToken":123}}}`)
	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}

	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if rpcResp.Error != nil {
		t.Fatalf("expected success response, got error: %+v", rpcResp.Error)
	}

	resultBytes, err := json.Marshal(rpcResp.Result)
	if err != nil {
		t.Fatalf("failed to marshal result: %v", err)
	}

	var toolRes ToolResult
	if err := json.Unmarshal(resultBytes, &toolRes); err != nil {
		t.Fatalf("failed to parse tool result: %v (result: %s)", err, resultBytes)
	}
	if len(toolRes.Content) != 1 {
		t.Fatalf("expected 1 content block, got %d", len(toolRes.Content))
	}
	if toolRes.Content[0].Text != "hello" {
		t.Fatalf("content mismatch: got %q, want %q", toolRes.Content[0].Text, "hello")
	}
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
			method := rapid.SampledFrom([]string{methodInitialize, methodToolsList}).Draw(t, fmt.Sprintf("method_%d", i))
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
