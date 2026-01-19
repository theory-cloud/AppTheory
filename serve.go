package apptheory

import (
	"context"
	"errors"
	"strings"
	"time"
)

func (a *App) Handle(method, pattern string, handler Handler, opts ...RouteOption) *App {
	if a == nil {
		return a
	}
	if a.router == nil {
		a.router = newRouter()
	}
	routeOpts := routeOptions{}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		opt(&routeOpts)
	}
	a.router.add(method, pattern, handler, routeOpts)
	return a
}

func (a *App) Get(pattern string, handler Handler, opts ...RouteOption) *App {
	return a.Handle("GET", pattern, handler, opts...)
}

func (a *App) Post(pattern string, handler Handler, opts ...RouteOption) *App {
	return a.Handle("POST", pattern, handler, opts...)
}

func (a *App) Put(pattern string, handler Handler, opts ...RouteOption) *App {
	return a.Handle("PUT", pattern, handler, opts...)
}

func (a *App) Delete(pattern string, handler Handler, opts ...RouteOption) *App {
	return a.Handle("DELETE", pattern, handler, opts...)
}

func (a *App) Serve(ctx context.Context, req Request) (resp Response) {
	if a == nil || a.router == nil {
		return errorResponse("app.internal", "internal error", nil)
	}
	if ctx == nil {
		ctx = context.Background()
	}

	switch a.tier {
	case TierP1, TierP2:
		return a.serveP1(ctx, req)
	case TierP0, "":
		fallthrough
	default:
		return a.serveP0(ctx, req)
	}
}

func (a *App) serveP0(ctx context.Context, req Request) (resp Response) {
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

func (a *App) serveP1(ctx context.Context, req Request) (resp Response) {
	headers := canonicalizeHeaders(req.Headers)
	query := cloneQuery(req.Query)

	requestID := firstHeaderValue(headers, "x-request-id")
	if requestID == "" {
		requestID = a.newRequestID()
	}

	origin := firstHeaderValue(headers, "origin")
	remainingMS := remainingMSFromContext(ctx, a.clock)

	trace := []string{"request_id", "recovery", "logging"}
	if origin != "" {
		trace = append(trace, "cors")
	}

	if isCorsPreflight(req.Method, headers) {
		allow := firstHeaderValue(headers, "access-control-request-method")
		out := Response{
			Status: 204,
			Headers: map[string][]string{
				"access-control-allow-methods": []string{allow},
			},
		}
		return finalizeP1Response(out, requestID, origin)
	}

	normalized, err := normalizeRequest(req)
	if err != nil {
		return finalizeP1Response(responseForErrorWithRequestID(err, requestID), requestID, origin)
	}

	tenantID := extractTenantID(headers, query)

	requestCtx := &Context{
		ctx:            ctx,
		Request:        normalized,
		Params:         nil,
		clock:          a.clock,
		ids:            a.ids,
		RequestID:      requestID,
		TenantID:       tenantID,
		AuthIdentity:   "",
		RemainingMS:    remainingMS,
		MiddlewareTrace: trace,
	}

	defer func() {
		if r := recover(); r != nil {
			resp = finalizeP1Response(
				errorResponseWithRequestID("app.internal", "internal error", nil, requestID),
				requestID,
				origin,
			)
		}
	}()

	if max := a.limits.MaxRequestBytes; max > 0 && len(normalized.Body) > max {
		return finalizeP1Response(
			errorResponseWithRequestID("app.too_large", "request too large", nil, requestID),
			requestID,
			origin,
		)
	}

	match, allowed := a.router.match(normalized.Method, normalized.Path)
	if match == nil {
		if len(allowed) > 0 {
			headers := map[string][]string{
				"allow": []string{formatAllowHeader(allowed)},
			}
			return finalizeP1Response(
				errorResponseWithRequestID("app.method_not_allowed", "method not allowed", headers, requestID),
				requestID,
				origin,
			)
		}
		return finalizeP1Response(
			errorResponseWithRequestID("app.not_found", "not found", nil, requestID),
			requestID,
			origin,
		)
	}
	requestCtx.Params = match.Params

	if match.Route.AuthRequired {
		requestCtx.MiddlewareTrace = append(requestCtx.MiddlewareTrace, "auth")
		if a.auth == nil {
			return finalizeP1Response(
				errorResponseWithRequestID("app.unauthorized", "unauthorized", nil, requestID),
				requestID,
				origin,
			)
		}
		identity, err := a.auth(requestCtx)
		if err != nil {
			return finalizeP1Response(responseForErrorWithRequestID(err, requestID), requestID, origin)
		}
		identity = strings.TrimSpace(identity)
		if identity == "" {
			return finalizeP1Response(
				errorResponseWithRequestID("app.unauthorized", "unauthorized", nil, requestID),
				requestID,
				origin,
			)
		}
		requestCtx.AuthIdentity = identity
	}

	requestCtx.MiddlewareTrace = append(requestCtx.MiddlewareTrace, "handler")

	out, handlerErr := match.Route.Handler(requestCtx)
	if handlerErr != nil {
		var appErr *AppError
		if errors.As(handlerErr, &appErr) {
			return finalizeP1Response(
				errorResponseWithRequestID(appErr.Code, appErr.Message, nil, requestID),
				requestID,
				origin,
			)
		}
		return finalizeP1Response(
			errorResponseWithRequestID("app.internal", "internal error", nil, requestID),
			requestID,
			origin,
		)
	}

	if out == nil {
		return finalizeP1Response(
			errorResponseWithRequestID("app.internal", "internal error", nil, requestID),
			requestID,
			origin,
		)
	}

	resp = normalizeResponse(out)
	if max := a.limits.MaxResponseBytes; max > 0 && len(resp.Body) > max {
		resp = errorResponseWithRequestID("app.too_large", "response too large", nil, requestID)
	}

	return finalizeP1Response(resp, requestID, origin)
}

func (a *App) newRequestID() string {
	if a == nil || a.ids == nil {
		return RandomIDGenerator{}.NewID()
	}
	return a.ids.NewID()
}

func firstHeaderValue(headers map[string][]string, key string) string {
	values := headers[strings.ToLower(strings.TrimSpace(key))]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func extractTenantID(headers map[string][]string, query map[string][]string) string {
	tenant := firstHeaderValue(headers, "x-tenant-id")
	if tenant != "" {
		return tenant
	}
	if values := query["tenant"]; len(values) > 0 {
		return values[0]
	}
	return ""
}

func isCorsPreflight(method string, headers map[string][]string) bool {
	if strings.ToUpper(strings.TrimSpace(method)) != "OPTIONS" {
		return false
	}
	return firstHeaderValue(headers, "access-control-request-method") != ""
}

func remainingMSFromContext(ctx context.Context, clock Clock) int {
	deadline, ok := ctx.Deadline()
	if !ok {
		return 0
	}
	now := time.Now()
	if clock != nil {
		now = clock.Now()
	}
	d := deadline.Sub(now)
	if d <= 0 {
		return 0
	}
	return int(d / time.Millisecond)
}

func finalizeP1Response(resp Response, requestID, origin string) Response {
	headers := canonicalizeHeaders(resp.Headers)
	if requestID != "" {
		headers["x-request-id"] = []string{requestID}
	}
	if origin != "" {
		headers["access-control-allow-origin"] = []string{origin}
		headers["vary"] = []string{"origin"}
	}
	resp.Headers = headers
	return resp
}
