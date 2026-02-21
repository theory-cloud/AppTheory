package mcp

import (
	"context"
	"encoding/json"
)

type resourcesReadParams struct {
	URI string `json:"uri"`
}

func (s *Server) handleResourcesList(req *Request) *Response {
	resources := s.resourceRegistry.List()
	return NewResultResponse(req.ID, map[string]any{
		"resources": resources,
	})
}

func (s *Server) handleResourcesRead(ctx context.Context, req *Request) *Response {
	var params resourcesReadParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
	}
	if params.URI == "" {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing uri")
	}

	contents, err := s.resourceRegistry.Read(ctx, params.URI)
	if err != nil {
		if isNotFound(err, "resource not found:") {
			return NewErrorResponse(req.ID, CodeInvalidParams, err.Error())
		}
		return NewErrorResponse(req.ID, CodeServerError, err.Error())
	}

	return NewResultResponse(req.ID, map[string]any{
		"contents": contents,
	})
}
