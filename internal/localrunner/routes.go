package localrunner

import (
	"net/http"
	"sort"
	"strings"
)

// catchAllPath is the route the transport uses for an API Gateway "$default"
// route, which matches every path including "/".
const catchAllPath = "*"

// MatchRoute returns the route that should receive a request, or false when no
// route matches. Routes are ranked the way API Gateway ranks them: literal
// segments beat parameters, parameters beat greedy proxies, and the "$default"
// catch-all is last.
func MatchRoute(api APISpec, method, path string) (Route, map[string]string, bool) {
	ranked := append([]Route(nil), api.Routes...)
	sort.SliceStable(ranked, func(i, j int) bool { return routeSpecificity(ranked[i]) > routeSpecificity(ranked[j]) })
	for _, route := range ranked {
		if !methodMatches(route.Method, method) {
			continue
		}
		params, ok := matchPath(route.Path, path)
		if ok {
			return route, params, true
		}
	}
	return Route{}, nil, false
}

// stagePrefixFor splits a named stage off a request path. The $default stage
// is served from the root, so it never produces a prefix. A REST API's
// execute-api base URL is /{stage}/; an HTTP API's named stage is served under
// /{stage}, while the $default stage is served from the base of the URL.
// https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-call-api.html
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-stages.html
func stagePrefixFor(api APISpec, path string) (prefix, rest string, ok bool) {
	if api.Class != APIRESTV1 && api.Class != APIHTTPV2 {
		return "", "", false
	}
	stage := strings.TrimSpace(api.Stage)
	if stage == "" || stage == LocalStageName {
		return "", "", false
	}
	prefix = "/" + stage
	if path == prefix {
		return prefix, "/", true
	}
	if strings.HasPrefix(path, prefix+"/") {
		return prefix, path[len(prefix):], true
	}
	return "", "", false
}

func methodMatches(routeMethod, requestMethod string) bool {
	routeMethod = strings.ToUpper(strings.TrimSpace(routeMethod))
	if routeMethod == "" || routeMethod == "ANY" {
		return true
	}
	return routeMethod == strings.ToUpper(requestMethod)
}

// routeSpecificity ranks a route. Higher is more specific: literal segments
// beat parameters, parameters beat a greedy proxy, and the "$default" catch-all
// is last.
func routeSpecificity(route Route) int {
	if route.Path == catchAllPath {
		return 0
	}
	score := 0
	for _, segment := range splitPath(route.Path) {
		switch {
		case segment == "{proxy+}":
			score++
		case strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}"):
			score += 2
		default:
			score += 3
		}
	}
	return score
}

// matchPath matches a route template against a request path and returns the
// path parameters. A greedy {proxy+} segment matches one or more path segments.
func matchPath(template, path string) (map[string]string, bool) {
	if template == catchAllPath {
		return map[string]string{}, true
	}
	templateSegments := splitPath(template)
	pathSegments := splitPath(path)
	params := map[string]string{}
	for index, segment := range templateSegments {
		if segment == "{proxy+}" && index == len(templateSegments)-1 {
			if len(pathSegments) <= index {
				return nil, false
			}
			params["proxy"] = strings.Join(pathSegments[index:], "/")
			return params, true
		}
		if index >= len(pathSegments) {
			return nil, false
		}
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			params[strings.TrimSuffix(strings.TrimPrefix(segment, "{"), "}")] = pathSegments[index]
			continue
		}
		if segment != pathSegments[index] {
			return nil, false
		}
	}
	if len(pathSegments) != len(templateSegments) {
		return nil, false
	}
	return params, true
}

// splitPath splits an absolute path into segments, ignoring leading, trailing
// and repeated slashes.
func splitPath(path string) []string {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return nil
	}
	parts := strings.Split(trimmed, "/")
	out := parts[:0]
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// RequestPath returns the decoded request path.
func RequestPath(request *http.Request) string {
	if request.URL == nil || request.URL.Path == "" {
		return "/"
	}
	return request.URL.Path
}
