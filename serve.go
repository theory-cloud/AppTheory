package apptheory

import (
	"context"
	"errors"
)

func (a *App) Handle(method, pattern string, handler Handler) *App {
	if a == nil {
		return a
	}
	if a.router == nil {
		a.router = newRouter()
	}
	a.router.add(method, pattern, handler)
	return a
}

func (a *App) Get(pattern string, handler Handler) *App {
	return a.Handle("GET", pattern, handler)
}

func (a *App) Post(pattern string, handler Handler) *App {
	return a.Handle("POST", pattern, handler)
}

func (a *App) Put(pattern string, handler Handler) *App {
	return a.Handle("PUT", pattern, handler)
}

func (a *App) Delete(pattern string, handler Handler) *App {
	return a.Handle("DELETE", pattern, handler)
}

func (a *App) Serve(ctx context.Context, req Request) (resp Response) {
	if a == nil || a.router == nil {
		return errorResponse("app.internal", "internal error", nil)
	}
	if ctx == nil {
		ctx = context.Background()
	}

	normalized, err := normalizeRequest(req)
	if err != nil {
		return responseForError(err)
	}

	match, allowed := a.router.match(normalized.Method, normalized.Path)
	if match == nil {
		if len(allowed) > 0 {
			headers := map[string][]string{
				"allow": []string{formatAllowHeader(allowed)},
			}
			return errorResponse("app.method_not_allowed", "method not allowed", headers)
		}
		return errorResponse("app.not_found", "not found", nil)
	}

	requestCtx := &Context{
		ctx:     ctx,
		Request: normalized,
		Params:  match.Params,
		clock:   a.clock,
		ids:     a.ids,
	}

	defer func() {
		if r := recover(); r != nil {
			resp = errorResponse("app.internal", "internal error", nil)
		}
	}()

	out, handlerErr := match.Route.Handler(requestCtx)
	if handlerErr != nil {
		var appErr *AppError
		if errors.As(handlerErr, &appErr) {
			return errorResponse(appErr.Code, appErr.Message, nil)
		}
		return errorResponse("app.internal", "internal error", nil)
	}

	return normalizeResponse(out)
}
