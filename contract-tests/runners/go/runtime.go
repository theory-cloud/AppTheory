package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

const (
	appErrorBadRequest       = "app.bad_request"
	appErrorValidationFailed = "app.validation_failed"
	appErrorUnauthorized     = "app.unauthorized"
	appErrorForbidden        = "app.forbidden"
	appErrorNotFound         = "app.not_found"
	appErrorMethodNotAllowed = "app.method_not_allowed"
	appErrorConflict         = "app.conflict"
	appErrorTooLarge         = "app.too_large"
	appErrorRateLimited      = "app.rate_limited"
	appErrorOverloaded       = "app.overloaded"
	appErrorInternal         = "app.internal"
)

const (
	msgInvalidJSON      = "invalid json"
	msgUnauthorized     = "unauthorized"
	msgForbidden        = "forbidden"
	msgNotFound         = "not found"
	msgMethodNotAllowed = "method not allowed"
	msgRequestTooLarge  = "request too large"
	msgResponseTooLarge = "response too large"
	msgRateLimited      = "rate limited"
	msgOverloaded       = "overloaded"
	msgInternal         = "internal error"
	authorizedIdentity  = "authorized"
)

type CanonicalRequest struct {
	Method          string
	Path            string
	Query           map[string][]string
	Headers         map[string][]string
	Cookies         map[string]string
	Body            []byte
	IsBase64        bool
	PathParams      map[string]string
	RequestID       string
	TenantID        string
	AuthIdentity    string
	RemainingMS     int
	MiddlewareTrace []string
}

type CanonicalResponse struct {
	Status   int
	Headers  map[string][]string
	Cookies  []string
	Body     []byte
	IsBase64 bool
}

type AppError struct {
	Code    string
	Message string
}

func (e *AppError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func appErrorResponse(code, message string, headers map[string][]string, requestID string) CanonicalResponse {
	if headers == nil {
		headers = map[string][]string{}
	}
	headers = cloneHeaders(headers)
	headers["content-type"] = []string{"application/json; charset=utf-8"}

	errBody := map[string]any{
		"code":    code,
		"message": message,
	}
	if requestID != "" {
		errBody["request_id"] = requestID
	}

	body, err := json.Marshal(map[string]any{
		"error": errBody,
	})
	if err != nil {
		body = []byte(`{"error":{"code":"app.internal","message":"internal error"}}`)
	}

	return CanonicalResponse{
		Status:   statusForError(code),
		Headers:  headers,
		Cookies:  nil,
		Body:     body,
		IsBase64: false,
	}
}

func statusForError(code string) int {
	switch code {
	case appErrorBadRequest, appErrorValidationFailed:
		return 400
	case appErrorUnauthorized:
		return 401
	case appErrorForbidden:
		return 403
	case appErrorNotFound:
		return 404
	case appErrorMethodNotAllowed:
		return 405
	case appErrorConflict:
		return 409
	case appErrorTooLarge:
		return 413
	case appErrorRateLimited:
		return 429
	case appErrorOverloaded:
		return 503
	case appErrorInternal:
		return 500
	default:
		return 500
	}
}

type compiledRoute struct {
	Method       string
	Pattern      string
	Segments     []string
	Handler      string
	AuthRequired bool
}

type fixtureApp struct {
	routes   []compiledRoute
	enableP1 bool
	enableP2 bool
	limits   FixtureLimits

	logs    []FixtureLogRecord
	metrics []FixtureMetricRecord
	spans   []FixtureSpanRecord
}

func enableP1ForTier(tier string) bool {
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case "p1", "p2":
		return true
	default:
		return false
	}
}

func enableP2ForTier(tier string) bool {
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case "p2":
		return true
	default:
		return false
	}
}

func newFixtureApp(setup FixtureSetup, tier string) (*fixtureApp, error) {
	var compiled []compiledRoute
	for _, r := range setup.Routes {
		if strings.TrimSpace(r.Method) == "" || strings.TrimSpace(r.Path) == "" || strings.TrimSpace(r.Handler) == "" {
			return nil, errors.New("route entries must have method, path, and handler")
		}
		method := strings.ToUpper(strings.TrimSpace(r.Method))
		pattern := strings.TrimSpace(r.Path)
		segments := splitPath(pattern)
		compiled = append(compiled, compiledRoute{
			Method:       method,
			Pattern:      pattern,
			Segments:     segments,
			Handler:      r.Handler,
			AuthRequired: r.AuthRequired,
		})
	}

	return &fixtureApp{
		routes:   compiled,
		enableP1: enableP1ForTier(tier),
		enableP2: enableP2ForTier(tier),
		limits:   setup.Limits,
	}, nil
}

func splitPath(path string) []string {
	path = strings.TrimSpace(path)
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
}

type matchResult struct {
	Route      compiledRoute
	PathParams map[string]string
}

func (a *fixtureApp) match(method, path string) (*matchResult, []string) {
	method = strings.ToUpper(strings.TrimSpace(method))
	pathSegments := splitPath(path)

	var allowed []string
	for _, r := range a.routes {
		params, ok := matchPath(r.Segments, pathSegments)
		if !ok {
			continue
		}
		allowed = append(allowed, r.Method)
		if r.Method == method {
			return &matchResult{Route: r, PathParams: params}, allowed
		}
	}
	return nil, allowed
}

func matchPath(patternSegments, pathSegments []string) (map[string]string, bool) {
	if len(patternSegments) != len(pathSegments) {
		return nil, false
	}
	params := map[string]string{}
	for i, pattern := range patternSegments {
		value := pathSegments[i]
		if value == "" {
			return nil, false
		}
		if strings.HasPrefix(pattern, "{") && strings.HasSuffix(pattern, "}") && len(pattern) > 2 {
			name := pattern[1 : len(pattern)-1]
			params[name] = value
			continue
		}
		if pattern != value {
			return nil, false
		}
	}
	return params, true
}

func (a *fixtureApp) handle(req CanonicalRequest) (resp CanonicalResponse) {
	requestID := ""
	origin := ""
	errorCode := ""

	a.logs = nil
	a.metrics = nil
	a.spans = nil

	defer func() {
		if r := recover(); r != nil {
			errorCode = appErrorInternal
			resp = appErrorResponse(appErrorInternal, msgInternal, nil, requestID)
		}
		resp = a.finish(req, resp, requestID, origin, errorCode)
	}()

	if a.enableP1 {
		var coreCode string
		resp, requestID, origin, coreCode = a.handleP1(&req)
		errorCode = coreCode
		return resp
	}

	resp, errorCode = a.handleP0(&req)
	return resp
}

func (a *fixtureApp) handleP1(req *CanonicalRequest) (CanonicalResponse, string, string, string) {
	requestID, origin := a.initP1(req)

	if origin != "" && isCorsPreflight(req.Method, req.Headers) {
		return CanonicalResponse{
			Status: 204,
			Headers: map[string][]string{
				"access-control-allow-methods": {
					firstHeaderValue(req.Headers, "access-control-request-method"),
				},
			},
		}, requestID, origin, ""
	}

	if a.limits.MaxRequestBytes > 0 && len(req.Body) > a.limits.MaxRequestBytes {
		return appErrorResponse(appErrorTooLarge, msgRequestTooLarge, nil, requestID), requestID, origin, appErrorTooLarge
	}

	if a.enableP2 {
		forcedResp, forcedCode, ok := forcedP2Response(*req, requestID)
		if ok {
			return forcedResp, requestID, origin, forcedCode
		}
	}

	match, allowed := a.match(req.Method, req.Path)
	if match == nil {
		resp, errorCode := missingRouteResponse(allowed, requestID)
		return resp, requestID, origin, errorCode
	}

	req.PathParams = match.PathParams
	if match.Route.AuthRequired {
		if authResp, ok := handleAuth(req, requestID); ok {
			return authResp, requestID, origin, appErrorUnauthorized
		}
	}

	req.MiddlewareTrace = append(req.MiddlewareTrace, "handler")

	handler := builtInHandler(match.Route.Handler)
	if handler == nil {
		return appErrorResponse(appErrorInternal, msgInternal, nil, requestID), requestID, origin, appErrorInternal
	}

	resp, err := handler(*req)
	if err != nil {
		errorResp, errorCode := responseForHandlerError(err, requestID)
		return errorResp, requestID, origin, errorCode
	}

	if a.limits.MaxResponseBytes > 0 && len(resp.Body) > a.limits.MaxResponseBytes {
		return appErrorResponse(appErrorTooLarge, msgResponseTooLarge, nil, requestID), requestID, origin, appErrorTooLarge
	}

	return resp, requestID, origin, ""
}

func (a *fixtureApp) handleP0(req *CanonicalRequest) (CanonicalResponse, string) {
	match, allowed := a.match(req.Method, req.Path)
	if match == nil {
		resp, errorCode := missingRouteResponse(allowed, "")
		return resp, errorCode
	}

	req.PathParams = match.PathParams

	handler := builtInHandler(match.Route.Handler)
	if handler == nil {
		return appErrorResponse(appErrorInternal, msgInternal, nil, ""), appErrorInternal
	}

	resp, err := handler(*req)
	if err != nil {
		errorResp, errorCode := responseForHandlerError(err, "")
		return errorResp, errorCode
	}

	return resp, ""
}

func (a *fixtureApp) initP1(req *CanonicalRequest) (requestID, origin string) {
	requestID = firstHeaderValue(req.Headers, "x-request-id")
	if requestID == "" {
		requestID = "req_test_123"
	}
	req.RequestID = requestID

	origin = firstHeaderValue(req.Headers, "origin")
	req.TenantID = extractTenantID(req.Headers, req.Query)

	req.MiddlewareTrace = append(req.MiddlewareTrace,
		"request_id",
		"recovery",
		"logging",
	)
	if origin != "" {
		req.MiddlewareTrace = append(req.MiddlewareTrace, "cors")
	}

	return requestID, origin
}

func missingRouteResponse(allowed []string, requestID string) (CanonicalResponse, string) {
	if len(allowed) > 0 {
		headers := map[string][]string{
			"allow": {formatAllowHeader(allowed)},
		}
		return appErrorResponse(appErrorMethodNotAllowed, msgMethodNotAllowed, headers, requestID), appErrorMethodNotAllowed
	}
	return appErrorResponse(appErrorNotFound, msgNotFound, nil, requestID), appErrorNotFound
}

func handleAuth(req *CanonicalRequest, requestID string) (CanonicalResponse, bool) {
	req.MiddlewareTrace = append(req.MiddlewareTrace, "auth")
	authz := firstHeaderValue(req.Headers, "authorization")
	if strings.TrimSpace(authz) == "" {
		return appErrorResponse(appErrorUnauthorized, msgUnauthorized, nil, requestID), true
	}
	req.AuthIdentity = authorizedIdentity
	return CanonicalResponse{}, false
}

func responseForHandlerError(err error, requestID string) (CanonicalResponse, string) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		return appErrorResponse(appErr.Code, appErr.Message, nil, requestID), appErr.Code
	}
	return appErrorResponse(appErrorInternal, msgInternal, nil, requestID), appErrorInternal
}

func forcedP2Response(req CanonicalRequest, requestID string) (CanonicalResponse, string, bool) {
	if firstHeaderValue(req.Headers, "x-force-rate-limit") != "" {
		return appErrorResponse(appErrorRateLimited, msgRateLimited, map[string][]string{
			"retry-after": {"1"},
		}, requestID), appErrorRateLimited, true
	}
	if firstHeaderValue(req.Headers, "x-force-shed") != "" {
		return appErrorResponse(appErrorOverloaded, msgOverloaded, map[string][]string{
			"retry-after": {"1"},
		}, requestID), appErrorOverloaded, true
	}
	return CanonicalResponse{}, "", false
}

func (a *fixtureApp) finalizeResponse(resp CanonicalResponse, requestID, origin string) CanonicalResponse {
	resp.Headers = canonicalizeHeaders(resp.Headers)
	if a.enableP1 {
		if requestID != "" {
			resp.Headers["x-request-id"] = []string{requestID}
		}
		if origin != "" {
			resp.Headers["access-control-allow-origin"] = []string{origin}
			resp.Headers["vary"] = []string{"origin"}
		}
	}
	return resp
}

func (a *fixtureApp) finish(req CanonicalRequest, resp CanonicalResponse, requestID, origin, errorCode string) CanonicalResponse {
	out := a.finalizeResponse(resp, requestID, origin)
	if a.enableP2 {
		a.recordP2(req, out, errorCode)
	}
	return out
}

func (a *fixtureApp) recordP2(req CanonicalRequest, resp CanonicalResponse, errorCode string) {
	level := "info"
	if resp.Status >= 500 {
		level = "error"
	} else if resp.Status >= 400 {
		level = "warn"
	}

	a.logs = []FixtureLogRecord{
		{
			Level:     level,
			Event:     "request.completed",
			RequestID: req.RequestID,
			TenantID:  req.TenantID,
			Method:    req.Method,
			Path:      req.Path,
			Status:    resp.Status,
			ErrorCode: errorCode,
		},
	}

	a.metrics = []FixtureMetricRecord{
		{
			Name:  "apptheory.request",
			Value: 1,
			Tags: map[string]string{
				"method":     req.Method,
				"path":       req.Path,
				"status":     strconv.Itoa(resp.Status),
				"error_code": errorCode,
				"tenant_id":  req.TenantID,
			},
		},
	}

	a.spans = []FixtureSpanRecord{
		{
			Name: fmt.Sprintf("http %s %s", req.Method, req.Path),
			Attributes: map[string]string{
				"http.method":      req.Method,
				"http.route":       req.Path,
				"http.status_code": strconv.Itoa(resp.Status),
				"request.id":       req.RequestID,
				"tenant.id":        req.TenantID,
				"error.code":       errorCode,
			},
		},
	}
}

func isCorsPreflight(method string, headers map[string][]string) bool {
	if strings.ToUpper(strings.TrimSpace(method)) != "OPTIONS" {
		return false
	}
	return firstHeaderValue(headers, "access-control-request-method") != ""
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
	if query == nil {
		return ""
	}
	if values := query["tenant"]; len(values) > 0 {
		return values[0]
	}
	return ""
}

func formatAllowHeader(methods []string) string {
	set := map[string]struct{}{}
	for _, m := range methods {
		m = strings.ToUpper(strings.TrimSpace(m))
		if m == "" {
			continue
		}
		set[m] = struct{}{}
	}
	uniq := make([]string, 0, len(set))
	for m := range set {
		uniq = append(uniq, m)
	}
	sort.Strings(uniq)
	return strings.Join(uniq, ", ")
}

func decodeFixtureBody(body FixtureBody) ([]byte, error) {
	switch body.Encoding {
	case "utf8":
		return []byte(body.Value), nil
	case "base64":
		out, err := base64.StdEncoding.DecodeString(body.Value)
		if err != nil {
			return nil, fmt.Errorf("decode base64: %w", err)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unknown body encoding %q", body.Encoding)
	}
}

func canonicalizeRequest(in FixtureRequest) (CanonicalRequest, error) {
	headers := canonicalizeHeaders(in.Headers)

	bodyBytes, err := decodeFixtureBody(in.Body)
	if err != nil {
		return CanonicalRequest{}, err
	}
	if in.IsBase64 {
		decoded, err := base64.StdEncoding.DecodeString(string(bodyBytes))
		if err != nil {
			return CanonicalRequest{}, fmt.Errorf("decode request is_base64 body: %w", err)
		}
		bodyBytes = decoded
	}

	cookies := parseCookies(headers["cookie"])

	method := strings.ToUpper(strings.TrimSpace(in.Method))
	path := strings.TrimSpace(in.Path)
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	return CanonicalRequest{
		Method:   method,
		Path:     path,
		Query:    cloneQuery(in.Query),
		Headers:  headers,
		Cookies:  cookies,
		Body:     bodyBytes,
		IsBase64: in.IsBase64,
	}, nil
}

func parseCookies(cookieHeaders []string) map[string]string {
	out := map[string]string{}
	for _, header := range cookieHeaders {
		parts := strings.Split(header, ";")
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			name, value, ok := strings.Cut(part, "=")
			if !ok {
				continue
			}
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			out[name] = strings.TrimSpace(value)
		}
	}
	return out
}

func canonicalizeHeaders(in map[string][]string) map[string][]string {
	if len(in) == 0 {
		return map[string][]string{}
	}

	keys := make([]string, 0, len(in))
	for k := range in {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := map[string][]string{}
	for _, key := range keys {
		values := in[key]
		lower := strings.ToLower(strings.TrimSpace(key))
		if lower == "" {
			continue
		}
		out[lower] = append(out[lower], values...)
	}
	return out
}

func cloneHeaders(in map[string][]string) map[string][]string {
	out := map[string][]string{}
	for k, v := range in {
		out[k] = append([]string(nil), v...)
	}
	return out
}

func cloneQuery(in map[string][]string) map[string][]string {
	out := map[string][]string{}
	for k, v := range in {
		out[k] = append([]string(nil), v...)
	}
	return out
}

func jsonContentType(headers map[string][]string) bool {
	for _, v := range headers["content-type"] {
		value := strings.ToLower(strings.TrimSpace(v))
		if strings.HasPrefix(value, "application/json") {
			return true
		}
	}
	return false
}

type handlerFunc func(CanonicalRequest) (CanonicalResponse, error)

var builtInHandlers = map[string]handlerFunc{
	"static_pong": func(_ CanonicalRequest) (CanonicalResponse, error) {
		return CanonicalResponse{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"text/plain; charset=utf-8"},
			},
			Body:     []byte("pong"),
			IsBase64: false,
		}, nil
	},
	"echo_path_params": func(req CanonicalRequest) (CanonicalResponse, error) {
		body, err := json.Marshal(map[string]any{
			"params": req.PathParams,
		})
		if err != nil {
			return CanonicalResponse{}, err
		}
		return CanonicalResponse{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"application/json; charset=utf-8"},
			},
			Body:     body,
			IsBase64: false,
		}, nil
	},
	"echo_request": func(req CanonicalRequest) (CanonicalResponse, error) {
		body, err := json.Marshal(map[string]any{
			"method":    req.Method,
			"path":      req.Path,
			"query":     req.Query,
			"headers":   req.Headers,
			"cookies":   req.Cookies,
			"body_b64":  base64.StdEncoding.EncodeToString(req.Body),
			"is_base64": req.IsBase64,
		})
		if err != nil {
			return CanonicalResponse{}, err
		}
		return CanonicalResponse{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"application/json; charset=utf-8"},
			},
			Body:     body,
			IsBase64: false,
		}, nil
	},
	"echo_context": func(req CanonicalRequest) (CanonicalResponse, error) {
		body, err := json.Marshal(map[string]any{
			"request_id":    req.RequestID,
			"tenant_id":     req.TenantID,
			"auth_identity": req.AuthIdentity,
			"remaining_ms":  req.RemainingMS,
		})
		if err != nil {
			return CanonicalResponse{}, err
		}
		return CanonicalResponse{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"application/json; charset=utf-8"},
			},
			Body:     body,
			IsBase64: false,
		}, nil
	},
	"echo_middleware_trace": func(req CanonicalRequest) (CanonicalResponse, error) {
		body, err := json.Marshal(map[string]any{
			"trace": req.MiddlewareTrace,
		})
		if err != nil {
			return CanonicalResponse{}, err
		}
		return CanonicalResponse{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"application/json; charset=utf-8"},
			},
			Body:     body,
			IsBase64: false,
		}, nil
	},
	"parse_json_echo": func(req CanonicalRequest) (CanonicalResponse, error) {
		if !jsonContentType(req.Headers) {
			return CanonicalResponse{}, &AppError{Code: appErrorBadRequest, Message: msgInvalidJSON}
		}

		var value any
		if len(req.Body) == 0 {
			value = nil
		} else if err := json.Unmarshal(req.Body, &value); err != nil {
			return CanonicalResponse{}, &AppError{Code: appErrorBadRequest, Message: msgInvalidJSON}
		}

		body, err := json.Marshal(value)
		if err != nil {
			return CanonicalResponse{}, err
		}
		return CanonicalResponse{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"application/json; charset=utf-8"},
			},
			Body:     body,
			IsBase64: false,
		}, nil
	},
	"panic": func(_ CanonicalRequest) (CanonicalResponse, error) {
		panic("boom")
	},
	"binary_body": func(_ CanonicalRequest) (CanonicalResponse, error) {
		return CanonicalResponse{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"application/octet-stream"},
			},
			Body:     []byte{0x00, 0x01, 0x02},
			IsBase64: true,
		}, nil
	},
	"unauthorized": func(_ CanonicalRequest) (CanonicalResponse, error) {
		return CanonicalResponse{}, &AppError{Code: appErrorUnauthorized, Message: msgUnauthorized}
	},
	"validation_failed": func(_ CanonicalRequest) (CanonicalResponse, error) {
		return CanonicalResponse{}, &AppError{Code: appErrorValidationFailed, Message: "validation failed"}
	},
	"large_response": func(_ CanonicalRequest) (CanonicalResponse, error) {
		return CanonicalResponse{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"text/plain; charset=utf-8"},
			},
			Body:     []byte("12345"),
			IsBase64: false,
		}, nil
	},
}

func builtInHandler(name string) handlerFunc {
	return builtInHandlers[name]
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalHeaders(a, b map[string][]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, av := range a {
		bv, ok := b[k]
		if !ok {
			return false
		}
		if !equalStringSlices(av, bv) {
			return false
		}
	}
	return true
}

func equalBytes(a, b []byte) bool {
	return bytes.Equal(a, b)
}
