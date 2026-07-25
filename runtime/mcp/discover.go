package mcp

const serverInfoMetaKey = "io.modelcontextprotocol/serverInfo"

// ServerIdentity identifies the MCP server implementation.
type ServerIdentity struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// DiscoverResult is the result returned by server/discover.
type DiscoverResult struct {
	SupportedVersions []string       `json:"supportedVersions"`
	Capabilities      map[string]any `json:"capabilities"`
	Meta              map[string]any `json:"_meta,omitempty"`
}

func (s *Server) handleDiscover(req *Request, protocolVersion string) *Response {
	result := DiscoverResult{
		SupportedVersions: supportedProtocolVersions(),
		Capabilities:      s.initializeCapabilities(protocolVersion),
	}
	if protocolVersion != ProtocolVersion20260728 {
		result.Meta = map[string]any{
			serverInfoMetaKey: ServerIdentity{
				Name:    s.name,
				Version: s.version,
			},
		}
	}
	return NewResultResponse(req.ID, result)
}

func supportedProtocolVersions() []string {
	return []string{
		ProtocolVersion20260728,
		protocolVersion,
		protocolVersionPrior,
		protocolVersionLegacy,
	}
}
