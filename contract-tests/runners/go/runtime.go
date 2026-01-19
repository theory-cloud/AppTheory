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

	body, _ := json.Marshal(map[string]any{
		"error": errBody,
	})

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
	case "app.bad_request", "app.validation_failed":
		return 400
	case "app.unauthorized":
		return 401
	case "app.forbidden":
		return 403
	case "app.not_found":
		return 404
	case "app.method_not_allowed":
		return 405
	case "app.conflict":
		return 409
	case "app.too_large":
		return 413
	case "app.rate_limited":
		return 429
	case "app.overloaded":
		return 503
	case "app.internal":
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
			errorCode = "app.internal"
			resp = appErrorResponse("app.internal", "internal error", nil, requestID)
			resp = a.finish(req, resp, requestID, origin, errorCode)
		}
	}()

	if a.enableP1 {
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

		if isCorsPreflight(req.Method, req.Headers) && origin != "" {
			preflight := CanonicalResponse{
				Status: 204,
				Headers: map[string][]string{
					"access-control-allow-methods": []string{firstHeaderValue(req.Headers, "access-control-request-method")},
				},
				Body:     nil,
				IsBase64: false,
			}
			resp = a.finish(req, preflight, requestID, origin, errorCode)
			return resp
		}

		if a.limits.MaxRequestBytes > 0 && len(req.Body) > a.limits.MaxRequestBytes {
			errorCode = "app.too_large"
			resp = appErrorResponse("app.too_large", "request too large", nil, requestID)
			resp = a.finish(req, resp, requestID, origin, errorCode)
			return resp
		}

		if a.enableP2 {
			if firstHeaderValue(req.Headers, "x-force-rate-limit") != "" {
				errorCode = "app.rate_limited"
				resp = appErrorResponse("app.rate_limited", "rate limited", map[string][]string{
					"retry-after": []string{"1"},
				}, requestID)
				return a.finish(req, resp, requestID, origin, errorCode)
			}
			if firstHeaderValue(req.Headers, "x-force-shed") != "" {
				errorCode = "app.overloaded"
				resp = appErrorResponse("app.overloaded", "overloaded", map[string][]string{
					"retry-after": []string{"1"},
				}, requestID)
				return a.finish(req, resp, requestID, origin, errorCode)
			}
		}
	}

	match, allowed := a.match(req.Method, req.Path)
	if match == nil {
		if len(allowed) > 0 {
			headers := map[string][]string{
				"allow": []string{formatAllowHeader(allowed)},
			}
			errorCode = "app.method_not_allowed"
			resp = appErrorResponse("app.method_not_allowed", "method not allowed", headers, requestID)
			return a.finish(req, resp, requestID, origin, errorCode)
		}
		errorCode = "app.not_found"
		resp = appErrorResponse("app.not_found", "not found", nil, requestID)
		return a.finish(req, resp, requestID, origin, errorCode)
	}

	req.PathParams = match.PathParams
	if match.Route.AuthRequired && a.enableP1 {
		req.MiddlewareTrace = append(req.MiddlewareTrace, "auth")
		authz := firstHeaderValue(req.Headers, "authorization")
		if strings.TrimSpace(authz) == "" {
			errorCode = "app.unauthorized"
			resp = appErrorResponse("app.unauthorized", "unauthorized", nil, requestID)
			return a.finish(req, resp, requestID, origin, errorCode)
		}
		req.AuthIdentity = "authorized"
	}
	if a.enableP1 {
		req.MiddlewareTrace = append(req.MiddlewareTrace, "handler")
	}

	handler := builtInHandler(match.Route.Handler)
	if handler == nil {
		errorCode = "app.internal"
		resp = appErrorResponse("app.internal", "internal error", nil, requestID)
		return a.finish(req, resp, requestID, origin, errorCode)
	}

	r, err := handler(req)
	if err != nil {
		var appErr *AppError
		if errors.As(err, &appErr) {
			errorCode = appErr.Code
			resp = appErrorResponse(appErr.Code, appErr.Message, nil, requestID)
			return a.finish(req, resp, requestID, origin, errorCode)
		}
		errorCode = "app.internal"
		resp = appErrorResponse("app.internal", "internal error", nil, requestID)
		return a.finish(req, resp, requestID, origin, errorCode)
	}

	if a.enableP1 && a.limits.MaxResponseBytes > 0 && len(r.Body) > a.limits.MaxResponseBytes {
		errorCode = "app.too_large"
		resp = appErrorResponse("app.too_large", "response too large", nil, requestID)
		return a.finish(req, resp, requestID, origin, errorCode)
	}

	return a.finish(req, r, requestID, origin, errorCode)
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
	var uniq []string
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

func builtInHandler(name string) handlerFunc {
	switch name {
	case "static_pong":
		return func(_ CanonicalRequest) (CanonicalResponse, error) {
			return CanonicalResponse{
				Status: 200,
				Headers: map[string][]string{
					"content-type": []string{"text/plain; charset=utf-8"},
				},
				Body:     []byte("pong"),
				IsBase64: false,
			}, nil
		}
	case "echo_path_params":
		return func(req CanonicalRequest) (CanonicalResponse, error) {
			body, _ := json.Marshal(map[string]any{
				"params": req.PathParams,
			})
			return CanonicalResponse{
				Status: 200,
				Headers: map[string][]string{
					"content-type": []string{"application/json; charset=utf-8"},
				},
				Body:     body,
				IsBase64: false,
			}, nil
		}
	case "echo_request":
		return func(req CanonicalRequest) (CanonicalResponse, error) {
			body, _ := json.Marshal(map[string]any{
				"method":    req.Method,
				"path":      req.Path,
				"query":     req.Query,
				"headers":   req.Headers,
				"cookies":   req.Cookies,
				"body_b64":  base64.StdEncoding.EncodeToString(req.Body),
				"is_base64": req.IsBase64,
			})
			return CanonicalResponse{
				Status: 200,
				Headers: map[string][]string{
					"content-type": []string{"application/json; charset=utf-8"},
				},
				Body:     body,
				IsBase64: false,
			}, nil
		}
	case "echo_context":
		return func(req CanonicalRequest) (CanonicalResponse, error) {
			body, _ := json.Marshal(map[string]any{
				"request_id":    req.RequestID,
				"tenant_id":     req.TenantID,
				"auth_identity": req.AuthIdentity,
				"remaining_ms":  req.RemainingMS,
			})
			return CanonicalResponse{
				Status: 200,
				Headers: map[string][]string{
					"content-type": []string{"application/json; charset=utf-8"},
				},
				Body:     body,
				IsBase64: false,
			}, nil
		}
	case "echo_middleware_trace":
		return func(req CanonicalRequest) (CanonicalResponse, error) {
			body, _ := json.Marshal(map[string]any{
				"trace": req.MiddlewareTrace,
			})
			return CanonicalResponse{
				Status: 200,
				Headers: map[string][]string{
					"content-type": []string{"application/json; charset=utf-8"},
				},
				Body:     body,
				IsBase64: false,
			}, nil
		}
	case "parse_json_echo":
		return func(req CanonicalRequest) (CanonicalResponse, error) {
			if !jsonContentType(req.Headers) {
				return CanonicalResponse{}, &AppError{Code: "app.bad_request", Message: "invalid json"}
			}

			var value any
			if len(req.Body) == 0 {
				value = nil
			} else if err := json.Unmarshal(req.Body, &value); err != nil {
				return CanonicalResponse{}, &AppError{Code: "app.bad_request", Message: "invalid json"}
			}

			body, _ := json.Marshal(value)
			return CanonicalResponse{
				Status: 200,
				Headers: map[string][]string{
					"content-type": []string{"application/json; charset=utf-8"},
				},
				Body:     body,
				IsBase64: false,
			}, nil
		}
	case "panic":
		return func(_ CanonicalRequest) (CanonicalResponse, error) {
			panic("boom")
		}
	case "binary_body":
		return func(_ CanonicalRequest) (CanonicalResponse, error) {
			return CanonicalResponse{
				Status: 200,
				Headers: map[string][]string{
					"content-type": []string{"application/octet-stream"},
				},
				Body:     []byte{0x00, 0x01, 0x02},
				IsBase64: true,
			}, nil
		}
	case "unauthorized":
		return func(_ CanonicalRequest) (CanonicalResponse, error) {
			return CanonicalResponse{}, &AppError{Code: "app.unauthorized", Message: "unauthorized"}
		}
	case "validation_failed":
		return func(_ CanonicalRequest) (CanonicalResponse, error) {
			return CanonicalResponse{}, &AppError{Code: "app.validation_failed", Message: "validation failed"}
		}
	case "large_response":
		return func(_ CanonicalRequest) (CanonicalResponse, error) {
			return CanonicalResponse{
				Status: 200,
				Headers: map[string][]string{
					"content-type": []string{"text/plain; charset=utf-8"},
				},
				Body:     []byte("12345"),
				IsBase64: false,
			}, nil
		}
	default:
		return nil
	}
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
