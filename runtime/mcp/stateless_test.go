package mcp

import (
	"context"
	"encoding/json"
	"testing"
)

type countingServerIDGenerator struct {
	count int
}

func (g *countingServerIDGenerator) NewID() string {
	g.count++
	return "session-after-stateless"
}

func TestStateless20260728DoesNotCreateOrRequireSession(t *testing.T) {
	ids := &countingServerIDGenerator{}
	s := NewServer("test", "dev", WithServerIDGenerator(ids))
	headers := map[string][]string{
		headerMcpProtocolVersion: {ProtocolVersion20260728},
		headerMcpMethod:          {methodServerDiscover},
	}

	pingBody := mustMarshal(t, Request{
		JSONRPC: jsonrpcVersion,
		ID:      "discover",
		Method:  methodServerDiscover,
		Params: json.RawMessage(
			`{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`,
		),
	})
	pingResp, err := invokeHandler(s, pingBody, headers)
	if err != nil {
		t.Fatalf("invoke stateless ping: %v", err)
	}
	if pingResp.Status != 200 {
		t.Fatalf("ping status = %d, body = %s", pingResp.Status, pingResp.Body)
	}
	if got := firstHeader(pingResp.Headers, headerMcpSessionID); got != "" {
		t.Fatalf("stateless ping returned session id %q", got)
	}
	if ids.count != 0 {
		t.Fatalf("stateless ping generated %d ids", ids.count)
	}

	initializeBody := mustMarshal(t, Request{
		JSONRPC: jsonrpcVersion,
		ID:      "initialize",
		Method:  methodInitialize,
		Params: json.RawMessage(
			`{"protocolVersion":"2026-07-28","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`,
		),
	})
	headers[headerMcpMethod] = []string{methodInitialize}
	initializeResp, err := invokeHandler(s, initializeBody, headers)
	if err != nil {
		t.Fatalf("invoke stateless initialize: %v", err)
	}
	if got := firstHeader(initializeResp.Headers, headerMcpSessionID); got != "" {
		t.Fatalf("stateless initialize returned session id %q", got)
	}
	rpcResp, err := parseJSONRPCResponse(initializeResp)
	if err != nil {
		t.Fatalf("parse stateless initialize response: %v", err)
	}
	if rpcResp.Error == nil || rpcResp.Error.Code != CodeMethodNotFound {
		t.Fatalf("stateless initialize error = %#v", rpcResp.Error)
	}
	if ids.count != 0 {
		t.Fatalf("stateless initialize generated %d ids", ids.count)
	}

	deleteResp, err := invokeHandlerWithMethod(context.Background(), s, "DELETE", nil, headers)
	if err != nil {
		t.Fatalf("invoke stateless delete: %v", err)
	}
	if deleteResp.Status != 405 {
		t.Fatalf("delete status = %d, body = %s", deleteResp.Status, deleteResp.Body)
	}

	if sessionID := initializeSession(t, s); sessionID != "session-after-stateless" {
		t.Fatalf("legacy session id = %q", sessionID)
	}
	if ids.count != 1 {
		t.Fatalf("legacy initialize generated %d ids", ids.count)
	}
}
