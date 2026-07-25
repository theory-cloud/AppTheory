package mcp

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestHandleDiscoverAdvertisesTruthfulSurface(t *testing.T) {
	t.Parallel()

	settings := map[string]any{"mode": "approval"}
	invalidExtensionIdentifier := " invalid/extension "
	s := NewServer(
		"discover-server",
		"2.0.0",
		WithExtensionCapabilities(map[string]map[string]any{
			"com.example/review":       settings,
			invalidExtensionIdentifier: {},
		}),
	)
	settings["mode"] = "mutated"
	if err := s.Registry().RegisterTool(ToolDef{
		Name:        "echo",
		InputSchema: []byte(`{"type":"object"}`),
	}, func(context.Context, json.RawMessage) (*ToolResult, error) {
		return &ToolResult{}, nil
	}); err != nil {
		t.Fatalf("register tool: %v", err)
	}

	resp := s.handleDiscover(
		&Request{JSONRPC: jsonrpcVersion, ID: "discover", Method: methodServerDiscover},
		ProtocolVersion20260728,
	)
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
	if got, want := result.Capabilities["extensions"], map[string]any{
		"com.example/review": map[string]any{"mode": "approval"},
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("discover extensions = %#v, want %#v", got, want)
	}
	if result.Meta != nil {
		t.Fatalf("modern discover handler injected metadata before response finalization: %#v", result.Meta)
	}
}

func TestHandleDiscoverKeepsExtensionsModernOnly(t *testing.T) {
	t.Parallel()

	s := NewServer(
		"discover-server",
		"2.0.0",
		WithExtensionCapabilities(map[string]map[string]any{
			"com.example/review": {},
		}),
	)
	resp := s.handleDiscover(
		&Request{JSONRPC: jsonrpcVersion, ID: "discover", Method: methodServerDiscover},
		protocolVersion,
	)
	result, ok := resp.Result.(DiscoverResult)
	if !ok {
		t.Fatalf("discover result type = %T, want DiscoverResult", resp.Result)
	}
	if _, ok := result.Capabilities["extensions"]; ok {
		t.Fatalf("legacy discover capabilities advertised extensions: %#v", result.Capabilities)
	}
}

func TestNormalizeExtensionCapabilitiesFailsClosed(t *testing.T) {
	t.Parallel()

	if got := normalizeExtensionCapabilities(nil); got != nil {
		t.Fatalf("nil extension capabilities = %#v", got)
	}
	if got := normalizeExtensionCapabilities(map[string]map[string]any{
		"/missing-prefix":       {},
		"com..example/review":   {},
		"com.example/two/parts": {},
		"com.example/review": {
			"invalid": func() {},
		},
	}); got != nil {
		t.Fatalf("invalid extension capabilities = %#v", got)
	}
	if got := cloneExtensionSettings(map[string]any{"invalid": func() {}}); len(got) != 0 {
		t.Fatalf("invalid cloned extension settings = %#v", got)
	}
	if got, ok := normalizeExtensionSettings(nil); !ok || len(got) != 0 {
		t.Fatalf("nil extension settings = (%#v, %t)", got, ok)
	}
	if !validExtensionIdentifier("com.example/") {
		t.Fatal("mandatory extension prefix without a name was rejected")
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
