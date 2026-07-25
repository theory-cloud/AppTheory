package mcp

import (
	"encoding/json"
	"testing"
)

func TestMarshalResultWithServerInfoPreservesMetadata(t *testing.T) {
	t.Parallel()

	raw, err := marshalResultWithServerInfo(
		map[string]any{
			"resultType": ResultTypeComplete,
			"_meta": map[string]any{
				"com.example/custom": "preserved",
			},
		},
		ServerIdentity{Name: "metadata-server", Version: "2.0.1"},
	)
	if err != nil {
		t.Fatalf("marshal result with server info: %v", err)
	}

	var result map[string]json.RawMessage
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	var meta map[string]json.RawMessage
	if err := json.Unmarshal(result["_meta"], &meta); err != nil {
		t.Fatalf("unmarshal metadata: %v", err)
	}
	var custom string
	if err := json.Unmarshal(meta["com.example/custom"], &custom); err != nil {
		t.Fatalf("unmarshal custom metadata: %v", err)
	}
	if custom != "preserved" {
		t.Fatalf("custom metadata = %q, want preserved", custom)
	}
	var identity ServerIdentity
	if err := json.Unmarshal(meta[serverInfoMetaKey], &identity); err != nil {
		t.Fatalf("unmarshal server identity: %v", err)
	}
	if identity.Name != "metadata-server" || identity.Version != "2.0.1" {
		t.Fatalf("server identity = %#v", identity)
	}
}

func TestMarshalResultWithServerInfoFailsClosed(t *testing.T) {
	t.Parallel()

	tests := map[string]any{
		"marshal failure": func() {},
		"non-object":      "complete",
		"null object":     nil,
		"invalid meta": map[string]any{
			"_meta": "not-an-object",
		},
	}
	for name, result := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := marshalResultWithServerInfo(result, ServerIdentity{}); err == nil {
				t.Fatal("marshalResultWithServerInfo returned nil error")
			}
		})
	}
}

func TestWithServerInfoMetadataDisablesModernInjection(t *testing.T) {
	t.Parallel()

	s := NewServer("metadata-server", "2.0.1", WithServerInfoMetadata(false))
	resp := s.finalizeResponseForProtocol(
		&Request{Method: methodToolsCall},
		NewResultResponse("opt-out", map[string]any{"content": []any{}}),
		ProtocolVersion20260728,
	)
	result := cacheableResultObject(t, resp)
	if _, ok := result["_meta"]; ok {
		t.Fatalf("opt-out result contains metadata: %#v", result)
	}
}
