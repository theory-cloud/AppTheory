package mcp

import (
	"encoding/base64"
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
			name:     "missing required version header",
			headers:  map[string][]string{headerMcpMethod: {methodPing}},
			request:  &Request{ID: "missing-version-header", Method: methodPing, Params: modernParams},
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
			name: "conflicting method",
			headers: map[string][]string{
				headerMcpProtocolVersion: {ProtocolVersion20260728},
				headerMcpMethod:          {methodPing, methodToolsList},
			},
			request:  &Request{ID: "conflicting-method", Method: methodPing, Params: modernParams},
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
			name: "conflicting name",
			headers: map[string][]string{
				headerMcpProtocolVersion: {ProtocolVersion20260728},
				headerMcpMethod:          {methodToolsCall},
				headerMcpName:            {"echo", "other"},
			},
			request: &Request{
				ID:     "conflicting-name",
				Method: methodToolsCall,
				Params: json.RawMessage(`{"name":"echo","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`),
			},
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
				Params: json.RawMessage(`{"name":"echo","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`),
			},
			detected: ProtocolShape20260728,
			wantCode: CodeHeaderMismatch,
		},
		{
			name: "malformed encoded name",
			headers: map[string][]string{
				headerMcpProtocolVersion: {ProtocolVersion20260728},
				headerMcpMethod:          {methodToolsCall},
				headerMcpName:            {"=?base64?not-base64?="},
			},
			request: &Request{
				ID:     "malformed-name",
				Method: methodToolsCall,
				Params: json.RawMessage(`{"name":"echo","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`),
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
				Params: json.RawMessage(`{"uri":"file:///contract.txt","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`),
			},
			detected: ProtocolShape20260728,
			wantCode: CodeHeaderMismatch,
		},
		{
			name: "invalid routed body name",
			headers: map[string][]string{
				headerMcpProtocolVersion: {ProtocolVersion20260728},
				headerMcpMethod:          {methodResourcesRead},
				headerMcpName:            {"file:///contract.txt"},
			},
			request: &Request{
				ID:     "invalid-body-name",
				Method: methodResourcesRead,
				Params: json.RawMessage(`{"uri":1,"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`),
			},
			detected: ProtocolShape20260728,
			wantCode: CodeInvalidParams,
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
				Params: json.RawMessage(`{"name":"greeting","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`),
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

func TestMissingRequiredClientExtensionCapability(t *testing.T) {
	t.Parallel()

	inputResult := InputRequiredResult{
		ResultType: ResultTypeInputRequired,
		InputRequests: map[string]InputRequest{
			"approval": {Method: "com.example/review/approve"},
		},
	}
	inputResponse := NewResultResponse("input", inputResult)
	missingRequest := &Request{
		Params: json.RawMessage(
			`{"_meta":{"io.modelcontextprotocol/clientCapabilities":{"extensions":{"com.example/other":{}}}}}`,
		),
	}
	if got, want := missingRequiredClientCapabilities(missingRequest, inputResponse), map[string]any{
		"extensions": map[string]any{
			"com.example/review": map[string]any{},
		},
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("missing extension capabilities = %#v, want %#v", got, want)
	}

	declaredRequest := &Request{
		Params: json.RawMessage(
			`{"_meta":{"io.modelcontextprotocol/clientCapabilities":{"extensions":{"com.example/review":{"mode":"approval"}}}}}`,
		),
	}
	if got := missingRequiredClientCapabilities(declaredRequest, inputResponse); got != nil {
		t.Fatalf("declared extension capability reported missing: %#v", got)
	}

	for name, result := range map[string]any{
		"pointer": &inputResult,
		"raw":     json.RawMessage(`{"resultType":"input_required","inputRequests":{"approval":{"method":"com.example/review/approve"}}}`),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			required := requiredClientCapabilities(NewResultResponse(name, result))
			if _, ok := required["extensions"]; !ok {
				t.Fatalf("required capabilities = %#v, want extensions", required)
			}
		})
	}
	if got := requiredClientCapabilities(NewResultResponse("nil-pointer", (*InputRequiredResult)(nil))); got != nil {
		t.Fatalf("nil input-required pointer capabilities = %#v, want nil", got)
	}

	required := map[string]any{
		"extensions": map[string]any{
			"com.example/review": map[string]any{
				"nested": map[string]any{},
			},
		},
	}
	if got := missingCapabilityTree(required, nil); !reflect.DeepEqual(got, required) {
		t.Fatalf("cloned missing capability tree = %#v, want %#v", got, required)
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

func TestValidate20260728RequestMetadata(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		params   json.RawMessage
		wantCode int
	}{
		"malformed params": {
			params:   json.RawMessage(`{`),
			wantCode: CodeInvalidParams,
		},
		"missing meta": {
			params:   json.RawMessage(`{}`),
			wantCode: CodeInvalidParams,
		},
		"invalid meta": {
			params:   json.RawMessage(`{"_meta":"invalid"}`),
			wantCode: CodeInvalidParams,
		},
		"missing protocol version": {
			params:   json.RawMessage(`{"_meta":{"io.modelcontextprotocol/clientCapabilities":{}}}`),
			wantCode: CodeInvalidParams,
		},
		"missing client capabilities": {
			params:   json.RawMessage(`{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}`),
			wantCode: CodeInvalidParams,
		},
		"null client capabilities": {
			params: json.RawMessage(
				`{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":null}}`,
			),
			wantCode: CodeInvalidParams,
		},
		"valid": {
			params: json.RawMessage(
				`{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}`,
			),
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			resp := validate20260728RequestMetadata(&Request{ID: name, Params: test.params})
			if test.wantCode == 0 {
				if resp != nil {
					t.Fatalf("unexpected response: %#v", resp)
				}
				return
			}
			assertProtocolErrorCode(t, resp, test.wantCode)
		})
	}
}

func TestDecodeRoutingHeaderName(t *testing.T) {
	t.Parallel()

	encoded := base64.StdEncoding.EncodeToString([]byte("file:///résumé.txt"))
	tests := map[string]struct {
		value         string
		want          string
		wantMalformed bool
	}{
		"plain": {
			value: "file:///plain.txt",
			want:  "file:///plain.txt",
		},
		"valid": {
			value: "=?base64?" + encoded + "?=",
			want:  "file:///résumé.txt",
		},
		"case-sensitive marker": {
			value: "=?Base64?" + encoded + "?=",
			want:  "=?Base64?" + encoded + "?=",
		},
		"missing suffix": {
			value:         "=?base64?" + encoded,
			wantMalformed: true,
		},
		"invalid base64": {
			value:         "=?base64?not-base64?=",
			wantMalformed: true,
		},
		"invalid utf8": {
			value:         "=?base64?/w==?=",
			wantMalformed: true,
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			got, malformed := decodeRoutingHeaderName(test.value)
			if got != test.want || malformed != test.wantMalformed {
				t.Fatalf(
					"decodeRoutingHeaderName(%q) = (%q, %t), want (%q, %t)",
					test.value,
					got,
					malformed,
					test.want,
					test.wantMalformed,
				)
			}
		})
	}
}

func TestValidatePOSTResponseProtocol(t *testing.T) {
	t.Parallel()

	resp := NewResultResponse("response", map[string]any{})
	if got := validatePOSTResponseProtocol(
		map[string][]string{
			headerMcpProtocolVersion: {"2099-01-01"},
			headerMcpSessionID:       {"legacy-session"},
		},
		resp,
		ProtocolShapeUnknown,
	); got != nil {
		t.Fatalf("sessionful unsupported header response = %#v, want nil", got)
	}
	assertProtocolErrorCode(
		t,
		validatePOSTResponseProtocol(
			map[string][]string{headerMcpProtocolVersion: {"2099-01-01"}},
			resp,
			ProtocolShapeUnknown,
		),
		CodeUnsupportedProtocolVersion,
	)
	if got := validatePOSTResponseProtocol(nil, resp, ProtocolShape20251125); got != nil {
		t.Fatalf("legacy posted response validation = %#v, want nil", got)
	}
	assertProtocolErrorCode(
		t,
		validatePOSTResponseProtocol(
			map[string][]string{headerMcpProtocolVersion: {ProtocolVersion20260728}},
			resp,
			ProtocolShape20260728,
		),
		CodeInvalidRequest,
	)
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
