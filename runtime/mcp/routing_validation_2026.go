package mcp

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"unicode/utf8"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
)

func validatePOSTRequestProtocol(
	headers map[string][]string,
	req *Request,
	detectedShape ProtocolShape,
) (ProtocolShape, *apptheory.Response) {
	if resp := conflictingProtocolVersionHeaderResponse(headers, req.ID); resp != nil {
		return ProtocolShapeUnknown, resp
	}
	modernClaim, resp := validatePOSTRequestVersions(headers, req)
	if resp != nil {
		return ProtocolShapeUnknown, resp
	}
	if !modernClaim {
		return detectedShape, nil
	}

	if resp := validate20260728RequestMetadata(req); resp != nil {
		return ProtocolShapeUnknown, resp
	}
	if resp := validate20260728RoutingHeaders(headers, req); resp != nil {
		return ProtocolShapeUnknown, resp
	}
	return ProtocolShape20260728, nil
}

func validatePOSTRequestVersions(headers map[string][]string, req *Request) (bool, *apptheory.Response) {
	headerVersion := strings.TrimSpace(firstHeader(headers, headerMcpProtocolVersion))
	metaVersion := requestProtocolVersionMetadata(req)

	if headerVersion != "" && !isAdvertisedProtocolVersion(headerVersion) {
		if metaVersion == "" &&
			(strings.TrimSpace(firstHeader(headers, headerMcpSessionID)) != "" || req.Method == methodInitialize) {
			return false, nil
		}
		return false, unsupportedProtocolVersionResponse(req.ID, headerVersion)
	}
	if metaVersion != "" && !isAdvertisedProtocolVersion(metaVersion) {
		return false, unsupportedProtocolVersionResponse(req.ID, metaVersion)
	}

	modernClaim := headerVersion == ProtocolVersion20260728 || metaVersion == ProtocolVersion20260728
	if modernClaim && headerVersion != "" && metaVersion != "" && headerVersion != metaVersion {
		return false, protocolJSONRPCErrorResponse(
			req.ID,
			CodeHeaderMismatch,
			"Header mismatch: MCP-Protocol-Version does not match request metadata",
			nil,
		)
	}
	if metaVersion == ProtocolVersion20260728 && headerVersion == "" {
		return false, protocolJSONRPCErrorResponse(
			req.ID,
			CodeHeaderMismatch,
			"Header mismatch: missing required MCP-Protocol-Version header",
			nil,
		)
	}
	return modernClaim, nil
}

func validatePOSTResponseProtocol(
	headers map[string][]string,
	resp *Response,
	detectedShape ProtocolShape,
) *apptheory.Response {
	if conflictResponse := conflictingProtocolVersionHeaderResponse(headers, resp.ID); conflictResponse != nil {
		return conflictResponse
	}
	headerVersion := strings.TrimSpace(firstHeader(headers, headerMcpProtocolVersion))
	if headerVersion != "" && !isAdvertisedProtocolVersion(headerVersion) {
		if strings.TrimSpace(firstHeader(headers, headerMcpSessionID)) != "" {
			return nil
		}
		return unsupportedProtocolVersionResponse(resp.ID, headerVersion)
	}
	if detectedShape != ProtocolShape20260728 {
		return nil
	}
	return protocolJSONRPCErrorResponse(
		resp.ID,
		CodeInvalidRequest,
		"Invalid Request: clients must not send JSON-RPC responses",
		nil,
	)
}

func conflictingProtocolVersionHeaderResponse(headers map[string][]string, id any) *apptheory.Response {
	if !conflictingHeaderValues(headers, headerMcpProtocolVersion) {
		return nil
	}
	return protocolJSONRPCErrorResponse(
		id,
		CodeHeaderMismatch,
		"Header mismatch: conflicting MCP-Protocol-Version header values",
		nil,
	)
}

func validate20260728RequestMetadata(req *Request) *apptheory.Response {
	var params map[string]json.RawMessage
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeInvalidParams,
			"Invalid params: missing or invalid io.modelcontextprotocol/protocolVersion",
			nil,
		)
	}
	rawMeta, ok := params["_meta"]
	if !ok {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeInvalidParams,
			"Invalid params: missing or invalid io.modelcontextprotocol/protocolVersion",
			nil,
		)
	}
	var meta map[string]json.RawMessage
	if err := json.Unmarshal(rawMeta, &meta); err != nil {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeInvalidParams,
			"Invalid params: missing or invalid io.modelcontextprotocol/protocolVersion",
			nil,
		)
	}
	var protocolVersion string
	if raw, ok := meta[protocolVersionMetaKey]; !ok ||
		json.Unmarshal(raw, &protocolVersion) != nil ||
		strings.TrimSpace(protocolVersion) != ProtocolVersion20260728 {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeInvalidParams,
			"Invalid params: missing or invalid io.modelcontextprotocol/protocolVersion",
			nil,
		)
	}
	var clientCapabilities map[string]json.RawMessage
	if raw, ok := meta[clientCapabilitiesMetaKey]; !ok ||
		json.Unmarshal(raw, &clientCapabilities) != nil ||
		clientCapabilities == nil {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeInvalidParams,
			"Invalid params: missing or invalid io.modelcontextprotocol/clientCapabilities",
			nil,
		)
	}
	return nil
}

func validate20260728RoutingHeaders(headers map[string][]string, req *Request) *apptheory.Response {
	if conflictingHeaderValues(headers, headerMcpMethod) {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeHeaderMismatch,
			"Header mismatch: conflicting Mcp-Method header values",
			nil,
		)
	}
	if conflictingHeaderValues(headers, headerMcpName) {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeHeaderMismatch,
			"Header mismatch: conflicting Mcp-Name header values",
			nil,
		)
	}

	method := strings.TrimSpace(firstHeader(headers, headerMcpMethod))
	if method == "" {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeHeaderMismatch,
			"Header mismatch: missing required Mcp-Method header",
			nil,
		)
	}
	if method != req.Method {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeHeaderMismatch,
			"Header mismatch: Mcp-Method does not match request method",
			nil,
		)
	}

	name, required, invalidMessage := requestRoutingName(req)
	if invalidMessage != "" {
		return protocolJSONRPCErrorResponse(req.ID, CodeInvalidParams, invalidMessage, nil)
	}
	if !required {
		return nil
	}
	headerName := strings.TrimSpace(firstHeader(headers, headerMcpName))
	if headerName == "" {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeHeaderMismatch,
			"Header mismatch: missing required Mcp-Name header",
			nil,
		)
	}
	decodedName, malformed := decodeRoutingHeaderName(headerName)
	if malformed {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeHeaderMismatch,
			"Header mismatch: malformed Mcp-Name Base64 encoding",
			nil,
		)
	}
	headerName = decodedName
	if headerName != name {
		return protocolJSONRPCErrorResponse(
			req.ID,
			CodeHeaderMismatch,
			"Header mismatch: Mcp-Name does not match request parameters",
			nil,
		)
	}
	return nil
}

func decodeRoutingHeaderName(value string) (string, bool) {
	const (
		prefix = "=?base64?"
		suffix = "?="
	)
	if !strings.HasPrefix(value, prefix) {
		return value, false
	}
	if len(value) < len(prefix)+len(suffix) || !strings.HasSuffix(value, suffix) {
		return "", true
	}
	encoded := value[len(prefix) : len(value)-len(suffix)]
	decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(decoded) != encoded || !utf8.Valid(decoded) {
		return "", true
	}
	return string(decoded), false
}

func conflictingHeaderValues(headers map[string][]string, key string) bool {
	var first string
	found := false
	for name, values := range headers {
		if !strings.EqualFold(name, key) {
			continue
		}
		for _, raw := range values {
			value := strings.TrimSpace(raw)
			if !found {
				first = value
				found = true
				continue
			}
			if value != first {
				return true
			}
		}
	}
	return false
}

func requestRoutingName(req *Request) (name string, required bool, invalidMessage string) {
	var field string
	switch req.Method {
	case methodToolsCall, methodPromptsGet:
		field = "name"
	case methodResourcesRead:
		field = "uri"
	default:
		return "", false, ""
	}

	invalidMessage = "Invalid params: params." + field + " must be a non-empty string"
	var params map[string]json.RawMessage
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return "", true, invalidMessage
	}
	raw, ok := params[field]
	if !ok {
		return "", true, invalidMessage
	}
	if err := json.Unmarshal(raw, &name); err != nil || strings.TrimSpace(name) == "" {
		return "", true, invalidMessage
	}
	return name, true, ""
}

func unsupportedProtocolVersionResponse(id any, requested string) *apptheory.Response {
	return protocolJSONRPCErrorResponse(
		id,
		CodeUnsupportedProtocolVersion,
		"Unsupported protocol version",
		map[string]any{
			"supported": supportedProtocolVersions(),
			"requested": requested,
		},
	)
}

func isAdvertisedProtocolVersion(version string) bool {
	for _, supported := range supportedProtocolVersions() {
		if version == supported {
			return true
		}
	}
	return false
}
