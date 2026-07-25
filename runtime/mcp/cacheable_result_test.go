package mcp

import (
	"encoding/json"
	"testing"
	"time"
)

func TestFinalizeResponseForProtocolAddsConfiguredCacheHint(t *testing.T) {
	t.Parallel()

	s := NewServer(
		"cache-server",
		"2.0.0",
		WithCacheableResultConfig(CacheableResultConfig{
			ToolsList: CacheHint{TTL: 30 * time.Second, Scope: CacheScopePublic},
		}),
	)
	req := &Request{Method: methodToolsList}
	resp := s.finalizeResponseForProtocol(
		req,
		NewResultResponse("tools", map[string]any{"tools": []any{}}),
		ProtocolVersion20260728,
	)
	result := cacheableResultObject(t, resp)
	if got, want := result["ttlMs"], float64(30_000); got != want {
		t.Fatalf("ttlMs = %#v, want %#v", got, want)
	}
	if got, want := result["cacheScope"], string(CacheScopePublic); got != want {
		t.Fatalf("cacheScope = %#v, want %#v", got, want)
	}
}

func TestFinalizeResponseForProtocolUsesFailClosedDefaults(t *testing.T) {
	t.Parallel()

	s := NewServer("cache-server", "2.0.0")
	resp := s.finalizeResponseForProtocol(
		&Request{Method: methodServerDiscover},
		NewResultResponse("discover", map[string]any{}),
		ProtocolVersion20260728,
	)
	result := cacheableResultObject(t, resp)
	if got, want := result["ttlMs"], float64(0); got != want {
		t.Fatalf("ttlMs = %#v, want %#v", got, want)
	}
	if got, want := result["cacheScope"], string(CacheScopePrivate); got != want {
		t.Fatalf("cacheScope = %#v, want %#v", got, want)
	}
}

func TestFinalizeResponseForProtocolSkipsNonCacheableResults(t *testing.T) {
	t.Parallel()

	s := NewServer("cache-server", "2.0.0")
	tests := map[string]struct {
		req             *Request
		resp            *Response
		protocolVersion string
	}{
		"legacy": {
			req:             &Request{Method: methodToolsList},
			resp:            NewResultResponse("legacy", map[string]any{"tools": []any{}}),
			protocolVersion: protocolVersion,
		},
		"method": {
			req:             &Request{Method: methodToolsCall},
			resp:            NewResultResponse("call", map[string]any{"content": []any{}}),
			protocolVersion: ProtocolVersion20260728,
		},
		"mrtr retry": {
			req: &Request{
				Method: methodResourcesRead,
				Params: json.RawMessage(`{"requestState":"read-resource"}`),
			},
			resp:            NewResultResponse("retry", map[string]any{"contents": []any{}}),
			protocolVersion: ProtocolVersion20260728,
		},
		"input required": {
			req: &Request{Method: methodResourcesRead},
			resp: NewResultResponse("input", InputRequiredResult{
				ResultType:   ResultTypeInputRequired,
				RequestState: "read-resource",
			}),
			protocolVersion: ProtocolVersion20260728,
		},
	}

	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			resp := s.finalizeResponseForProtocol(test.req, test.resp, test.protocolVersion)
			data, err := json.Marshal(resp.Result)
			if err != nil {
				t.Fatalf("marshal result: %v", err)
			}
			var result map[string]any
			if err := json.Unmarshal(data, &result); err != nil {
				t.Fatalf("unmarshal result: %v", err)
			}
			if _, ok := result["ttlMs"]; ok {
				t.Fatalf("result unexpectedly contains ttlMs: %#v", result)
			}
			if _, ok := result["cacheScope"]; ok {
				t.Fatalf("result unexpectedly contains cacheScope: %#v", result)
			}
		})
	}
}

func cacheableResultObject(t *testing.T, resp *Response) map[string]any {
	t.Helper()
	if resp == nil || resp.Error != nil {
		t.Fatalf("unexpected response: %#v", resp)
	}
	data, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	return result
}
