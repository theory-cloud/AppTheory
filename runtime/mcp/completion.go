package mcp

import (
	"context"
	"encoding/json"
	"fmt"
)

const (
	completionRefPrompt   = "ref/prompt"
	completionRefResource = "ref/resource"
)

// CompletionRef identifies the prompt or resource template being completed.
type CompletionRef struct {
	Type string `json:"type"`
	Name string `json:"name,omitempty"`
	URI  string `json:"uri,omitempty"`
}

// CompletionArgument identifies the argument currently being completed.
type CompletionArgument struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// CompletionContext carries optional previously-resolved arguments.
type CompletionContext struct {
	Arguments map[string]string `json:"arguments,omitempty"`
}

// CompletionRequest is passed to completion hooks.
type CompletionRequest struct {
	SessionID string             `json:"sessionId"`
	Ref       CompletionRef      `json:"ref"`
	Argument  CompletionArgument `json:"argument"`
	Context   CompletionContext  `json:"context,omitempty"`
}

// Completion contains completion values returned to the client.
type Completion struct {
	Values  []string `json:"values"`
	Total   *int     `json:"total,omitempty"`
	HasMore *bool    `json:"hasMore,omitempty"`
}

// CompletionResult is the MCP completion/complete result.
type CompletionResult struct {
	Completion Completion `json:"completion"`
}

// CompletionHook handles a prompt or resource completion request.
type CompletionHook func(ctx context.Context, req CompletionRequest) (*CompletionResult, error)

type completionCompleteParams struct {
	Ref      CompletionRef      `json:"ref"`
	Argument CompletionArgument `json:"argument"`
	Context  CompletionContext  `json:"context,omitempty"`
}

func (s *Server) handleCompletionComplete(ctx context.Context, req *Request, sessionID string) *Response {
	if !s.hasCompletionHooks() {
		return NewErrorResponse(req.ID, CodeMethodNotFound, "Method not found: "+req.Method)
	}

	var params completionCompleteParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: "+err.Error())
	}
	if params.Ref.Type == "" {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing ref.type")
	}
	if params.Argument.Name == "" {
		return NewErrorResponse(req.ID, CodeInvalidParams, "Invalid params: missing argument.name")
	}

	hook, errResp := s.completionHookForRef(req.ID, params.Ref)
	if errResp != nil {
		return errResp
	}

	result, err := hook(ctx, CompletionRequest{
		SessionID: sessionID,
		Ref:       params.Ref,
		Argument:  params.Argument,
		Context:   params.Context,
	})
	if err != nil {
		return NewErrorResponse(req.ID, CodeServerError, err.Error())
	}
	if errResp := validateCompletionResult(req.ID, result); errResp != nil {
		return errResp
	}

	return NewResultResponse(req.ID, result)
}

func (s *Server) completionHookForRef(reqID any, ref CompletionRef) (CompletionHook, *Response) {
	switch ref.Type {
	case completionRefPrompt:
		if ref.Name == "" {
			return nil, NewErrorResponse(reqID, CodeInvalidParams, "Invalid params: missing ref.name")
		}
		if s.promptCompletionHook == nil {
			return nil, NewErrorResponse(reqID, CodeInvalidParams, "Invalid params: prompt completions not configured")
		}
		return s.promptCompletionHook, nil
	case completionRefResource:
		if ref.URI == "" {
			return nil, NewErrorResponse(reqID, CodeInvalidParams, "Invalid params: missing ref.uri")
		}
		if s.resourceCompletionHook == nil {
			return nil, NewErrorResponse(reqID, CodeInvalidParams, "Invalid params: resource completions not configured")
		}
		return s.resourceCompletionHook, nil
	default:
		return nil, NewErrorResponse(reqID, CodeInvalidParams, fmt.Sprintf("Invalid params: unknown ref.type %q", ref.Type))
	}
}

func validateCompletionResult(reqID any, result *CompletionResult) *Response {
	if result == nil {
		return NewErrorResponse(reqID, CodeServerError, "completion hook returned nil result")
	}
	if result.Completion.Values == nil {
		return NewErrorResponse(reqID, CodeServerError, "completion hook returned nil values")
	}
	if len(result.Completion.Values) > 100 {
		return NewErrorResponse(reqID, CodeServerError, "completion hook returned too many values")
	}
	return nil
}
