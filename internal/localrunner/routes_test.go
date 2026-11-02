package localrunner

import "testing"

func testAPI(routes ...Route) APISpec {
	return APISpec{Class: APIHTTPV2, LogicalID: "Api", Stage: "$default", Routes: routes}
}

func TestMatchRoutePrefersLiteralOverParameterAndProxy(t *testing.T) {
	api := testAPI(
		Route{Class: APIHTTPV2, Method: "ANY", Path: "/{proxy+}", RouteKey: "ANY /{proxy+}"},
		Route{Class: APIHTTPV2, Method: "GET", Path: "/hello/{name}", RouteKey: "GET /hello/{name}"},
		Route{Class: APIHTTPV2, Method: "GET", Path: "/hello/AppTheory", RouteKey: "GET /hello/AppTheory"},
	)
	route, params, ok := MatchRoute(api, "GET", "/hello/AppTheory")
	if !ok || route.Path != "/hello/AppTheory" {
		t.Fatalf("literal route must win: %+v %v", route, ok)
	}
	if len(params) != 0 {
		t.Fatalf("literal route must have no parameters: %+v", params)
	}
	route, params, ok = MatchRoute(api, "GET", "/hello/other")
	if !ok || route.Path != "/hello/{name}" || params["name"] != "other" {
		t.Fatalf("parameter route must win over the proxy: %+v %+v", route, params)
	}
	route, params, ok = MatchRoute(api, "GET", "/deep/path/here")
	if !ok || route.Path != "/{proxy+}" || params["proxy"] != "deep/path/here" {
		t.Fatalf("proxy route must match remaining segments: %+v %+v", route, params)
	}
}

func TestMatchRouteMethods(t *testing.T) {
	api := testAPI(
		Route{Class: APIHTTPV2, Method: "POST", Path: "/items", RouteKey: "POST /items"},
		Route{Class: APIHTTPV2, Method: "ANY", Path: "/", RouteKey: "ANY /"},
	)
	if _, _, ok := MatchRoute(api, "GET", "/items"); ok {
		t.Fatal("a POST route must not match GET")
	}
	if _, _, ok := MatchRoute(api, "GET", "/missing"); ok {
		t.Fatal("no route must match an unknown path")
	}
	if _, _, ok := MatchRoute(api, "DELETE", "/"); !ok {
		t.Fatal("ANY must match every method")
	}
}

func TestMatchRouteDefaultRouteDoesNotShadowSpecificRoutes(t *testing.T) {
	api := testAPI(
		Route{Class: APIHTTPV2, Method: "ANY", Path: catchAllPath, RouteKey: "$default"},
		Route{Class: APIHTTPV2, Method: "GET", Path: "/health", RouteKey: "GET /health"},
	)
	route, _, ok := MatchRoute(api, "GET", "/health")
	if !ok || route.Path != "/health" {
		t.Fatalf("specific route must win over $default: %+v", route)
	}
	route, _, ok = MatchRoute(api, "PUT", "/anything/else")
	if !ok || route.Path != catchAllPath {
		t.Fatalf("$default must catch unmatched requests: %+v", route)
	}
}

func TestMatchPathGreedyProxyNeedsASegment(t *testing.T) {
	if _, ok := matchPath("/{proxy+}", "/"); ok {
		t.Fatal("{proxy+} must not match the root path")
	}
	if _, ok := matchPath("/", "/"); !ok {
		t.Fatal("the root template must match the root path")
	}
	params, ok := matchPath("/api/{proxy+}", "/api/")
	if ok {
		t.Fatalf("{proxy+} must not match an empty tail: %+v", params)
	}
	params, ok = matchPath("/api/{proxy+}", "/api/a/b")
	if !ok || params["proxy"] != "a/b" {
		t.Fatalf("unexpected greedy match: %+v %v", params, ok)
	}
}

func TestRouteSpecificityOrdering(t *testing.T) {
	literal := Route{Path: "/hello/AppTheory"}
	parameter := Route{Path: "/hello/{name}"}
	proxy := Route{Path: "/{proxy+}"}
	fallback := Route{Path: catchAllPath}
	if routeSpecificity(literal) <= routeSpecificity(parameter) ||
		routeSpecificity(parameter) <= routeSpecificity(proxy) ||
		routeSpecificity(proxy) <= routeSpecificity(fallback) {
		t.Fatalf("unexpected specificity order: %d %d %d %d",
			routeSpecificity(literal), routeSpecificity(parameter), routeSpecificity(proxy), routeSpecificity(fallback))
	}
}
