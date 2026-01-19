package apptheory

import (
	"sort"
	"strings"
)

// Handler is the request handler signature for AppTheory apps.
type Handler func(*Context) (*Response, error)

type route struct {
	Method   string
	Pattern  string
	Segments []string
	Handler  Handler
}

type router struct {
	routes []route
}

func newRouter() *router {
	return &router{}
}

func (r *router) add(method, pattern string, handler Handler) {
	method = strings.ToUpper(strings.TrimSpace(method))
	pattern = normalizePath(pattern)
	r.routes = append(r.routes, route{
		Method:   method,
		Pattern:  pattern,
		Segments: splitPath(pattern),
		Handler:  handler,
	})
}

type routeMatch struct {
	Route  route
	Params map[string]string
}

func (r *router) match(method, path string) (*routeMatch, []string) {
	method = strings.ToUpper(strings.TrimSpace(method))
	pathSegments := splitPath(path)

	var allowed []string
	for _, candidate := range r.routes {
		params, ok := matchPath(candidate.Segments, pathSegments)
		if !ok {
			continue
		}
		allowed = append(allowed, candidate.Method)
		if candidate.Method == method {
			return &routeMatch{Route: candidate, Params: params}, allowed
		}
	}
	return nil, allowed
}

func splitPath(path string) []string {
	path = strings.TrimSpace(path)
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
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
