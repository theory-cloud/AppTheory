package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestServerHTTPHandlers_CoverageBranches(t *testing.T) {
	t.Run("POST rejects forbidden origin", func(t *testing.T) {
		s := NewServer("test", "dev", WithOriginValidator(nil))

		body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodInitialize})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, map[string][]string{
			"origin": {"https://evil.example"},
		})
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 403 {
			t.Fatalf("status: got %d want %d", resp.Status, 403)
		}
	})

	t.Run("POST invalid JSON-RPC message returns 400", func(t *testing.T) {
		s := NewServer("test", "dev")
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", []byte(`{}`), nil)
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 400 {
			t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 400, string(resp.Body))
		}
	})

	t.Run("POST request parse error returns JSON-RPC parse error", func(t *testing.T) {
		s := NewServer("test", "dev")

		// Valid JSON object with method, but invalid JSON-RPC request (missing jsonrpc).
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", []byte(`{"id":1,"method":"`+methodToolsList+`"}`), nil)
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 200 {
			t.Fatalf("status: got %d want %d", resp.Status, 200)
		}
		rpcResp, parseErr := parseJSONRPCResponse(resp)
		if parseErr != nil {
			t.Fatalf("parse: %v", parseErr)
		}
		if rpcResp.Error == nil || rpcResp.Error.Code != CodeParseError {
			t.Fatalf("expected parse error, got: %+v", rpcResp.Error)
		}
	})

	t.Run("POST request missing session returns 400", func(t *testing.T) {
		s := NewServer("test", "dev")

		body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsList})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, nil)
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 400 {
			t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 400, string(resp.Body))
		}
	})

	t.Run("POST request unsupported protocol version returns 400", func(t *testing.T) {
		s := NewServer("test", "dev")
		sessionID := initializeSession(t, s)

		headers := sessionHeaders(sessionID)
		headers[headerMcpProtocolVersion] = []string{"not-a-real-version"}
		body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsList})

		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 400 {
			t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 400, string(resp.Body))
		}
	})

	t.Run("POST response missing session returns 400", func(t *testing.T) {
		s := NewServer("test", "dev")

		body := mustMarshal(t, Response{JSONRPC: "2.0", ID: 1, Result: map[string]any{"ok": true}})
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, nil)
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 400 {
			t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 400, string(resp.Body))
		}
	})

	t.Run("POST response unsupported protocol version returns 400", func(t *testing.T) {
		s := NewServer("test", "dev")
		sessionID := initializeSession(t, s)

		headers := sessionHeaders(sessionID)
		headers[headerMcpProtocolVersion] = []string{"not-a-real-version"}
		body := mustMarshal(t, Response{JSONRPC: "2.0", ID: 1, Result: map[string]any{"ok": true}})

		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 400 {
			t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 400, string(resp.Body))
		}
	})

	t.Run("GET rejects forbidden origin", func(t *testing.T) {
		s := NewServer("test", "dev", WithOriginValidator(nil))
		resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, map[string][]string{
			"origin": {"https://evil.example"},
		})
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 403 {
			t.Fatalf("status: got %d want %d", resp.Status, 403)
		}
	})

	t.Run("GET missing session returns 400", func(t *testing.T) {
		s := NewServer("test", "dev")
		resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, nil)
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 400 {
			t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 400, string(resp.Body))
		}
	})

	t.Run("GET unsupported protocol version returns 400", func(t *testing.T) {
		s := NewServer("test", "dev")
		sessionID := initializeSession(t, s)

		headers := sessionHeaders(sessionID)
		headers[headerMcpProtocolVersion] = []string{"not-a-real-version"}

		resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, headers)
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 400 {
			t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 400, string(resp.Body))
		}
	})

	t.Run("GET subscribe generic error returns 500", func(t *testing.T) {
		s := NewServer("test", "dev")
		sessionID := initializeSession(t, s)

		s.streamStore = configurableStreamStore{
			streamForEvent: func(context.Context, string, string) (string, error) {
				return "stream-1", nil
			},
			subscribe: func(context.Context, string, string, string) (<-chan StreamEvent, error) {
				return nil, errors.New("subscribe failed")
			},
		}

		headers := sessionHeaders(sessionID)
		headers[headerLastEventID] = []string{"1"}

		resp, err := invokeHandlerWithMethod(context.Background(), s, "GET", nil, headers)
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 500 {
			t.Fatalf("status: got %d want %d", resp.Status, 500)
		}
	})

	t.Run("DELETE rejects forbidden origin", func(t *testing.T) {
		s := NewServer("test", "dev", WithOriginValidator(nil))
		resp, err := invokeHandlerWithMethod(context.Background(), s, "DELETE", nil, map[string][]string{
			"origin": {"https://evil.example"},
		})
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 403 {
			t.Fatalf("status: got %d want %d", resp.Status, 403)
		}
	})

	t.Run("POST batch with only notifications returns 202", func(t *testing.T) {
		s := NewServer("test", "dev")
		resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", []byte(`[{"jsonrpc":"2.0","method":"`+methodPing+`"}]`), nil)
		if err != nil {
			t.Fatalf("invoke: %v", err)
		}
		if resp.Status != 202 {
			t.Fatalf("status: got %d want %d (body=%s)", resp.Status, 202, string(resp.Body))
		}
	})
}

func TestServerHelpersAndInternalBranches(t *testing.T) {
	t.Run("dispatch initialize and ping", func(t *testing.T) {
		s := NewServer("test", "dev")

		initResp := s.dispatch(context.Background(), &Request{JSONRPC: "2.0", ID: 1, Method: methodInitialize})
		if initResp.Error != nil {
			t.Fatalf("initialize: unexpected error: %+v", initResp.Error)
		}

		pingResp := s.dispatch(context.Background(), &Request{JSONRPC: "2.0", ID: 2, Method: methodPing})
		if pingResp.Error != nil {
			t.Fatalf("ping: unexpected error: %+v", pingResp.Error)
		}
	})

	t.Run("handleInitialize includes resources/prompts when registries non-empty", func(t *testing.T) {
		s := NewServer("test", "dev")

		if err := s.Resources().RegisterResource(ResourceDef{URI: "file://x", Name: "x"}, func(context.Context) ([]ResourceContent, error) {
			return nil, nil
		}); err != nil {
			t.Fatalf("register resource: %v", err)
		}
		if err := s.Prompts().RegisterPrompt(PromptDef{Name: "p"}, func(context.Context, json.RawMessage) (*PromptResult, error) {
			return &PromptResult{}, nil
		}); err != nil {
			t.Fatalf("register prompt: %v", err)
		}

		resp := s.handleInitialize(&Request{JSONRPC: "2.0", ID: 1, Method: methodInitialize}, protocolVersion)
		result, ok := resp.Result.(map[string]any)
		if !ok {
			t.Fatalf("expected initialize result to be an object, got %T", resp.Result)
		}
		caps, ok := result["capabilities"].(map[string]any)
		if !ok {
			t.Fatalf("expected capabilities object, got %T", result["capabilities"])
		}
		if _, ok := caps["resources"]; !ok {
			t.Fatalf("expected resources capability when resources registry is non-empty")
		}
		if _, ok := caps["prompts"]; !ok {
			t.Fatalf("expected prompts capability when prompts registry is non-empty")
		}
	})

	t.Run("handleToolsCall missing tool name", func(t *testing.T) {
		s := NewServer("test", "dev")
		resp := s.handleToolsCall(context.Background(), &Request{
			JSONRPC: "2.0",
			ID:      1,
			Method:  methodToolsCall,
			Params:  json.RawMessage(`{"name":""}`),
		})
		if resp.Error == nil || resp.Error.Code != CodeInvalidParams {
			t.Fatalf("expected invalid params error, got: %+v", resp.Error)
		}
	})

	t.Run("parseJSONObject empty body errors", func(t *testing.T) {
		if _, err := parseJSONObject(nil); err == nil {
			t.Fatalf("expected parseJSONObject to error for empty body")
		}
	})

	t.Run("validateOrigin allow path returns nil", func(t *testing.T) {
		s := NewServer("test", "dev", WithOriginValidator(func(string) bool { return true }))
		if resp := s.validateOrigin(map[string][]string{"origin": {"https://ok.example"}}); resp != nil {
			t.Fatalf("expected allowed origin to return nil response")
		}
	})

	t.Run("requireProtocolVersion allows absent header", func(t *testing.T) {
		s := NewServer("test", "dev")
		if resp := s.requireProtocolVersion(map[string][]string{}, &Session{Data: map[string]string{"protocolVersion": protocolVersion}}); resp != nil {
			t.Fatalf("expected absent protocol header to be allowed")
		}
	})

	t.Run("handleInitializeHTTP returns invalid params response", func(t *testing.T) {
		s := NewServer("test", "dev")
		resp, err := s.handleInitializeHTTP(context.Background(), &Request{
			JSONRPC: "2.0",
			ID:      1,
			Method:  methodInitialize,
			Params:  json.RawMessage("{"),
		})
		if err != nil {
			t.Fatalf("handleInitializeHTTP: %v", err)
		}
		rpcResp, parseErr := parseJSONRPCResponse(resp)
		if parseErr != nil {
			t.Fatalf("parse: %v", parseErr)
		}
		if rpcResp.Error == nil || rpcResp.Error.Code != CodeInvalidParams {
			t.Fatalf("expected invalid params error, got: %+v", rpcResp.Error)
		}
	})

	t.Run("negotiateInitializeProtocolVersion empty and supported values", func(t *testing.T) {
		s := NewServer("test", "dev")

		pv, errResp := s.negotiateInitializeProtocolVersion(&Request{ID: 1, Params: json.RawMessage(`{"protocolVersion":""}`)})
		if errResp != nil || pv != protocolVersion {
			t.Fatalf("expected default protocolVersion, got pv=%q err=%+v", pv, errResp)
		}

		pv, errResp = s.negotiateInitializeProtocolVersion(&Request{ID: 1, Params: json.RawMessage(`{"protocolVersion":"` + protocolVersionLegacy + `"}`)})
		if errResp != nil || pv != protocolVersionLegacy {
			t.Fatalf("expected legacy protocolVersion, got pv=%q err=%+v", pv, errResp)
		}
	})

	t.Run("handleInitializeBatch createSession error", func(t *testing.T) {
		s := NewServer("test", "dev", WithSessionStore(stubSessionStore{
			put: func(context.Context, *Session) error {
				return errors.New("put failed")
			},
		}))

		_, sess, errResp := s.handleInitializeBatch(context.Background(), &Request{JSONRPC: "2.0", ID: 1, Method: methodInitialize})
		if sess != nil {
			t.Fatalf("expected nil session on failure")
		}
		if errResp == nil || errResp.Error == nil || errResp.Error.Code != CodeInternalError {
			t.Fatalf("expected internal error response, got: %+v", errResp)
		}
	})

	t.Run("handleNotification initializes Data and tolerates Put error", func(t *testing.T) {
		s := NewServer("test", "dev", WithSessionStore(stubSessionStore{
			put: func(context.Context, *Session) error {
				return errors.New("put failed")
			},
		}))
		sess := &Session{ID: "s1"}
		s.handleNotification(context.Background(), sess, &Request{Method: methodNotificationsInitialized})
		if sess.Data == nil || sess.Data["initialized"] != sessionInitializedValue {
			t.Fatalf("expected initialized flag to be set, got: %+v", sess.Data)
		}
	})

	t.Run("progressFromSSEEvent fallback branches", func(t *testing.T) {
		progress, total, message := progressFromSSEEvent(SSEEvent{Data: map[string]any{"progress": "nope", "seq": "also-nope"}}, 7)
		if progress != 7 || total != nil || message != "" {
			t.Fatalf("unexpected fallback: progress=%v total=%v message=%q", progress, total, message)
		}

		progress, total, message = progressFromSSEEvent(SSEEvent{Data: 123}, 7)
		if progress != 7 || total != nil || message != "123" {
			t.Fatalf("unexpected default formatting: progress=%v total=%v message=%q", progress, total, message)
		}
	})
}
