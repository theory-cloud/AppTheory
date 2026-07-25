package mcp

import (
	"encoding/json"
	"errors"
)

// WithServerInfoMetadata controls whether MCP 2026-07-28 results include the
// server identity in _meta. Identity metadata is included by default.
func WithServerInfoMetadata(include bool) ServerOption {
	return func(s *Server) {
		s.includeServerInfoMetadata = include
	}
}

func marshalResultWithServerInfo(result any, serverInfo ServerIdentity) ([]byte, error) {
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	var object map[string]json.RawMessage
	err = json.Unmarshal(raw, &object)
	if err != nil || object == nil {
		if err == nil {
			err = errors.New("MCP result must be a JSON object")
		}
		return nil, err
	}
	meta := map[string]json.RawMessage{}
	if rawMeta, ok := object["_meta"]; ok {
		err = json.Unmarshal(rawMeta, &meta)
		if err != nil {
			return nil, err
		}
		if meta == nil {
			meta = map[string]json.RawMessage{}
		}
	}
	rawServerInfo, err := json.Marshal(serverInfo)
	if err != nil {
		return nil, err
	}
	meta[serverInfoMetaKey] = rawServerInfo
	rawMeta, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	object["_meta"] = rawMeta
	return json.Marshal(object)
}
