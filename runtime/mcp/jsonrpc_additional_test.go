package mcp

import (
	"encoding/json"
	"testing"
)

func TestParseRequest_RejectsInvalidInputs(t *testing.T) {
	cases := []struct {
		name string
		body []byte
	}{
		{name: "empty", body: nil},
		{name: "invalid-json", body: []byte("{")},
		{name: "missing-jsonrpc", body: []byte(`{"id":1,"method":"` + methodToolsList + `"}`)},
		{name: "missing-method", body: []byte(`{"jsonrpc":"2.0","id":1}`)},
		{name: "null-id", body: []byte(`{"jsonrpc":"2.0","id":null,"method":"` + methodToolsList + `"}`)},
		{name: "empty-method", body: []byte(`{"jsonrpc":"2.0","id":1,"method":""}`)},
		{name: "unsupported-version", body: []byte(`{"jsonrpc":"1.0","id":1,"method":"` + methodToolsList + `"}`)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseRequest(tc.body); err == nil {
				t.Fatalf("expected error")
			}
		})
	}

	// Notifications (no id) are allowed.
	if _, err := ParseRequest([]byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)); err != nil {
		t.Fatalf("expected notification to parse, got: %v", err)
	}
}

func TestParseResponse_ValidAndInvalid(t *testing.T) {
	okCases := [][]byte{
		[]byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`),
		[]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"boom"}}`),
	}
	for i, body := range okCases {
		resp, err := ParseResponse(body)
		if err != nil {
			t.Fatalf("ok case %d: %v", i, err)
		}
		if resp.JSONRPC != "2.0" {
			t.Fatalf("jsonrpc: got %q want %q", resp.JSONRPC, "2.0")
		}
	}

	badCases := [][]byte{
		nil,
		[]byte("{"),
		[]byte(`{"id":1,"result":{}}`),          // missing jsonrpc
		[]byte(`{"jsonrpc":"2.0","result":{}}`), // missing id
		[]byte(`{"jsonrpc":"2.0","id":1,"result":{},"error":{}}`), // both
		[]byte(`{"jsonrpc":"2.0","id":1}`),                        // neither
		[]byte(`{"jsonrpc":"1.0","id":1,"result":{}}`),            // unsupported version
	}
	for i, body := range badCases {
		if _, err := ParseResponse(body); err == nil {
			t.Fatalf("bad case %d: expected error", i)
		}
	}
}

func TestParseBatchRequest_CoversObjectAndArrayErrors(t *testing.T) {
	// Single request object should return a slice of one.
	reqs, err := ParseBatchRequest([]byte(`{"jsonrpc":"2.0","id":1,"method":"` + methodToolsList + `"}`))
	if err != nil {
		t.Fatalf("object input: %v", err)
	}
	if len(reqs) != 1 || reqs[0].Method != methodToolsList {
		t.Fatalf("unexpected parsed requests: %+v", reqs)
	}

	// Valid array should parse.
	reqs, err = ParseBatchRequest([]byte(`[{"jsonrpc":"2.0","id":1,"method":"` + methodToolsList + `"}]`))
	if err != nil {
		t.Fatalf("array input: %v", err)
	}
	if len(reqs) != 1 || reqs[0].Method != methodToolsList {
		t.Fatalf("unexpected parsed requests: %+v", reqs)
	}

	// Errors: empty, whitespace, invalid array, empty array, invalid element.
	bad := [][]byte{
		nil,
		[]byte("   "),
		[]byte("[]"),
		[]byte("["),
		[]byte(`[{"jsonrpc":"2.0","id":null,"method":"` + methodToolsList + `"}]`),
	}
	for i, body := range bad {
		if _, err := ParseBatchRequest(body); err == nil {
			t.Fatalf("bad case %d: expected error", i)
		}
	}
}

func TestMarshalResponse_NilResponseErrors(t *testing.T) {
	if _, err := MarshalResponse(nil); err == nil {
		t.Fatalf("expected error for nil response")
	}

	// MarshalResponse should always force jsonrpc="2.0".
	b, err := MarshalResponse(&Response{JSONRPC: "ignored", ID: 1, Result: map[string]any{"ok": true}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded["jsonrpc"] != "2.0" {
		t.Fatalf("expected forced jsonrpc=2.0, got %v", decoded["jsonrpc"])
	}
}
