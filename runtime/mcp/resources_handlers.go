package mcp

import (
	"context"
	"encoding/json"
)

type resourcesReadParams struct {
	URI string `json:"uri"`
}

type resourcesSubscriptionParams struct {
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

func (s *Server) handleResourcesSubscribe(ctx context.Context, req *Request, sessionID string) *Response {
	return s.handleResourceSubscription(ctx, req, sessionID, s.resourceSubscribeHook)
}

func (s *Server) handleResourcesUnsubscribe(ctx context.Context, req *Request, sessionID string) *Response {
	return s.handleResourceSubscription(ctx, req, sessionID, s.resourceUnsubscribeHook)
}

func (s *Server) handleResourceSubscription(
	ctx context.Context,
	req *Request,
	sessionID string,
	hook ResourceSubscriptionHook,
) *Response {
	if !s.hasResourceSubscriptionHooks() || hook == nil {
		return NewErrorResponse(req.ID, CodeMethodNotFound, "Method not found: "+req.Method)
	}

	var params resourcesSubscriptionParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
	}
	if params.URI == "" {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing uri")
	}

	if err := hook(ctx, ResourceSubscription{SessionID: sessionID, URI: params.URI}); err != nil {
		return NewErrorResponse(req.ID, CodeServerError, err.Error())
	}

	return NewResultResponse(req.ID, map[string]any{})
}
