package mcp

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestHandleDiscoverAdvertisesTruthfulSurface(t *testing.T) {
	t.Parallel()

	s := NewServer("discover-server", "2.0.0")
	if err := s.Registry().RegisterTool(ToolDef{
		Name:        "echo",
		InputSchema: []byte(`{"type":"object"}`),
	}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{}, nil
	}); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	resp := s.handleDiscover(&Request{JSONRPC: jsonrpcVersion, ID: "discover", Method: methodServerDiscover})
	result, ok := resp.Result.(DiscoverResult)
	if !ok {
		t.Fatalf("discover result type = %T, want DiscoverResult", resp.Result)
	}

	wantVersions := []string{
		ProtocolVersion20260728,
		protocolVersion,
		protocolVersionPrior,
		protocolVersionLegacy,
	}
	if !reflect.DeepEqual(result.SupportedVersions, wantVersions) {
		t.Fatalf("supported versions = %#v, want %#v", result.SupportedVersions, wantVersions)
	}
	if _, ok := result.Capabilities["tools"]; !ok {
		t.Fatalf("discover capabilities = %#v, want tools", result.Capabilities)
	}
	if _, ok := result.Capabilities["subscriptions"]; ok {
		t.Fatalf("discover capabilities advertised subscriptions: %#v", result.Capabilities)
	}
	if got := result.Meta[serverInfoMetaKey]; !reflect.DeepEqual(got, ServerIdentity{
		Name:    "discover-server",
		Version: "2.0.0",
	}) {
		t.Fatalf("server identity = %#v", got)
	}
}

func TestServerDiscoverAllowedInBothProtocolShapes(t *testing.T) {
	t.Parallel()

	if !methodAllowedForProtocol(protocolVersion, methodServerDiscover) {
		t.Fatal("server/discover is not allowed for the session-ful shape")
	}
	if !methodAllowedForProtocol(ProtocolVersion20260728, methodServerDiscover) {
		t.Fatal("server/discover is not allowed for the stateless shape")
	}
}
