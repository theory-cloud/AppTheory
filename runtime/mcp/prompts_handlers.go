package mcp

import (
	"context"
	"encoding/json"
)

type promptsGetParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

func (s *Server) handlePromptsList(req *Request) *Response {
	prompts := s.promptRegistry.List()
	return NewResultResponse(req.ID, map[string]any{
		"prompts": prompts,
	})
}

func (s *Server) handlePromptsGet(ctx context.Context, req *Request) *Response {
	var params promptsGetParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
	}
	if params.Name == "" {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing name")
	}

	out, err := s.promptRegistry.Get(ctx, params.Name, params.Arguments)
	if err != nil {
		if isNotFound(err, "prompt not found:") {
			return NewErrorResponse(req.ID, CodeInvalidParams, err.Error())
		}
		return NewErrorResponse(req.ID, CodeServerError, err.Error())
	}

	return NewResultResponse(req.ID, out)
}
