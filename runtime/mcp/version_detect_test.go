package mcp

import "testing"

func TestDetectProtocolVersion(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		headers map[string][]string
		body    string
		want    ProtocolShape
	}{
		{
			name:    "2025 header",
			headers: map[string][]string{"MCP-Protocol-Version": {protocolVersion}},
			body:    `{"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`,
			want:    ProtocolShape20251125,
		},
		{
			name:    "2026 header takes precedence",
			headers: map[string][]string{headerMcpProtocolVersion: {ProtocolVersion20260728}},
			body:    `{"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2025-11-25"}}}`,
			want:    ProtocolShape20260728,
		},
		{
			name: "2025 request metadata",
			body: `{"jsonrpc":"2.0","method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2025-11-25"}}}`,
			want: ProtocolShape20251125,
		},
		{
			name: "2026 request metadata",
			body: `{"jsonrpc":"2.0","method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`,
			want: ProtocolShape20260728,
		},
		{
			name:    "unknown header does not fall back",
			headers: map[string][]string{headerMcpProtocolVersion: {"2099-01-01"}},
			body:    `{"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`,
			want:    ProtocolShapeUnknown,
		},
		{
			name: "missing metadata",
			body: `{"jsonrpc":"2.0","method":"ping","params":{}}`,
			want: ProtocolShapeUnknown,
		},
		{
			name: "non-string metadata",
			body: `{"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":20260728}}}`,
			want: ProtocolShapeUnknown,
		},
		{
			name: "malformed request",
			body: `{`,
			want: ProtocolShapeUnknown,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := DetectProtocolVersion(tt.headers, []byte(tt.body)); got != tt.want {
				t.Fatalf("DetectProtocolVersion() = %q, want %q", got, tt.want)
			}
		})
	}

	if ProtocolVersion20260728 != "2026-07-28" {
		t.Fatalf("ProtocolVersion20260728 = %q", ProtocolVersion20260728)
	}
}

func TestDetectProtocolVersionForMessage(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		headers map[string][]string
		message any
		want    ProtocolShape
	}{
		{
			name:    "header takes precedence",
			headers: map[string][]string{headerMcpProtocolVersion: {protocolVersion}},
			message: map[string]any{
				"params": map[string]any{
					"_meta": map[string]any{protocolVersionMetaKey: ProtocolVersion20260728},
				},
			},
			want: ProtocolShape20251125,
		},
		{
			name: "parsed map",
			message: map[string]any{
				"jsonrpc": "2.0",
				"method":  "ping",
				"params": map[string]any{
					"_meta": map[string]any{protocolVersionMetaKey: ProtocolVersion20260728},
				},
			},
			want: ProtocolShape20260728,
		},
		{
			name: "parsed request",
			message: &Request{
				JSONRPC: "2.0",
				Method:  "ping",
				Params:  []byte(`{"_meta":{"io.modelcontextprotocol/protocolVersion":"2025-11-25"}}`),
			},
			want: ProtocolShape20251125,
		},
		{
			name:    "unsupported version",
			message: map[string]any{"params": map[string]any{"_meta": map[string]any{protocolVersionMetaKey: "2099-01-01"}}},
			want:    ProtocolShapeUnknown,
		},
		{
			name:    "non JSON value",
			message: make(chan struct{}),
			want:    ProtocolShapeUnknown,
		},
		{
			name:    "nil message",
			message: nil,
			want:    ProtocolShapeUnknown,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := DetectProtocolVersionForMessage(test.headers, test.message); got != test.want {
				t.Fatalf("DetectProtocolVersionForMessage() = %q, want %q", got, test.want)
			}
		})
	}
}
