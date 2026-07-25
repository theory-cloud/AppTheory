package mcp

import (
	"encoding/json"
	"strings"
)

const protocolVersionMetaKey = "io.modelcontextprotocol/protocolVersion"

// ProtocolShape identifies the transport shape selected for one MCP request.
type ProtocolShape string

const (
	// ProtocolShape20251125 is the session-ful MCP 2025-11-25 transport shape.
	ProtocolShape20251125 ProtocolShape = protocolVersion
	// ProtocolShape20260728 is the stateless MCP 2026-07-28 transport shape.
	ProtocolShape20260728 ProtocolShape = ProtocolVersion20260728
	// ProtocolShapeUnknown means neither supported request shape was identified.
	ProtocolShapeUnknown ProtocolShape = "unknown"
)

// DetectProtocolVersion identifies the MCP transport shape for one request.
//
// MCP-Protocol-Version takes precedence when present. Otherwise the detector
// reads io.modelcontextprotocol/protocolVersion from params._meta. Malformed
// requests and unrecognized versions return ProtocolShapeUnknown.
func DetectProtocolVersion(headers map[string][]string, requestBody []byte) ProtocolShape {
	if headerVersion := strings.TrimSpace(firstHeader(headers, headerMcpProtocolVersion)); headerVersion != "" {
		return protocolShapeForVersion(headerVersion)
	}
	return detectProtocolVersionFromJSON(requestBody)
}

// DetectProtocolVersionForMessage identifies the MCP transport shape for one
// already-parsed JSON-RPC message.
//
// MCP-Protocol-Version takes precedence when present. Otherwise the detector
// reads io.modelcontextprotocol/protocolVersion from params._meta. Values that
// cannot be represented as a JSON object return ProtocolShapeUnknown.
func DetectProtocolVersionForMessage(headers map[string][]string, message any) ProtocolShape {
	if headerVersion := strings.TrimSpace(firstHeader(headers, headerMcpProtocolVersion)); headerVersion != "" {
		return protocolShapeForVersion(headerVersion)
	}

	requestBody, err := json.Marshal(message)
	if err != nil {
		return ProtocolShapeUnknown
	}
	return detectProtocolVersionFromJSON(requestBody)
}

func detectProtocolVersionFromJSON(requestBody []byte) ProtocolShape {
	var request struct {
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(requestBody, &request); err != nil || len(request.Params) == 0 {
		return ProtocolShapeUnknown
	}

	var params struct {
		Meta map[string]json.RawMessage `json:"_meta"`
	}
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return ProtocolShapeUnknown
	}

	rawVersion, ok := params.Meta[protocolVersionMetaKey]
	if !ok {
		return ProtocolShapeUnknown
	}
	var metaVersion string
	if err := json.Unmarshal(rawVersion, &metaVersion); err != nil {
		return ProtocolShapeUnknown
	}
	return protocolShapeForVersion(strings.TrimSpace(metaVersion))
}

func protocolShapeForVersion(version string) ProtocolShape {
	switch version {
	case protocolVersion:
		return ProtocolShape20251125
	case ProtocolVersion20260728:
		return ProtocolShape20260728
	default:
		return ProtocolShapeUnknown
	}
}
