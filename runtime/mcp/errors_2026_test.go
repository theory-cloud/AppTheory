package mcp

import (
	"encoding/json"
	"reflect"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
)

func TestValidatePOSTRequestProtocol20260728(t *testing.T) {
	t.Parallel()

	modernParams := json.RawMessage(
		`{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`,
	)
	tests := []struct {
		name      string
		headers   map[string][]string
		request   *Request
		detected  ProtocolShape
		wantShape ProtocolShape
		wantCode  int
	}{
		{
			name:     "unsupported header",
			headers:  map[string][]string{headerMcpProtocolVersion: {"2099-01-01"}},
			request:  &Request{ID: "unsupported", Method: methodPing},
			detected: ProtocolShapeUnknown,
			wantCode: CodeUnsupportedProtocolVersion,
		},
		{
			name:    "unsupported metadata",
			headers: map[string][]string{headerMcpMethod: {methodPing}},
			request: &Request{
				ID:     "unsupported-meta",
				Method: methodPing,
				Params: json.RawMessage(`{"_meta":{"io.modelcontextprotocol/protocolVersion":"2099-01-02"}}`),
			},
			detected: ProtocolShapeUnknown,
			wantCode: CodeUnsupportedProtocolVersion,
		},
		{
			name: "version mismatch",
			headers: map[string][]string{
				headerMcpProtocolVersion: {ProtocolVersion20260728},
				headerMcpMethod:          {methodPing},
			},
			request: &Request{
				ID:     "mismatch",
				Method: methodPing,
				Params: json.RawMessage(`{"_meta":{"io.modelcontextprotocol/protocolVersion":"2025-11-25"}}`),
			},
			detected: ProtocolShape20260728,
			wantCode: CodeHeaderMismatch,
		},
		{
			name: "missing method",
			headers: map[string][]string{
				headerMcpProtocolVersion: {ProtocolVersion20260728},
			},
			request:  &Request{ID: "missing-method", Method: methodPing, Params: modernParams},
			detected: ProtocolShape20260728,
			wantCode: CodeHeaderMismatch,
		},
		{
			name: "method mismatch",
			headers: map[string][]string{
				headerMcpProtocolVersion: {ProtocolVersion20260728},
				headerMcpMethod:          {methodToolsList},
			},
			request:  &Request{ID: "wrong-method", Method: methodPing, Params: modernParams},
			detected: ProtocolShape20260728,
			wantCode: CodeHeaderMismatch,
		},
		{
			name: "missing name",
			headers: map[string][]string{
				headerMcpProtocolVersion: {ProtocolVersion20260728},
				headerMcpMethod:          {methodToolsCall},
			},
			request: &Request{
				ID:     "missing-name",
				Method: methodToolsCall,
				Params: json.RawMessage(`{"name":"echo","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}`),
			},
			detected: ProtocolShape20260728,
			wantCode: CodeHeaderMismatch,
		},
		{
			name: "name mismatch",
			headers: map[string][]string{
				headerMcpProtocolVersion: {ProtocolVersion20260728},
				headerMcpMethod:          {methodResourcesRead},
				headerMcpName:            {"file:///other.txt"},
			},
			request: &Request{
				ID:     "wrong-name",
				Method: methodResourcesRead,
				Params: json.RawMessage(`{"uri":"file:///contract.txt","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}`),
			},
			detected: ProtocolShape20260728,
			wantCode: CodeHeaderMismatch,
		},
		{
			name: "valid named request",
			headers: map[string][]string{
				headerMcpProtocolVersion: {ProtocolVersion20260728},
				headerMcpMethod:          {methodPromptsGet},
				headerMcpName:            {"greeting"},
			},
			request: &Request{
				ID:     "valid",
				Method: methodPromptsGet,
				Params: json.RawMessage(`{"name":"greeting","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}`),
			},
			detected:  ProtocolShape20260728,
			wantShape: ProtocolShape20260728,
		},
		{
			name: "legacy request unchanged",
			headers: map[string][]string{
				headerMcpProtocolVersion: {protocolVersion},
			},
			request:   &Request{ID: "legacy", Method: methodPing},
			detected:  ProtocolShape20251125,
			wantShape: ProtocolShape20251125,
		},
		{
			name: "sessionful unsupported header defers to legacy validation",
			headers: map[string][]string{
				headerMcpProtocolVersion: {"1900-01-01"},
				headerMcpSessionID:       {"legacy-session"},
			},
			request:   &Request{ID: "legacy-unsupported", Method: methodPing},
			detected:  ProtocolShapeUnknown,
			wantShape: ProtocolShapeUnknown,
		},
		{
			name: "initialize unsupported header defers to legacy negotiation",
			headers: map[string][]string{
				headerMcpProtocolVersion: {"1900-01-01"},
			},
			request:   &Request{ID: "initialize", Method: methodInitialize},
			detected:  ProtocolShapeUnknown,
			wantShape: ProtocolShapeUnknown,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			shape, resp := validatePOSTRequestProtocol(test.headers, test.request, test.detected)
			if test.wantCode == 0 {
				if resp != nil {
					t.Fatalf("unexpected response: status=%d body=%s", resp.Status, resp.Body)
				}
				if shape != test.wantShape {
					t.Fatalf("shape = %q, want %q", shape, test.wantShape)
				}
				return
			}
			if shape != ProtocolShapeUnknown {
				t.Fatalf("error shape = %q, want %q", shape, ProtocolShapeUnknown)
			}
			assertProtocolErrorCode(t, resp, test.wantCode)
		})
	}
}

func TestMissingRequiredClientCapabilities(t *testing.T) {
	t.Parallel()

	inputResponse := NewResultResponse("input", InputRequiredResult{
		ResultType: ResultTypeInputRequired,
		InputRequests: map[string]InputRequest{
			"confirmation": {Method: "elicitation/create"},
			"sample":       {Method: "sampling/createMessage"},
			"ignored":      {Method: "malformed"},
		},
	})

	missingRequest := &Request{
		Params: json.RawMessage(
			`{"_meta":{"io.modelcontextprotocol/clientCapabilities":{"elicitation":{}}}}`,
		),
	}
	if got, want := missingRequiredClientCapabilities(missingRequest, inputResponse), map[string]any{
		"sampling": map[string]any{},
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("missing capabilities = %#v, want %#v", got, want)
	}

	declaredRequest := &Request{
		Params: json.RawMessage(
			`{"_meta":{"io.modelcontextprotocol/clientCapabilities":{"elicitation":{},"sampling":{}}}}`,
		),
	}
	if got := missingRequiredClientCapabilities(declaredRequest, inputResponse); got != nil {
		t.Fatalf("declared capabilities reported missing: %#v", got)
	}

	invalidRequest := &Request{
		Params: json.RawMessage(
			`{"_meta":{"io.modelcontextprotocol/clientCapabilities":{"elicitation":true}}}`,
		),
	}
	if got := missingRequiredClientCapabilities(invalidRequest, inputResponse); len(got) != 2 {
		t.Fatalf("invalid capability declarations = %#v, want two missing", got)
	}

	for name, response := range map[string]*Response{
		"nil":      nil,
		"error":    NewErrorResponse("error", CodeInternalError, "internal error"),
		"complete": NewResultResponse("complete", map[string]any{}),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if got := missingRequiredClientCapabilities(nil, response); got != nil {
				t.Fatalf("missing capabilities = %#v, want nil", got)
			}
		})
	}
}

func TestRequestRoutingNameRejectsMalformedParams(t *testing.T) {
	t.Parallel()

	for _, req := range []*Request{
		{Method: methodToolsCall, Params: json.RawMessage(`{`)},
		{Method: methodResourcesRead, Params: json.RawMessage(`{"uri":1}`)},
	} {
		name, required, invalidMessage := requestRoutingName(req)
		if !required || name != "" || invalidMessage == "" {
			t.Fatalf(
				"requestRoutingName(%s) = (%q, %t, %q), want invalid required name",
				req.Method,
				name,
				required,
				invalidMessage,
			)
		}
	}
}

func assertProtocolErrorCode(t *testing.T, resp *apptheory.Response, code int) {
	t.Helper()
	if resp == nil {
		t.Fatal("expected protocol error response")
	}
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400", resp.Status)
	}
	rpcResp, err := parseJSONRPCResponse(resp)
	if err != nil {
		t.Fatalf("parse JSON-RPC response: %v", err)
	}
	if rpcResp.Error == nil || rpcResp.Error.Code != code {
		t.Fatalf("error = %#v, want code %d", rpcResp.Error, code)
	}
}
