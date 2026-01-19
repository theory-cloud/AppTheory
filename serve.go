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
	case TierP2:
		return a.serveP2(ctx, req)
	case TierP1:
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
	return a.servePortable(ctx, req, false)
}

func (a *App) serveP2(ctx context.Context, req Request) (resp Response) {
	return a.servePortable(ctx, req, true)
}

func (a *App) servePortable(ctx context.Context, req Request, enableP2 bool) (resp Response) {
	headers := canonicalizeHeaders(req.Headers)
	query := cloneQuery(req.Query)

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	path := normalizePath(req.Path)

	requestID := firstHeaderValue(headers, "x-request-id")
	if requestID == "" {
		requestID = a.newRequestID()
	}

	origin := firstHeaderValue(headers, "origin")
	tenantID := extractTenantID(headers, query)
	remainingMS := remainingMSFromContext(ctx, a.clock)

	trace := []string{"request_id", "recovery", "logging"}
	if origin != "" {
		trace = append(trace, "cors")
	}

	errorCode := ""
	defer func() {
		if r := recover(); r != nil {
			errorCode = "app.internal"
			resp = errorResponseWithRequestID("app.internal", "internal error", nil, requestID)
		}
		resp = finalizeP1Response(resp, requestID, origin)
		if enableP2 {
			a.recordObservability(method, path, requestID, tenantID, resp.Status, errorCode)
		}
	}()

	if isCorsPreflight(req.Method, headers) {
		allow := firstHeaderValue(headers, "access-control-request-method")
		resp = Response{
			Status: 204,
			Headers: map[string][]string{
				"access-control-allow-methods": []string{allow},
			},
		}
		return resp
	}

	normalized, err := normalizeRequest(req)
	if err != nil {
		var appErr *AppError
		if errors.As(err, &appErr) {
			errorCode = appErr.Code
		} else {
			errorCode = "app.internal"
		}
		resp = responseForErrorWithRequestID(err, requestID)
		return resp
	}

	method = normalized.Method
	path = normalized.Path
	tenantID = extractTenantID(normalized.Headers, normalized.Query)

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

	if max := a.limits.MaxRequestBytes; max > 0 && len(normalized.Body) > max {
		errorCode = "app.too_large"
		resp = errorResponseWithRequestID("app.too_large", "request too large", nil, requestID)
		return resp
	}

	match, allowed := a.router.match(method, path)
	if match == nil {
		if len(allowed) > 0 {
			errorCode = "app.method_not_allowed"
			headers := map[string][]string{
				"allow": []string{formatAllowHeader(allowed)},
			}
			resp = errorResponseWithRequestID("app.method_not_allowed", "method not allowed", headers, requestID)
			return resp
		}
		errorCode = "app.not_found"
		resp = errorResponseWithRequestID("app.not_found", "not found", nil, requestID)
		return resp
	}
	requestCtx.Params = match.Params

	if enableP2 && a.policy != nil {
		decision, err := a.policy(requestCtx)
		if err != nil {
			errorCode = "app.internal"
			resp = errorResponseWithRequestID("app.internal", "internal error", nil, requestID)
			return resp
		}
		if decision != nil {
			code := strings.TrimSpace(decision.Code)
			if code != "" {
				message := strings.TrimSpace(decision.Message)
				if message == "" {
					message = defaultPolicyMessage(code)
				}
				errorCode = code
				resp = errorResponseWithRequestID(code, message, decision.Headers, requestID)
				return resp
			}
		}
	}

	if match.Route.AuthRequired {
		requestCtx.MiddlewareTrace = append(requestCtx.MiddlewareTrace, "auth")
		if a.auth == nil {
			errorCode = "app.unauthorized"
			resp = errorResponseWithRequestID("app.unauthorized", "unauthorized", nil, requestID)
			return resp
		}
		identity, err := a.auth(requestCtx)
		if err != nil {
			var appErr *AppError
			if errors.As(err, &appErr) {
				errorCode = appErr.Code
			} else {
				errorCode = "app.internal"
			}
			resp = responseForErrorWithRequestID(err, requestID)
			return resp
		}
		identity = strings.TrimSpace(identity)
		if identity == "" {
			errorCode = "app.unauthorized"
			resp = errorResponseWithRequestID("app.unauthorized", "unauthorized", nil, requestID)
			return resp
		}
		requestCtx.AuthIdentity = identity
	}

	requestCtx.MiddlewareTrace = append(requestCtx.MiddlewareTrace, "handler")

	out, handlerErr := match.Route.Handler(requestCtx)
	if handlerErr != nil {
		var appErr *AppError
		if errors.As(handlerErr, &appErr) {
			errorCode = appErr.Code
			resp = errorResponseWithRequestID(appErr.Code, appErr.Message, nil, requestID)
			return resp
		}
		errorCode = "app.internal"
		resp = errorResponseWithRequestID("app.internal", "internal error", nil, requestID)
		return resp
	}

	if out == nil {
		errorCode = "app.internal"
		resp = errorResponseWithRequestID("app.internal", "internal error", nil, requestID)
		return resp
	}

	resp = normalizeResponse(out)
	if max := a.limits.MaxResponseBytes; max > 0 && len(resp.Body) > max {
		errorCode = "app.too_large"
		resp = errorResponseWithRequestID("app.too_large", "response too large", nil, requestID)
	}

	return resp
}

func defaultPolicyMessage(code string) string {
	switch code {
	case "app.rate_limited":
		return "rate limited"
	case "app.overloaded":
		return "overloaded"
	default:
		return "internal error"
	}
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
