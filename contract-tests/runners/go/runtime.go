package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

type CanonicalRequest struct {
	Method     string
	Path       string
	Query      map[string][]string
	Headers    map[string][]string
	Cookies    map[string]string
	Body       []byte
	IsBase64   bool
	PathParams map[string]string
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

func appErrorResponse(code, message string, headers map[string][]string) CanonicalResponse {
	if headers == nil {
		headers = map[string][]string{}
	}
	headers = cloneHeaders(headers)
	headers["content-type"] = []string{"application/json; charset=utf-8"}

	body, _ := json.Marshal(map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})

	return CanonicalResponse{
		Status:   statusForError(code),
		Headers: headers,
		Cookies: nil,
		Body:    body,
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
	case "app.internal":
		return 500
	default:
		return 500
	}
}

type compiledRoute struct {
	Method    string
	Pattern   string
	Segments  []string
	ParamKeys []string
	Handler   string
}

type fixtureApp struct {
	routes []compiledRoute
}

func newFixtureApp(routes []FixtureRoute) (*fixtureApp, error) {
	var compiled []compiledRoute
	for _, r := range routes {
		if strings.TrimSpace(r.Method) == "" || strings.TrimSpace(r.Path) == "" || strings.TrimSpace(r.Handler) == "" {
			return nil, errors.New("route entries must have method, path, and handler")
		}
		method := strings.ToUpper(strings.TrimSpace(r.Method))
		pattern := strings.TrimSpace(r.Path)
		segments := splitPath(pattern)
		compiled = append(compiled, compiledRoute{
			Method:  method,
			Pattern: pattern,
			Segments: segments,
			Handler: r.Handler,
		})
	}

	return &fixtureApp{routes: compiled}, nil
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
	defer func() {
		if r := recover(); r != nil {
			resp = appErrorResponse("app.internal", "internal error", nil)
		}
	}()

	match, allowed := a.match(req.Method, req.Path)
	if match == nil {
		if len(allowed) > 0 {
			headers := map[string][]string{
				"allow": []string{formatAllowHeader(allowed)},
			}
			return appErrorResponse("app.method_not_allowed", "method not allowed", headers)
		}
		return appErrorResponse("app.not_found", "not found", nil)
	}

	req.PathParams = match.PathParams

	handler := builtInHandler(match.Route.Handler)
	if handler == nil {
		return appErrorResponse("app.internal", "internal error", nil)
	}

	r, err := handler(req)
	if err != nil {
		var appErr *AppError
		if errors.As(err, &appErr) {
			return appErrorResponse(appErr.Code, appErr.Message, nil)
		}
		return appErrorResponse("app.internal", "internal error", nil)
	}

	r.Headers = canonicalizeHeaders(r.Headers)
	return r
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

