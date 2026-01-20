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
		return errorResponse(errorCodeInternal, errorMessageInternal, nil)
	}
	if ctx == nil {
		ctx = context.Background()
	}

	switch a.tier {
	case TierP0:
		return a.serveP0(ctx, req)
	case TierP1:
		return a.serveP1(ctx, req)
	case TierP2:
		return a.serveP2(ctx, req)
	default:
		return a.serveP2(ctx, req)
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
				"allow": {formatAllowHeader(allowed)},
			}
			return errorResponse(errorCodeMethodNotAllowed, errorMessageMethodNotAllowed, headers)
		}
		return errorResponse(errorCodeNotFound, errorMessageNotFound, nil)
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
			resp = errorResponse(errorCodeInternal, errorMessageInternal, nil)
		}
	}()

	handler := a.applyMiddlewares(match.Route.Handler)
	out, handlerErr := handler(requestCtx)
	if handlerErr != nil {
		var appErr *AppError
		if errors.As(handlerErr, &appErr) {
			return errorResponse(appErr.Code, appErr.Message, nil)
		}
		return errorResponse(errorCodeInternal, errorMessageInternal, nil)
	}

	return normalizeResponse(out)
}

func (a *App) serveP1(ctx context.Context, req Request) (resp Response) {
	return a.servePortable(ctx, req, false)
}

func (a *App) serveP2(ctx context.Context, req Request) (resp Response) {
	return a.servePortable(ctx, req, true)
}

type portableServeState struct {
	method    string
	path      string
	requestID string
	origin    string
	tenantID  string
	errorCode string
}

func (a *App) servePortable(ctx context.Context, req Request, enableP2 bool) (resp Response) {
	if ctx == nil {
		ctx = context.Background()
	}

	state := portableServeState{}
	defer func() {
		if r := recover(); r != nil {
			state.errorCode = errorCodeInternal
			resp = errorResponseWithRequestID(errorCodeInternal, errorMessageInternal, nil, state.requestID)
		}
		resp = finalizeP1Response(resp, state.requestID, state.origin, a.cors)
		if enableP2 {
			a.recordObservability(state.method, state.path, state.requestID, state.tenantID, resp.Status, state.errorCode)
		}
	}()

	resp = a.servePortableCore(ctx, req, enableP2, &state)
	return resp
}

func (a *App) servePortableCore(ctx context.Context, req Request, enableP2 bool, state *portableServeState) Response {
	headers := canonicalizeHeaders(req.Headers)
	query := cloneQuery(req.Query)

	state.method = strings.ToUpper(strings.TrimSpace(req.Method))
	state.path = normalizePath(req.Path)

	state.requestID = firstHeaderValue(headers, "x-request-id")
	if state.requestID == "" {
		state.requestID = a.newRequestID()
	}

	state.origin = firstHeaderValue(headers, "origin")
	state.tenantID = extractTenantID(headers, query)

	remainingMS := remainingMSFromContext(ctx, a.clock)
	trace := portableTrace(state.origin)

	if isCorsPreflight(req.Method, headers) {
		return preflightResponse(headers)
	}

	normalized, err := normalizeRequest(req)
	if err != nil {
		state.errorCode = errorCodeForError(err)
		return responseForErrorWithRequestID(err, state.requestID)
	}

	state.method = normalized.Method
	state.path = normalized.Path
	state.tenantID = extractTenantID(normalized.Headers, normalized.Query)

	requestCtx := &Context{
		ctx:             ctx,
		Request:         normalized,
		clock:           a.clock,
		ids:             a.ids,
		RequestID:       state.requestID,
		TenantID:        state.tenantID,
		RemainingMS:     remainingMS,
		MiddlewareTrace: trace,
	}

	if maxBytes := a.limits.MaxRequestBytes; maxBytes > 0 && len(normalized.Body) > maxBytes {
		state.errorCode = errorCodeTooLarge
		return errorResponseWithRequestID(errorCodeTooLarge, errorMessageRequestTooLarge, nil, state.requestID)
	}

	match, allowed := a.router.match(state.method, state.path)
	if match == nil {
		resp, errorCode := routeNotFoundResponse(allowed, state.requestID)
		state.errorCode = errorCode
		return resp
	}
	requestCtx.Params = match.Params

	if resp, errorCode, ok := a.applyPolicy(enableP2, requestCtx, state.requestID); ok {
		state.errorCode = errorCode
		return resp
	}

	if resp, errorCode, ok := a.authorize(match.Route.AuthRequired, requestCtx, state.requestID); ok {
		state.errorCode = errorCode
		return resp
	}

	requestCtx.MiddlewareTrace = append(requestCtx.MiddlewareTrace, "handler")

	handler := a.applyMiddlewares(match.Route.Handler)
	out, handlerErr := handler(requestCtx)
	if handlerErr != nil {
		var appErr *AppError
		if errors.As(handlerErr, &appErr) {
			state.errorCode = appErr.Code
			return errorResponseWithRequestID(appErr.Code, appErr.Message, nil, state.requestID)
		}
		state.errorCode = errorCodeInternal
		return errorResponseWithRequestID(errorCodeInternal, errorMessageInternal, nil, state.requestID)
	}

	if out == nil {
		state.errorCode = errorCodeInternal
		return errorResponseWithRequestID(errorCodeInternal, errorMessageInternal, nil, state.requestID)
	}

	resp := normalizeResponse(out)
	if maxBytes := a.limits.MaxResponseBytes; maxBytes > 0 && len(resp.Body) > maxBytes {
		state.errorCode = errorCodeTooLarge
		return errorResponseWithRequestID(errorCodeTooLarge, errorMessageResponseTooLarge, nil, state.requestID)
	}

	return resp
}

func portableTrace(origin string) []string {
	trace := []string{"request_id", "recovery", "logging"}
	if origin != "" {
		trace = append(trace, "cors")
	}
	return trace
}

func preflightResponse(headers map[string][]string) Response {
	allow := firstHeaderValue(headers, "access-control-request-method")
	return Response{
		Status: 204,
		Headers: map[string][]string{
			"access-control-allow-methods": {allow},
		},
	}
}

func errorCodeForError(err error) string {
	var appErr *AppError
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return errorCodeInternal
}

func routeNotFoundResponse(allowed []string, requestID string) (Response, string) {
	if len(allowed) > 0 {
		headers := map[string][]string{
			"allow": {formatAllowHeader(allowed)},
		}
		return errorResponseWithRequestID(errorCodeMethodNotAllowed, errorMessageMethodNotAllowed, headers, requestID), errorCodeMethodNotAllowed
	}
	return errorResponseWithRequestID(errorCodeNotFound, errorMessageNotFound, nil, requestID), errorCodeNotFound
}

func (a *App) applyPolicy(enableP2 bool, requestCtx *Context, requestID string) (Response, string, bool) {
	if !enableP2 || a.policy == nil {
		return Response{}, "", false
	}

	decision, err := a.policy(requestCtx)
	if err != nil {
		return errorResponseWithRequestID(errorCodeInternal, errorMessageInternal, nil, requestID), errorCodeInternal, true
	}
	if decision == nil {
		return Response{}, "", false
	}

	code := strings.TrimSpace(decision.Code)
	if code == "" {
		return Response{}, "", false
	}

	message := strings.TrimSpace(decision.Message)
	if message == "" {
		message = defaultPolicyMessage(code)
	}

	return errorResponseWithRequestID(code, message, decision.Headers, requestID), code, true
}

func (a *App) authorize(authRequired bool, requestCtx *Context, requestID string) (Response, string, bool) {
	if !authRequired {
		return Response{}, "", false
	}

	requestCtx.MiddlewareTrace = append(requestCtx.MiddlewareTrace, "auth")

	if a.auth == nil {
		return errorResponseWithRequestID(errorCodeUnauthorized, errorMessageUnauthorized, nil, requestID), errorCodeUnauthorized, true
	}

	identity, err := a.auth(requestCtx)
	if err != nil {
		return responseForErrorWithRequestID(err, requestID), errorCodeForError(err), true
	}

	identity = strings.TrimSpace(identity)
	if identity == "" {
		return errorResponseWithRequestID(errorCodeUnauthorized, errorMessageUnauthorized, nil, requestID), errorCodeUnauthorized, true
	}

	requestCtx.AuthIdentity = identity
	return Response{}, "", false
}

func defaultPolicyMessage(code string) string {
	switch code {
	case errorCodeRateLimited:
		return errorMessageRateLimited
	case errorCodeOverloaded:
		return errorMessageOverloaded
	default:
		return errorMessageInternal
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

func finalizeP1Response(resp Response, requestID, origin string, cors CORSConfig) Response {
	headers := canonicalizeHeaders(resp.Headers)
	if requestID != "" {
		headers["x-request-id"] = []string{requestID}
	}
	if origin != "" && corsOriginAllowed(origin, cors) {
		headers["access-control-allow-origin"] = []string{origin}
		headers["vary"] = []string{"origin"}
		if cors.AllowCredentials {
			headers["access-control-allow-credentials"] = []string{"true"}
		}
		if allowHeaders := corsAllowHeadersValue(cors); allowHeaders != "" {
			headers["access-control-allow-headers"] = []string{allowHeaders}
		}
	}
	resp.Headers = headers
	return resp
}
