package mcp

import (
	"encoding/json"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
)

func validatePOSTRequestProtocol(
	headers map[string][]string,
	req *Request,
	detectedShape ProtocolShape,
) (ProtocolShape, *apptheory.Response) {
	headerVersion := strings.TrimSpace(firstHeader(headers, headerMcpProtocolVersion))
	metaVersion := requestProtocolVersionMetadata(req)

	if headerVersion != "" && !isAdvertisedProtocolVersion(headerVersion) {
		if metaVersion == "" &&
			(strings.TrimSpace(firstHeader(headers, headerMcpSessionID)) != "" || req.Method == methodInitialize) {
			return detectedShape, nil
		}
		return ProtocolShapeUnknown, unsupportedProtocolVersionResponse(req.ID, headerVersion)
	}
	if metaVersion != "" && !isAdvertisedProtocolVersion(metaVersion) {
		return ProtocolShapeUnknown, unsupportedProtocolVersionResponse(req.ID, metaVersion)
	}

	modernClaim := headerVersion == ProtocolVersion20260728 || metaVersion == ProtocolVersion20260728
	if modernClaim && headerVersion != "" && metaVersion != "" && headerVersion != metaVersion {
		return ProtocolShapeUnknown, protocolJSONRPCErrorResponse(
			req.ID,
			CodeHeaderMismatch,
			"Header mismatch: MCP-Protocol-Version does not match request metadata",
			nil,
		)
	}
	if !modernClaim {
		return detectedShape, nil
	}

	if resp := validate20260728RoutingHeaders(headers, req); resp != nil {
		return ProtocolShapeUnknown, resp
	}
	return ProtocolShape20260728, nil
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
