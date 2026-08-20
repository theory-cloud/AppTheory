package apptheory

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func secureOKHandler(*Context) (*Response, error) { return Text(200, "ok"), nil }

func secureClaimAs[T any](t *testing.T, claims map[string]any, key string) T {
	t.Helper()
	value, ok := claims[key].(T)
	if !ok {
		t.Fatalf("claim %q has unexpected type %T", key, claims[key])
	}
	return value
}

func secureProxyResult(t *testing.T, value any) events.APIGatewayProxyResponse {
	t.Helper()
	result, ok := value.(events.APIGatewayProxyResponse)
	if !ok {
		t.Fatalf("unexpected Lambda result type %T", value)
	}
	return result
}

func secureOpenAPIOperation(t *testing.T, doc map[string]any, path, method string) map[string]any {
	t.Helper()
	paths, ok := doc["paths"].(map[string]any)
	if !ok {
		t.Fatal("OpenAPI paths missing")
	}
	pathItem, ok := paths[path].(map[string]any)
	if !ok {
		t.Fatalf("OpenAPI path %q missing", path)
	}
	operation, ok := pathItem[method].(map[string]any)
	if !ok {
		t.Fatalf("OpenAPI operation %s %s missing", method, path)
	}
	return operation
}

func requireSecurePanic(t *testing.T, want string, fn func()) {
	t.Helper()
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatalf("expected panic %q", want)
		}
		if got := strings.TrimSpace(fmt.Sprint(recovered)); got != want {
			t.Fatalf("panic = %q, want %q", got, want)
		}
	}()
	fn()
}

func TestSecureConstructionAndFacadeSurface(t *testing.T) {
	for _, tier := range []Tier{"", TierP0, TierP1, TierP2} {
		app := NewSecure(SecureOptions{Tier: tier})
		want := tier
		if want == "" {
			want = TierP2
		}
		if app.core.tier != want || !app.core.secure {
			t.Fatalf("tier %q constructed core %#v", tier, app.core)
		}
	}
	requireSecurePanic(t, "apptheory: invalid secure configuration", func() {
		NewSecure(SecureOptions{Tier: Tier("p3")})
	})

	typeOf := reflect.TypeOf((*SecureApp)(nil))
	for _, name := range []string{
		"Serve", "ServeALB", "ServeAPIGatewayProxy", "ServeAPIGatewayV2",
		"ServeLambdaFunctionURL", "ServeAppSync", "ServeWebSocket",
		"ServeDynamoDBStream", "ServeEventBridge", "ServeKinesis", "ServeSNS",
		"ServeSQS", "HandleLambda", "Use", "UseEvents", "IsLambda", "SQS",
		"SNS", "Kinesis", "EventBridge", "DynamoDB",
	} {
		if _, ok := typeOf.MethodByName(name); !ok {
			t.Errorf("SecureApp missing forwarded method %s", name)
		}
	}
	for _, name := range []string{"App", "Core", "Unwrap", "GetStrict", "HandleStrict"} {
		if _, ok := typeOf.MethodByName(name); ok {
			t.Errorf("SecureApp exposes forbidden method %s", name)
		}
	}

	// This unkeyed literal is deliberately compile-time compatibility coverage.
	legacy := AuthPrincipal{"legacy", []string{"read"}, map[string]any{"sub": "legacy"}}
	if legacy.Identity != "legacy" || reflect.TypeOf(legacy).NumField() != 3 {
		t.Fatalf("legacy AuthPrincipal surface changed: %#v", legacy)
	}
}

func TestSecureForwardedRuntimeAndEventSurface(t *testing.T) {
	app := NewSecure(SecureOptions{Tier: TierP0, WebSocketSupport: true})
	app.Post("/post", secureOKHandler, Public())
	app.Put("/put", secureOKHandler, Public())
	app.Patch("/patch", secureOKHandler, Public())
	app.Options("/options", secureOKHandler, Public())
	app.Delete("/delete", secureOKHandler, Public())
	app.Use(func(next Handler) Handler { return next })
	app.UseEvents(func(next EventHandler) EventHandler { return next })
	app.SQS("queue", func(*EventContext, events.SQSMessage) error { return nil })
	app.SNS("topic", func(*EventContext, events.SNSEventRecord) (any, error) { return nil, nil })
	app.Kinesis("stream", func(*EventContext, events.KinesisEventRecord) error { return nil })
	app.EventBridge(EventBridgeRule("rule"), func(*EventContext, events.EventBridgeEvent) (any, error) { return nil, nil })
	app.DynamoDB("table", func(*EventContext, events.DynamoDBEventRecord) error { return nil })

	ctx := context.Background()
	if app.Serve(ctx, Request{Method: "POST", Path: "/post"}).Status != 200 {
		t.Fatal("Serve forwarding failed")
	}
	if app.ServeALB(ctx, events.ALBTargetGroupRequest{HTTPMethod: "POST", Path: "/post"}).StatusCode != 200 {
		t.Fatal("ServeALB forwarding failed")
	}
	if app.ServeAPIGatewayProxy(ctx, events.APIGatewayProxyRequest{HTTPMethod: "POST", Path: "/post"}).StatusCode != 200 {
		t.Fatal("ServeAPIGatewayProxy forwarding failed")
	}
	if app.ServeAPIGatewayV2(ctx, events.APIGatewayV2HTTPRequest{RequestContext: events.APIGatewayV2HTTPRequestContext{HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{Method: "POST", Path: "/post"}}}).StatusCode != 200 {
		t.Fatal("ServeAPIGatewayV2 forwarding failed")
	}
	if app.ServeLambdaFunctionURL(ctx, events.LambdaFunctionURLRequest{RequestContext: events.LambdaFunctionURLRequestContext{HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{Method: "POST", Path: "/post"}}}).StatusCode != 200 {
		t.Fatal("ServeLambdaFunctionURL forwarding failed")
	}
	_ = app.ServeAppSync(ctx, AppSyncResolverEvent{})
	_ = app.ServeWebSocket(ctx, events.APIGatewayWebsocketProxyRequest{})
	_ = app.ServeDynamoDBStream(ctx, events.DynamoDBEvent{})
	if _, eventErr := app.ServeEventBridge(ctx, events.EventBridgeEvent{}); eventErr != nil {
		t.Fatalf("ServeEventBridge forwarding: %v", eventErr)
	}
	_ = app.ServeKinesis(ctx, events.KinesisEvent{})
	if _, snsErr := app.ServeSNS(ctx, events.SNSEvent{}); snsErr == nil {
		t.Fatal("ServeSNS forwarding unexpectedly matched an empty event")
	}
	_ = app.ServeSQS(ctx, events.SQSEvent{})
	if _, lambdaErr := app.HandleLambda(ctx, json.RawMessage(`{}`)); lambdaErr == nil {
		t.Fatal("HandleLambda forwarding unexpectedly recognized an empty event")
	}
	_ = app.IsLambda()
}

func TestSecureRegistrationValidationAndIntrospection(t *testing.T) {
	app := NewSecure(SecureOptions{})
	app.Get(" widgets/:id?ignored=true ", secureOKHandler, Authenticated(" read ", "write", "read"))
	app.AppSyncField("Subscription", "changed", secureOKHandler, Optional())
	app.WebSocket(" $default ", secureOKHandler, InternalOnly())

	routes := app.Routes()
	want := []SecureRoute{
		{Surface: SecureRouteHTTP, Method: "GET", Path: "/widgets/{id}", Posture: AuthPostureAuthenticated, Scopes: []string{"read", "write"}},
		{Surface: SecureRouteAppSync, Method: "GET", Path: "/changed", Posture: AuthPostureOptional, AppSyncParentType: "Subscription", AppSyncField: "changed"},
		{Surface: SecureRouteWebSocket, Posture: AuthPostureInternalOnly, WebSocketRouteKey: "$default"},
	}
	if !reflect.DeepEqual(routes, want) {
		t.Fatalf("routes = %#v, want %#v", routes, want)
	}
	routes[0].Path = "/mutated"
	routes[0].Scopes[0] = "mutated"
	if got := app.Routes()[0]; got.Path != "/widgets/{id}" || got.Scopes[0] != "read" {
		t.Fatalf("Routes returned mutable state: %#v", got)
	}

	for name, fn := range map[string]func(){
		"zero posture": func() { app.Get("/zero", secureOKHandler, AuthPosture{}) },
		"empty scopes": func() { app.Get("/empty", secureOKHandler, Authenticated(" ")) },
		"nil handler":  func() { app.Get("/nil", nil, Public()) },
		"empty method": func() { app.Handle(" ", "/bad", secureOKHandler, Public()) },
		"bad proxy":    func() { app.Get("/bad/{path+}/tail", secureOKHandler, Public()) },
		"empty appsync": func() {
			app.AppSyncField("Query", " ", secureOKHandler, Public())
		},
		"empty websocket": func() { app.WebSocket(" ", secureOKHandler, Public()) },
		"nil websocket":   func() { app.WebSocket("nil", nil, Public()) },
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("expected registration panic")
				}
			}()
			fn()
		})
	}

	requireSecurePanic(t, "app.bad_request: duplicate route", func() {
		app.Get("/widgets/{id}", secureOKHandler, Public())
	})
	requireSecurePanic(t, "app.bad_request: duplicate websocket route", func() {
		app.WebSocket("$default", secureOKHandler, Public())
	})
}

func TestSecureGateRecordsMatchIntrospection(t *testing.T) {
	app := NewSecure(SecureOptions{})
	app.Get("/widgets/{id}", secureOKHandler, Authenticated("read", "write"))
	app.Get("/public", secureOKHandler, Public())
	app.AppSyncField("Mutation", "updateWidget", secureOKHandler, Optional())
	app.WebSocket("updates", secureOKHandler, InternalOnly())

	var sawPublic, sawAppSyncMetadata bool
	for _, route := range app.Routes() {
		sawPublic = sawPublic || (route.Path == "/public" && route.Posture == AuthPosturePublic)
		sawAppSyncMetadata = sawAppSyncMetadata || (route.Surface == SecureRouteAppSync &&
			route.AppSyncParentType == "Mutation" && route.AppSyncField == "updateWidget")
	}
	if !sawPublic {
		t.Fatal("Routes() omitted the registered Public route")
	}
	if !sawAppSyncMetadata {
		t.Fatal("Routes() omitted populated AppSync parent/field metadata")
	}

	gateRoutes := make(map[string]SecureRoute)
	for _, registered := range app.core.router.routes {
		if !registered.Secure {
			continue
		}
		route := SecureRoute{
			Surface: registered.SecureSurface,
			Method:  registered.Method,
			Path:    registered.Pattern,
			Posture: registered.Posture.kind,
			Scopes:  append([]string(nil), registered.Posture.scopes...),
		}
		gateRoutes[string(route.Surface)+" "+route.Method+" "+route.Path] = route
	}
	for _, registered := range app.core.webSocketRoutes {
		if !registered.Secure {
			continue
		}
		route := SecureRoute{
			Surface:           SecureRouteWebSocket,
			Posture:           registered.Posture.kind,
			Scopes:            append([]string(nil), registered.Posture.scopes...),
			WebSocketRouteKey: registered.RouteKey,
		}
		gateRoutes[string(route.Surface)+" "+route.WebSocketRouteKey] = route
	}

	introspectionRoutes := make(map[string]SecureRoute)
	for _, route := range app.Routes() {
		// Parent and field are descriptive AppSync metadata; the gate consumes
		// the shared transport, method, path, posture, and scopes projection.
		route.AppSyncParentType = ""
		route.AppSyncField = ""
		key := string(route.Surface) + " " + route.Method + " " + route.Path
		if route.Surface == SecureRouteWebSocket {
			key = string(route.Surface) + " " + route.WebSocketRouteKey
		}
		if _, duplicate := introspectionRoutes[key]; duplicate {
			t.Fatalf("duplicate introspection route %q", key)
		}
		introspectionRoutes[key] = route
	}

	if !reflect.DeepEqual(introspectionRoutes, gateRoutes) {
		t.Fatalf("introspection routes = %#v, gate routes = %#v", introspectionRoutes, gateRoutes)
	}
}

func TestSecureAuthorizationMatrix(t *testing.T) {
	tests := []struct {
		name      string
		tier      Tier
		posture   AuthPosture
		principal *SecurePrincipal
		resolver  error
		status    int
	}{
		{name: "p0 authenticated", tier: TierP0, posture: Authenticated(), principal: &SecurePrincipal{Identity: "user", Kind: PrincipalExternal}, status: 200},
		{name: "optional anonymous", tier: TierP1, posture: Optional(), status: 200},
		{name: "all scopes missing", tier: TierP2, posture: Authenticated("read", "write"), principal: &SecurePrincipal{Identity: "user", Kind: PrincipalExternal, Scopes: []string{"read"}}, status: 403},
		{name: "internal external", tier: TierP2, posture: InternalOnly(), principal: &SecurePrincipal{Identity: "user", Kind: PrincipalExternal}, status: 403},
		{name: "internal allowed", tier: TierP2, posture: InternalOnly(), principal: &SecurePrincipal{Identity: "service", Kind: PrincipalInternal}, status: 200},
		{name: "unknown kind", tier: TierP2, posture: Optional(), principal: &SecurePrincipal{Identity: "user", Kind: PrincipalKind("unknown")}, status: 401},
		{name: "resolver error", tier: TierP2, posture: Authenticated(), resolver: NewAppTheoryError("auth.failed", "authentication failed"), status: 500},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := NewSecure(SecureOptions{Tier: test.tier, PrincipalResolver: func(*Context) (*SecurePrincipal, error) {
				return test.principal, test.resolver
			}})
			app.Get("/secure", secureOKHandler, test.posture)
			response := app.Serve(context.Background(), Request{Method: "GET", Path: "/secure"})
			if response.Status != test.status {
				t.Fatalf("status = %d, want %d: %s", response.Status, test.status, response.Body)
			}
		})
	}
}

func TestSecureMatchedRoutesWithoutPostureFailClosed(t *testing.T) {
	app := NewSecure(SecureOptions{Tier: TierP0})
	if err := app.core.router.add("GET", "/synthetic", secureOKHandler, routeOptions{}); err != nil {
		t.Fatal(err)
	}
	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/synthetic"})
	if resp.Status != 500 || !strings.Contains(string(resp.Body), `"code":"app.internal"`) {
		t.Fatalf("unpostured HTTP route response = %#v %s", resp, resp.Body)
	}

	app.core.webSocketEnabled = true
	app.core.webSocketRoutes = append(app.core.webSocketRoutes, webSocketRoute{
		RouteKey: "synthetic", Handler: secureOKHandler, Secure: true,
	})
	out := app.ServeWebSocket(context.Background(), events.APIGatewayWebsocketProxyRequest{
		RequestContext: events.APIGatewayWebsocketProxyRequestContext{
			RouteKey: "synthetic", ConnectionID: "c1", RequestID: "r1",
		},
	})
	if out.StatusCode != 500 || !strings.Contains(out.Body, `"code":"app.internal"`) {
		t.Fatalf("unpostured websocket response = %#v", out)
	}
}

func TestSecurePrincipalAccessorDeepCopiesNestedValues(t *testing.T) {
	type nestedClaim struct{ Values []string }
	principal := &SecurePrincipal{
		Identity: "user",
		Kind:     PrincipalExternal,
		Scopes:   []string{"read"},
		Claims: map[string]any{
			"map":    map[string]string{"key": "original"},
			"struct": &nestedClaim{Values: []string{"original"}},
			"array":  [2]string{"original", "second"},
		},
	}
	app := NewSecure(SecureOptions{PrincipalResolver: func(*Context) (*SecurePrincipal, error) {
		return principal, nil
	}})
	app.Get("/copy", func(ctx *Context) (*Response, error) {
		first := ctx.SecurePrincipal()
		first.Identity = "mutated"
		first.Scopes[0] = "mutated"
		secureClaimAs[map[string]string](t, first.Claims, "map")["key"] = "mutated"
		secureClaimAs[*nestedClaim](t, first.Claims, "struct").Values[0] = "mutated"
		firstArray := secureClaimAs[[2]string](t, first.Claims, "array")
		firstArray[0] = "mutated"
		first.Claims["array"] = firstArray
		second := ctx.SecurePrincipal()
		if second.Identity != "user" || second.Scopes[0] != "read" ||
			secureClaimAs[map[string]string](t, second.Claims, "map")["key"] != "original" ||
			secureClaimAs[*nestedClaim](t, second.Claims, "struct").Values[0] != "original" ||
			secureClaimAs[[2]string](t, second.Claims, "array")[0] != "original" {
			t.Fatalf("principal accessor leaked mutation: %#v", second)
		}
		return Text(200, "ok"), nil
	}, Authenticated())
	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/copy"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if principal.Identity != "user" || secureClaimAs[map[string]string](t, principal.Claims, "map")["key"] != "original" {
		t.Fatalf("resolver principal was mutated: %#v", principal)
	}
}

func TestSecureWebSocketResolverPanicIsRecovered(t *testing.T) {
	app := NewSecure(SecureOptions{Tier: TierP2, PrincipalResolver: func(*Context) (*SecurePrincipal, error) {
		panic("resolver panic")
	}})
	app.WebSocket("send", secureOKHandler, Authenticated())
	out := app.ServeWebSocket(context.Background(), events.APIGatewayWebsocketProxyRequest{
		RequestContext: events.APIGatewayWebsocketProxyRequestContext{
			RouteKey: "send", ConnectionID: "c1", RequestID: "r1",
		},
	})
	if out.StatusCode != 500 || !strings.Contains(out.Body, `"code":"app.internal"`) {
		t.Fatalf("resolver panic response = %#v", out)
	}
}

func TestSecureWebSocketSupportControlsLambdaRecognition(t *testing.T) {
	event, err := json.Marshal(events.APIGatewayWebsocketProxyRequest{
		RequestContext: events.APIGatewayWebsocketProxyRequestContext{
			RouteKey: "$default", ConnectionID: "c1", RequestID: "r1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, handleErr := NewSecure(SecureOptions{}).HandleLambda(context.Background(), event); handleErr == nil {
		t.Fatal("disabled WebSocket support unexpectedly recognized event")
	}
	result, err := NewSecure(SecureOptions{WebSocketSupport: true}).HandleLambda(context.Background(), event)
	if err != nil {
		t.Fatalf("enabled WebSocket support: %v", err)
	}
	if secureProxyResult(t, result).StatusCode != 404 {
		t.Fatalf("enabled WebSocket support result = %#v", result)
	}
}

func TestSecureOpenAPIFailsClosedOnJoinAndSchemeValues(t *testing.T) {
	app := NewSecure(SecureOptions{})
	app.Get("/items/{id}", secureOKHandler, Authenticated("items:read"))
	base := SecureOpenAPISpec{
		Title: "Secure", Version: "1.0.0",
		Routes: []OpenAPIRouteSpec{{
			Method: "GET", Path: "/items/:id", OperationID: "item",
			Response: OpenAPIResponseSpec{Description: "ok"},
		}},
		SecuritySchemes: map[string]map[string]any{"Bearer": {"type": "http", "scheme": "bearer", "metadata": []any{"one", true, nil}}},
		AuthSchemes:     OpenAPIAuthSchemes{Authenticated: []string{"Bearer"}},
	}
	doc, generationErr := app.GenerateOpenAPI(base)
	if generationErr != nil {
		t.Fatalf("GenerateOpenAPI: %v", generationErr)
	}
	if encoded, jsonErr := app.GenerateOpenAPIJSON(base); jsonErr != nil || len(encoded) == 0 {
		t.Fatalf("GenerateOpenAPIJSON: bytes=%d err=%v", len(encoded), jsonErr)
	}
	operation := secureOpenAPIOperation(t, doc, "/items/{id}", "get")
	if operation["x-apptheory-auth-posture"] != "authenticated" {
		t.Fatalf("posture extension missing: %#v", operation)
	}

	missing := base
	missing.Routes = nil
	if _, err := app.GenerateOpenAPI(missing); err == nil || !strings.Contains(err.Error(), "missing route") {
		t.Fatalf("missing route error = %v", err)
	}
	extra := base
	extra.Routes = append(append([]OpenAPIRouteSpec(nil), base.Routes...), OpenAPIRouteSpec{
		Method: "GET", Path: "/extra", OperationID: "extra", Response: OpenAPIResponseSpec{Description: "ok"},
	})
	if _, err := app.GenerateOpenAPI(extra); err == nil || !strings.Contains(err.Error(), "extra route") {
		t.Fatalf("extra route error = %v", err)
	}
	missingBinding := base
	missingBinding.AuthSchemes = OpenAPIAuthSchemes{}
	if _, err := app.GenerateOpenAPI(missingBinding); err == nil || !strings.Contains(err.Error(), "binding is required") {
		t.Fatalf("missing binding error = %v", err)
	}
	numeric := base
	numeric.SecuritySchemes = map[string]map[string]any{"Bearer": {"type": "http", "number": 1}}
	if _, err := app.GenerateOpenAPI(numeric); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("numeric scheme error = %v", err)
	}
	cycleValue := map[string]any{}
	cycleValue["self"] = cycleValue
	cyclic := base
	cyclic.SecuritySchemes = map[string]map[string]any{"Bearer": cycleValue}
	if _, err := app.GenerateOpenAPI(cyclic); err == nil || !strings.Contains(err.Error(), "cyclic") {
		t.Fatalf("cyclic scheme error = %v", err)
	}
	trimmed := base
	spacedBearer := " " + "Bearer" + " "
	trimmed.SecuritySchemes = map[string]map[string]any{spacedBearer: {"type": "http", "scheme": "bearer"}}
	if _, err := app.GenerateOpenAPI(trimmed); err != nil {
		t.Fatalf("trimmed scheme name: %v", err)
	}
	duplicate := base
	duplicate.SecuritySchemes = map[string]map[string]any{
		"Bearer":     {"type": "http", "scheme": "bearer"},
		spacedBearer: {"type": "http", "scheme": "bearer"},
	}
	if _, err := app.GenerateOpenAPI(duplicate); err == nil || !strings.Contains(err.Error(), "duplicated") {
		t.Fatalf("normalized duplicate scheme error = %v", err)
	}

	proxyApp := NewSecure(SecureOptions{})
	proxyApp.Get("/files/{path+}", secureOKHandler, Public())
	proxySpec := SecureOpenAPISpec{
		Title: "Proxy", Version: "1.0.0",
		Routes: []OpenAPIRouteSpec{{
			Method: "GET", Path: "/files/{path+}", OperationID: "file",
			Request:  OpenAPIRequestSpec{Fields: []OpenAPIFieldSpec{{Field: "path", Source: "path", Name: "path", Type: "string"}}},
			Response: OpenAPIResponseSpec{Description: "ok"},
		}},
	}
	proxyDoc, err := proxyApp.GenerateOpenAPI(proxySpec)
	if err != nil {
		t.Fatalf("proxy OpenAPI: %v", err)
	}
	if secureOpenAPIOperation(t, proxyDoc, "/files/{path}", "get")["x-apptheory-proxy"] != true {
		t.Fatal("proxy extension missing")
	}
}
