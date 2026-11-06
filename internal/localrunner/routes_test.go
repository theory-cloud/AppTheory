package localrunner

import (
	"encoding/json"
	"testing"
)

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

func TestWebSocketAPIIsServedSeparately(t *testing.T) {
	stack := assemblyStack{Name: "Stack", Template: template{Resources: map[string]templateResource{
		"WsApi": {
			Type: typeHTTPAPI,
			Properties: json.RawMessage(`{
				"Name": "demo-ws",
				"ProtocolType": "WEBSOCKET",
				"RouteSelectionExpression": "$request.body.action"
			}`),
		},
		"ConnectIntegration": {
			Type: typeHTTPIntegration,
			Properties: json.RawMessage(`{
				"IntegrationType": "AWS_PROXY",
				"IntegrationUri": {"Fn::GetAtt": ["ConnectFn", "Arn"]}
			}`),
		},
		"ConnectRoute": {
			Type: typeHTTPRoute,
			Properties: json.RawMessage(`{
				"ApiId": {"Ref": "WsApi"},
				"RouteKey": "$connect",
				"AuthorizationType": "NONE",
				"Target": {"Ref": "ConnectIntegration"}
			}`),
		},
		"ConnectFn": {Type: typeLambdaFunction},
	}}}
	spec := &Spec{functionURLTargets: map[string]string{}}
	if err := deriveHTTPAPIs(spec, []assemblyStack{stack}, stack); err != nil {
		t.Fatalf("derive HTTP APIs: %v", err)
	}
	if len(spec.APIs) != 0 {
		t.Fatalf("a WebSocket API must not be served as HTTP: %+v", spec.APIs)
	}
	if err := deriveWebSocketAPIs(spec, []assemblyStack{stack}, stack); err != nil {
		t.Fatalf("derive WebSocket APIs: %v", err)
	}
	if len(spec.WebSockets) != 1 {
		t.Fatalf("web sockets = %+v", spec.WebSockets)
	}
	api := spec.WebSockets[0]
	if api.LogicalID != "WsApi" || api.Stage != LocalStageName || api.RouteSelectionExpression != "$request.body.action" {
		t.Fatalf("api = %+v", api)
	}
	route, ok := api.Route(webSocketConnect)
	if !ok || route.Function != "ConnectFn" || route.TwoWay {
		t.Fatalf("$connect route = %+v (%t)", route, ok)
	}
	if len(spec.Skipped) != 0 {
		t.Fatalf("a WebSocket API must not be reported as skipped: %+v", spec.Skipped)
	}
}

func TestRESTMockRouteUsesDeclaredResponse(t *testing.T) {
	stack := assemblyStack{Name: "Stack"}
	props := restMethodProperties{
		HTTPMethod: "OPTIONS",
		ResourceID: json.RawMessage(`{"Ref":"Res"}`),
		Integration: struct {
			Type                 string                    `json:"Type"`
			URI                  json.RawMessage           `json:"Uri"`
			ResponseTransferMode string                    `json:"ResponseTransferMode"`
			IntegrationResponses []restIntegrationResponse `json:"IntegrationResponses"`
		}{
			Type: mockIntegration,
			IntegrationResponses: []restIntegrationResponse{{
				StatusCode: "200",
				ResponseParameters: map[string]string{
					"method.response.header.Access-Control-Allow-Origin": "'*'",
					"method.response.header.Access-Control-Max-Age":      "'600'",
					"integration.response.body":                          "ignored",
				},
			}},
		},
	}
	route, err := restMockRoute(stack, map[string]string{"Res": "/sse"}, "Method", props)
	if err != nil {
		t.Fatalf("mock route: %v", err)
	}
	if route.Function != "" || route.Mock == nil {
		t.Fatalf("a mock route must not name a function: %+v", route)
	}
	if route.Mock.StatusCode != 200 || route.Path != "/sse" || route.Method != "OPTIONS" {
		t.Fatalf("unexpected mock route: %+v", route.Mock)
	}
	if route.Mock.Headers["Access-Control-Allow-Origin"] != "*" ||
		route.Mock.Headers["Access-Control-Max-Age"] != "600" {
		t.Fatalf("declared headers were not unquoted: %+v", route.Mock.Headers)
	}
	if _, exists := route.Mock.Headers["integration.response.body"]; exists {
		t.Fatalf("only method.response.header parameters become headers: %+v", route.Mock.Headers)
	}
}

func TestRESTMockRouteRefusesAnUnusableDeclaration(t *testing.T) {
	stack := assemblyStack{Name: "Stack"}
	props := restMethodProperties{HTTPMethod: "OPTIONS"}
	props.Integration.Type = mockIntegration
	if _, err := restMockRoute(stack, nil, "Method", props); err == nil {
		t.Fatal("a MOCK integration without IntegrationResponses must fail closed")
	}
	props.Integration.IntegrationResponses = []restIntegrationResponse{{StatusCode: "not-a-status"}}
	if _, err := restMockRoute(stack, nil, "Method", props); err == nil {
		t.Fatal("a non-HTTP MOCK status must fail closed")
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
