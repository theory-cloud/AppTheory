package apptheory

import (
	"context"
	"encoding/json"
)

const (
	jsonHandlerErrorCodeEmptyBody      = "EMPTY_BODY"
	jsonHandlerErrorMessageEmptyBody   = "Request body is empty"
	jsonHandlerErrorCodeInvalidJSON    = "INVALID_JSON"
	jsonHandlerErrorMessageInvalidJSON = "Invalid JSON in request body"
)

// JSONHandler adapts a typed JSON handler into an AppTheory Handler.
//
// It parses the request body as JSON into Req, invokes the typed handler,
// and returns a 200 JSON response with the handler's response value.
//
// On empty or invalid JSON bodies, it returns a 400 AppTheoryError with
// Lift-compatible error codes/messages.
func JSONHandler[Req, Resp any](handler func(*Context, Req) (Resp, error)) Handler {
	return func(ctx *Context) (*Response, error) {
		req, err := parseJSONRequest[Req](ctx)
		if err != nil {
			return nil, err
		}

		resp, err := handler(ctx, req)
		if err != nil {
			return nil, err
		}

		return JSON(200, resp)
	}
}

// JSONHandlerContext adapts a typed JSON handler that uses context.Context.
func JSONHandlerContext[Req, Resp any](handler func(context.Context, Req) (Resp, error)) Handler {
	return JSONHandler(func(ctx *Context, req Req) (Resp, error) {
		return handler(ctx.Context(), req)
	})
}

func parseJSONRequest[Req any](ctx *Context) (Req, error) {
	var zero Req
	if ctx == nil || ctx.Request.Body == nil || len(ctx.Request.Body) == 0 {
		return zero, NewAppTheoryError(jsonHandlerErrorCodeEmptyBody, jsonHandlerErrorMessageEmptyBody).
			WithStatusCode(400)
	}

	var req Req
	if err := json.Unmarshal(ctx.Request.Body, &req); err != nil {
		return zero, NewAppTheoryError(jsonHandlerErrorCodeInvalidJSON, jsonHandlerErrorMessageInvalidJSON).
			WithStatusCode(400).
			WithCause(err)
	}
	return req, nil
}
