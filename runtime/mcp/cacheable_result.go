package mcp

import (
	"encoding/json"
	"strings"
	"time"
)

// CacheScope controls whether an MCP cacheable result may be shared across
// authorization contexts.
type CacheScope string

const (
	// CacheScopePrivate limits cached results to the same authorization
	// context. It is the fail-closed default.
	CacheScopePrivate CacheScope = "private"
	// CacheScopePublic allows cached results to be shared across authorization
	// contexts and must be configured explicitly.
	CacheScopePublic CacheScope = "public"
)

// CacheHint configures the cache metadata for one MCP result surface.
//
// A zero or negative TTL is emitted as ttlMs: 0. Scope defaults to private;
// only CacheScopePublic opts a surface into shared caching.
type CacheHint struct {
	TTL   time.Duration
	Scope CacheScope
}

// CacheableResultConfig configures per-surface caching hints for MCP
// 2026-07-28 complete results.
//
// Every omitted surface defaults to ttlMs: 0 and cacheScope: private.
type CacheableResultConfig struct {
	ServerDiscover        CacheHint
	ToolsList             CacheHint
	PromptsList           CacheHint
	ResourcesList         CacheHint
	ResourceTemplatesList CacheHint
	ResourcesRead         CacheHint
}

// WithCacheableResultConfig sets the per-surface cache hints emitted on MCP
// 2026-07-28 complete cacheable results.
func WithCacheableResultConfig(config CacheableResultConfig) ServerOption {
	return func(s *Server) {
		s.cacheableResults = normalizeCacheableResultConfig(config)
	}
}

func normalizeCacheableResultConfig(config CacheableResultConfig) CacheableResultConfig {
	return CacheableResultConfig{
		ServerDiscover:        normalizeCacheHint(config.ServerDiscover),
		ToolsList:             normalizeCacheHint(config.ToolsList),
		PromptsList:           normalizeCacheHint(config.PromptsList),
		ResourcesList:         normalizeCacheHint(config.ResourcesList),
		ResourceTemplatesList: normalizeCacheHint(config.ResourceTemplatesList),
		ResourcesRead:         normalizeCacheHint(config.ResourcesRead),
	}
}

func normalizeCacheHint(hint CacheHint) CacheHint {
	if hint.TTL < 0 {
		hint.TTL = 0
	}
	if hint.Scope != CacheScopePublic {
		hint.Scope = CacheScopePrivate
	}
	return hint
}

func (s *Server) finalizeResponseForProtocol(
	req *Request,
	resp *Response,
	protocolVersion string,
) *Response {
	var serverInfo *ServerIdentity
	if s.includeServerInfoMetadata {
		serverInfo = &ServerIdentity{Name: s.name, Version: s.version}
	}
	prepared := responseForProtocol(resp, protocolVersion, serverInfo)
	if protocolVersion != ProtocolVersion20260728 || prepared == nil || prepared.Error != nil {
		return prepared
	}
	hint, ok := s.cacheHintForRequest(req)
	if !ok {
		return prepared
	}
	if requestIsMultiRoundTripRetry(req) {
		hint = CacheHint{}
	}
	return applyCacheHint(prepared, hint)
}

func (s *Server) cacheHintForRequest(req *Request) (CacheHint, bool) {
	if req == nil {
		return CacheHint{}, false
	}
	switch req.Method {
	case methodServerDiscover:
		return s.cacheableResults.ServerDiscover, true
	case methodToolsList:
		return s.cacheableResults.ToolsList, true
	case methodPromptsList:
		return s.cacheableResults.PromptsList, true
	case methodResourcesList:
		return s.cacheableResults.ResourcesList, true
	case methodResourcesTemplatesList:
		return s.cacheableResults.ResourceTemplatesList, true
	case methodResourcesRead:
		return s.cacheableResults.ResourcesRead, true
	default:
		return CacheHint{}, false
	}
}

func requestIsMultiRoundTripRetry(req *Request) bool {
	if req == nil || len(req.Params) == 0 {
		return false
	}
	var params map[string]json.RawMessage
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return false
	}
	_, hasInputResponses := params["inputResponses"]
	_, hasRequestState := params["requestState"]
	return hasInputResponses || hasRequestState
}

func applyCacheHint(resp *Response, rawHint CacheHint) *Response {
	raw, ok := resp.Result.(json.RawMessage)
	if !ok {
		return resp
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(raw, &result); err != nil || result == nil {
		return NewErrorResponse(resp.ID, CodeInternalError, "internal error")
	}
	var resultType string
	if err := json.Unmarshal(result["resultType"], &resultType); err != nil ||
		strings.TrimSpace(resultType) != string(ResultTypeComplete) {
		return resp
	}

	hint := normalizeCacheHint(rawHint)
	ttlMS, err := json.Marshal(hint.TTL.Milliseconds())
	if err != nil {
		return NewErrorResponse(resp.ID, CodeInternalError, "internal error")
	}
	cacheScope, err := json.Marshal(hint.Scope)
	if err != nil {
		return NewErrorResponse(resp.ID, CodeInternalError, "internal error")
	}
	result["ttlMs"] = ttlMS
	result["cacheScope"] = cacheScope
	encoded, err := json.Marshal(result)
	if err != nil {
		return NewErrorResponse(resp.ID, CodeInternalError, "internal error")
	}
	resp.Result = json.RawMessage(encoded)
	return resp
}
