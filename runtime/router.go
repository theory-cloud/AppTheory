package apptheory

import (
	"fmt"
	"sort"
	"strings"
)

// Handler is the request handler signature for AppTheory apps.
type Handler func(*Context) (*Response, error)

type RouteOption func(*routeOptions)

type routeOptions struct {
	authRequired bool
}

func RequireAuth() RouteOption {
	return func(opts *routeOptions) {
		opts.authRequired = true
	}
}

type routeSegmentKind int

const (
	routeSegmentStatic routeSegmentKind = iota
	routeSegmentParam
	routeSegmentProxy
)

type routeSegment struct {
	Kind  routeSegmentKind
	Value string
}

type route struct {
	Method       string
	Pattern      string
	Segments     []routeSegment
	Handler      Handler
	AuthRequired bool

	staticCount int
	paramCount  int
	hasProxy    bool
	order       int
}

type router struct {
	routes []route
}

func newRouter() *router {
	return &router{}
}

func (r *router) add(method, pattern string, handler Handler, opts routeOptions) {
	if err := r.addStrict(method, pattern, handler, opts); err != nil {
		return
	}
}

func (r *router) addStrict(method, pattern string, handler Handler, opts routeOptions) error {
	if handler == nil {
		return fmt.Errorf("apptheory: route handler is nil")
	}
	method = strings.ToUpper(strings.TrimSpace(method))
	pattern = normalizePath(pattern)
	segments, canonicalSegments, err := parseRouteSegments(splitPath(pattern))
	if err != nil {
		// Fail closed for invalid patterns.
		return err
	}

	if len(canonicalSegments) == 0 {
		pattern = "/"
	} else {
		pattern = "/" + strings.Join(canonicalSegments, "/")
	}

	staticCount := 0
	paramCount := 0
	hasProxy := false
	for _, seg := range segments {
		switch seg.Kind {
		case routeSegmentStatic:
			staticCount++
		case routeSegmentParam:
			paramCount++
		case routeSegmentProxy:
			hasProxy = true
		}
	}

	r.routes = append(r.routes, route{
		Method:       method,
		Pattern:      pattern,
		Segments:     segments,
		Handler:      handler,
		AuthRequired: opts.authRequired,
		staticCount:  staticCount,
		paramCount:   paramCount,
		hasProxy:     hasProxy,
		order:        len(r.routes),
	})

	return nil
}

type routeMatch struct {
	Route  route
	Params map[string]string
}

func (r *router) match(method, path string) (*routeMatch, []string) {
	method = strings.ToUpper(strings.TrimSpace(method))
	pathSegments := splitPath(path)

	allowed := make([]string, 0, len(r.routes))
	var best *routeMatch
	var bestRoute route

	for _, candidate := range r.routes {
		params, ok := matchRoute(candidate.Segments, pathSegments)
		if !ok {
			continue
		}

		allowed = append(allowed, candidate.Method)

		if candidate.Method != method {
			continue
		}

		if best == nil || routeMoreSpecific(candidate, bestRoute) {
			bestRoute = candidate
			best = &routeMatch{Route: candidate, Params: params}
		}
	}

	return best, allowed
}

func splitPath(path string) []string {
	path = strings.TrimSpace(path)
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
}

func parseRouteSegments(rawSegments []string) ([]routeSegment, []string, error) {
	if len(rawSegments) == 0 {
		return nil, nil, nil
	}

	segments := make([]routeSegment, 0, len(rawSegments))
	canonical := make([]string, 0, len(rawSegments))

	for i, raw := range rawSegments {
		seg, canon, ok := parseRouteSegment(raw)
		if !ok {
			return nil, nil, fmt.Errorf("apptheory: invalid route segment: %q", raw)
		}
		if seg.Kind == routeSegmentProxy && i != len(rawSegments)-1 {
			return nil, nil, fmt.Errorf("apptheory: invalid route pattern: proxy segment must be last: %q", raw)
		}

		segments = append(segments, seg)
		canonical = append(canonical, canon)
	}

	return segments, canonical, nil
}

func parseRouteSegment(raw string) (routeSegment, string, bool) {
	segment := strings.TrimSpace(raw)
	if segment == "" {
		return routeSegment{}, "", false
	}

	if strings.HasPrefix(segment, ":") && len(segment) > 1 {
		segment = "{" + segment[1:] + "}"
	}

	if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") && len(segment) > 2 {
		inner := segment[1 : len(segment)-1]
		if strings.HasSuffix(inner, "+") {
			name := strings.TrimSpace(strings.TrimSuffix(inner, "+"))
			if name == "" {
				return routeSegment{}, "", false
			}
			return routeSegment{Kind: routeSegmentProxy, Value: name}, "{" + name + "+}", true
		}

		name := strings.TrimSpace(inner)
		if name == "" {
			return routeSegment{}, "", false
		}
		return routeSegment{Kind: routeSegmentParam, Value: name}, "{" + name + "}", true
	}

	return routeSegment{Kind: routeSegmentStatic, Value: segment}, segment, true
}

func matchRoute(patternSegments []routeSegment, pathSegments []string) (map[string]string, bool) {
	if len(patternSegments) == 0 {
		return map[string]string{}, len(pathSegments) == 0
	}

	hasProxy := patternSegments[len(patternSegments)-1].Kind == routeSegmentProxy
	if hasProxy {
		prefixLen := len(patternSegments) - 1
		if len(pathSegments) <= prefixLen {
			return nil, false
		}

		params := map[string]string{}
		for i := 0; i < prefixLen; i++ {
			pattern := patternSegments[i]
			value := pathSegments[i]
			if value == "" {
				return nil, false
			}
			switch pattern.Kind {
			case routeSegmentStatic:
				if pattern.Value != value {
					return nil, false
				}
			case routeSegmentParam:
				params[pattern.Value] = value
			default:
				return nil, false
			}
		}

		proxyName := patternSegments[len(patternSegments)-1].Value
		params[proxyName] = strings.Join(pathSegments[prefixLen:], "/")
		return params, true
	}

	if len(patternSegments) != len(pathSegments) {
		return nil, false
	}

	params := map[string]string{}
	for i, pattern := range patternSegments {
		value := pathSegments[i]
		if value == "" {
			return nil, false
		}
		switch pattern.Kind {
		case routeSegmentStatic:
			if pattern.Value != value {
				return nil, false
			}
		case routeSegmentParam:
			params[pattern.Value] = value
		default:
			return nil, false
		}
	}
	return params, true
}

func routeMoreSpecific(a, b route) bool {
	if a.staticCount != b.staticCount {
		return a.staticCount > b.staticCount
	}
	if a.paramCount != b.paramCount {
		return a.paramCount > b.paramCount
	}
	if a.hasProxy != b.hasProxy {
		return !a.hasProxy && b.hasProxy
	}
	if len(a.Segments) != len(b.Segments) {
		return len(a.Segments) > len(b.Segments)
	}
	// If two routes are equally specific, prefer earlier registration order.
	return a.order < b.order
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
