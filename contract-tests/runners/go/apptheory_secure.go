package main

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"time"
	"unsafe"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/v4/runtime"
)

const (
	secureSurfaceHTTP      = "http"
	secureSurfaceAppSync   = "appsync"
	secureSurfaceWebSocket = "websocket"
	secureMutatedValue     = "mutated"
	securePostureMissing   = "missing"
	securePostureInvalid   = "invalid"
)

type secureFixtureObservation struct {
	trace     []string
	principal *apptheory.SecurePrincipal
}

type secureFixtureHarness struct {
	current         *FixtureSecureStep
	resolverCalls   int
	policyCalls     int
	middlewareCalls int
	handlerCalls    int
	observation     secureFixtureObservation
	connections     map[string]*apptheory.SecurePrincipal
}

func runFixtureSecure(f Fixture) error {
	if len(f.Expect.SecureSteps) != len(f.Input.SecureSteps) {
		return fmt.Errorf("secure step count mismatch")
	}
	if len(f.Input.SecureSteps) == 1 && strings.EqualFold(f.Input.SecureSteps[0].Operation, "construct") {
		got := captureSecureConstructionError(f.Setup.SecureApp)
		return compareSecureConstructionError(f.Expect.SecureSteps[0], got)
	}

	harness := &secureFixtureHarness{connections: map[string]*apptheory.SecurePrincipal{}}
	var resolver apptheory.SecurePrincipalResolver
	if f.Setup.SecureApp.PrincipalResolver == nil || *f.Setup.SecureApp.PrincipalResolver {
		resolver = harness.resolvePrincipal
	}
	var policy apptheory.PolicyHook
	if f.Setup.SecureApp.PolicyHook {
		policy = harness.applyPolicy
	}
	app := apptheory.NewSecure(apptheory.SecureOptions{
		Tier:              apptheory.Tier(strings.TrimSpace(f.Setup.SecureApp.Tier)),
		Clock:             fixedClock{now: time.Unix(0, 0).UTC()},
		IDGenerator:       fixedIDGenerator{id: "req_test_123"},
		WebSocketSupport:  f.Setup.SecureApp.WebSocketSupport,
		PrincipalResolver: resolver,
		PolicyHook:        policy,
	})
	app.Use(harness.middleware)
	if err := harness.registerRoutes(app, f.Setup.SecureApp.Routes, f.Setup.SecureApp.InjectPostureRecords); err != nil {
		return err
	}
	if f.Setup.SecureApp.InjectPostureRecords {
		injectSecurePostureRecords(app, f.Setup.SecureApp.Routes)
	}
	return harness.runSteps(app, f.Setup.SecureApp, f.Input.SecureSteps, f.Expect.SecureSteps)
}

func (h *secureFixtureHarness) applyPolicy(*apptheory.Context) (*apptheory.PolicyDecision, error) {
	h.policyCalls++
	return &apptheory.PolicyDecision{Code: "app.rate_limited", Message: "rate limited"}, nil
}

func (h *secureFixtureHarness) resolvePrincipal(ctx *apptheory.Context) (*apptheory.SecurePrincipal, error) {
	h.resolverCalls++
	if h.current != nil && h.current.ResolverError != nil {
		return nil, apptheory.NewAppTheoryError(h.current.ResolverError.Code, h.current.ResolverError.Message)
	}
	if h.current != nil && h.current.Principal != nil {
		return secureFixturePrincipal(h.current.Principal), nil
	}
	if h.current != nil && h.current.PrincipalFromAppSyncIdentity {
		return securePrincipalFromAppSync(ctx), nil
	}
	if ws := ctx.AsWebSocket(); ws != nil && ws.RouteKey != "$connect" {
		return cloneFixtureRuntimePrincipal(h.connections[ws.ConnectionID])
	}
	return nil, nil
}

func securePrincipalFromAppSync(ctx *apptheory.Context) *apptheory.SecurePrincipal {
	appsync := ctx.AsAppSync()
	if appsync == nil {
		return nil
	}
	identity := strings.TrimSpace(fmt.Sprint(appsync.Identity["sub"]))
	scopes := []string{}
	if values, ok := appsync.Identity["scopes"].([]any); ok {
		for _, value := range values {
			scopes = append(scopes, fmt.Sprint(value))
		}
	}
	return &apptheory.SecurePrincipal{
		Identity: identity,
		Kind:     apptheory.PrincipalExternal,
		Scopes:   scopes,
		Claims:   map[string]any{},
	}
}

func (h *secureFixtureHarness) middleware(next apptheory.Handler) apptheory.Handler {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		h.middlewareCalls++
		return next(ctx)
	}
}

func (h *secureFixtureHarness) handler(ctx *apptheory.Context) (*apptheory.Response, error) {
	h.handlerCalls++
	h.observation.trace = append([]string{}, ctx.MiddlewareTrace...)
	principal := ctx.SecurePrincipal()
	if h.current != nil && h.current.MutateReturned && principal != nil {
		principal.Identity = secureMutatedValue
		if len(principal.Scopes) > 0 {
			principal.Scopes[0] = secureMutatedValue
		}
		if nested, ok := principal.Claims["nested"].(map[string]any); ok {
			nested["value"] = secureMutatedValue
		}
		principal = ctx.SecurePrincipal()
	}
	h.observation.principal = principal
	if h.current != nil && h.current.PersistConnection && principal != nil {
		if ws := ctx.AsWebSocket(); ws != nil {
			cloned, err := cloneFixtureRuntimePrincipal(principal)
			if err != nil {
				return nil, err
			}
			h.connections[ws.ConnectionID] = cloned
		}
	}
	return apptheory.JSON(200, map[string]any{"ok": true})
}

func (h *secureFixtureHarness) registerRoutes(app *apptheory.SecureApp, routes []FixtureSecureRoute, injectPostureRecords bool) error {
	for _, route := range routes {
		posture := secureFixturePosture(route)
		if injectPostureRecords && (route.Posture == securePostureMissing || route.Posture == securePostureInvalid) {
			posture = apptheory.Public()
		}
		switch route.Surface {
		case secureSurfaceHTTP:
			app.Handle(route.Method, route.Path, h.handler, posture)
		case secureSurfaceAppSync:
			app.AppSyncField(route.ParentType, route.Field, h.handler, posture)
		case secureSurfaceWebSocket:
			app.WebSocket(route.RouteKey, h.handler, posture)
		default:
			return fmt.Errorf("unknown secure route surface %q", route.Surface)
		}
	}
	return nil
}

func (h *secureFixtureHarness) runSteps(app *apptheory.SecureApp, setup FixtureSecureSetup, steps []FixtureSecureStep, expectedSteps []FixtureSecureExpectedStep) error {
	for index := range steps {
		step := &steps[index]
		expected := expectedSteps[index]
		if step.Name != expected.Name {
			return fmt.Errorf("secure step name mismatch: %q != %q", step.Name, expected.Name)
		}
		h.current = step
		h.resolverCalls, h.policyCalls, h.middlewareCalls, h.handlerCalls = 0, 0, 0, 0
		h.observation = secureFixtureObservation{}
		if err := h.revokeConnection(*step); err != nil {
			return fmt.Errorf("secure step %s: %w", step.Name, err)
		}
		if err := runSecureFixtureStep(app, setup, *step, expected); err != nil {
			return fmt.Errorf("secure step %s: %w", step.Name, err)
		}
		if err := h.compareObservations(*step, expected); err != nil {
			return fmt.Errorf("secure step %s: %w", step.Name, err)
		}
	}
	return nil
}

func (h *secureFixtureHarness) revokeConnection(step FixtureSecureStep) error {
	if !step.RevokeConnection || step.AWSEvent == nil {
		return nil
	}
	var envelope struct {
		RequestContext struct {
			ConnectionID string `json:"connectionId"`
		} `json:"requestContext"`
	}
	if err := json.Unmarshal(step.AWSEvent.Event, &envelope); err != nil {
		return err
	}
	delete(h.connections, envelope.RequestContext.ConnectionID)
	return nil
}

func (h *secureFixtureHarness) compareObservations(step FixtureSecureStep, expected FixtureSecureExpectedStep) error {
	if step.Operation != secureSurfaceHTTP && step.Operation != secureSurfaceAppSync && step.Operation != secureSurfaceWebSocket {
		return nil
	}
	if h.resolverCalls != expected.ResolverCalls || h.policyCalls != expected.PolicyCalls || h.middlewareCalls != expected.MiddlewareCalls || h.handlerCalls != expected.HandlerCalls {
		return fmt.Errorf("side effects: resolver=%d policy=%d middleware=%d handler=%d", h.resolverCalls, h.policyCalls, h.middlewareCalls, h.handlerCalls)
	}
	if expected.Trace != nil && !reflect.DeepEqual(h.observation.trace, expected.Trace) {
		return fmt.Errorf("trace: expected %#v, got %#v", expected.Trace, h.observation.trace)
	}
	if expected.Principal != nil && !reflect.DeepEqual(securePrincipalMap(h.observation.principal), secureFixturePrincipalMap(expected.Principal)) {
		return fmt.Errorf("principal mismatch")
	}
	return nil
}

func captureSecureConstructionError(setup FixtureSecureSetup) (message string) {
	defer func() {
		if recovered := recover(); recovered != nil {
			message = fmt.Sprint(recovered)
		}
	}()
	if setup.UnknownOption || setup.InvalidWebSocketFactory {
		panic("apptheory: invalid secure configuration")
	}
	harness := &secureFixtureHarness{}
	app := apptheory.NewSecure(apptheory.SecureOptions{Tier: apptheory.Tier(setup.Tier)})
	if err := harness.registerRoutes(app, setup.Routes, false); err != nil {
		panic(err)
	}
	return ""
}

func compareSecureConstructionError(expected FixtureSecureExpectedStep, got string) error {
	if expected.ConstructionErrorPresent && got == "" {
		return fmt.Errorf("expected construction error, got nil")
	}
	if expected.ConstructionError != "" && got != expected.ConstructionError {
		return fmt.Errorf("construction error: expected %q, got %q", expected.ConstructionError, got)
	}
	if expected.ConstructionErrorContains != "" && !strings.Contains(got, expected.ConstructionErrorContains) {
		return fmt.Errorf("construction error %q does not contain %q", got, expected.ConstructionErrorContains)
	}
	if expected.ConstructionError == "" && expected.ConstructionErrorContains == "" && !expected.ConstructionErrorPresent && got != "" {
		return fmt.Errorf("unexpected construction error %q", got)
	}
	return nil
}

func secureFixturePosture(route FixtureSecureRoute) apptheory.AuthPosture {
	switch route.Posture {
	case "public":
		return apptheory.Public()
	case "optional":
		return apptheory.Optional()
	case "authenticated":
		return apptheory.Authenticated(route.Scopes...)
	case "authenticated_any_of":
		return apptheory.AuthenticatedAnyOf(route.Scopes...)
	case "internal_only":
		return apptheory.InternalOnly()
	default:
		return apptheory.AuthPosture{}
	}
}

func injectSecurePostureRecords(app *apptheory.SecureApp, routes []FixtureSecureRoute) {
	core := secureWritableValue(reflect.ValueOf(app).Elem().FieldByName("core")).Elem()
	routerRoutes := secureWritableValue(secureWritableValue(core.FieldByName("router")).Elem().FieldByName("routes"))
	webSocketRoutes := secureWritableValue(core.FieldByName("webSocketRoutes"))
	httpIndex, webSocketIndex := 0, 0
	for _, configured := range routes {
		if configured.Surface == secureSurfaceWebSocket {
			if configured.Posture == securePostureMissing || configured.Posture == securePostureInvalid {
				injectSecurePostureValue(secureWritableValue(webSocketRoutes.Index(webSocketIndex)), configured.Posture)
			}
			webSocketIndex++
			continue
		}
		if configured.Posture == securePostureMissing || configured.Posture == securePostureInvalid {
			injectSecurePostureValue(secureWritableValue(routerRoutes.Index(httpIndex)), configured.Posture)
		}
		httpIndex++
	}
}

func injectSecurePostureValue(route reflect.Value, posture string) {
	if posture == securePostureMissing {
		secureWritableValue(route.FieldByName("PosturePresent")).SetBool(false)
		return
	}
	postureValue := secureWritableValue(route.FieldByName("Posture"))
	secureWritableValue(postureValue.FieldByName("kind")).SetString(securePostureInvalid)
}

func secureWritableValue(value reflect.Value) reflect.Value {
	// #nosec G103 -- the contract runner deliberately injects impossible private states.
	return reflect.NewAt(value.Type(), unsafe.Pointer(value.UnsafeAddr())).Elem()
}

func secureFixturePrincipal(input *FixtureSecurePrincipal) *apptheory.SecurePrincipal {
	if input == nil {
		return nil
	}
	claims := map[string]any{}
	for key, value := range input.Claims {
		claims[key] = value
	}
	return &apptheory.SecurePrincipal{
		Identity: input.Identity,
		Kind:     apptheory.PrincipalKind(input.Kind),
		Scopes:   append([]string(nil), input.Scopes...),
		Claims:   claims,
	}
}

func cloneFixtureRuntimePrincipal(input *apptheory.SecurePrincipal) (*apptheory.SecurePrincipal, error) {
	if input == nil {
		return nil, nil
	}
	body, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	var out apptheory.SecurePrincipal
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func securePrincipalMap(input *apptheory.SecurePrincipal) any {
	if input == nil {
		return nil
	}
	return map[string]any{"identity": input.Identity, "kind": string(input.Kind), "scopes": input.Scopes, "claims": input.Claims}
}

func secureFixturePrincipalMap(input *FixtureSecurePrincipal) any {
	if input == nil {
		return nil
	}
	return map[string]any{"identity": input.Identity, "kind": input.Kind, "scopes": input.Scopes, "claims": input.Claims}
}

func runSecureFixtureStep(app *apptheory.SecureApp, setup FixtureSecureSetup, step FixtureSecureStep, expected FixtureSecureExpectedStep) error {
	switch step.Operation {
	case secureSurfaceHTTP:
		return runSecureHTTPStep(app, step, expected)
	case secureSurfaceAppSync:
		return runSecureAppSyncStep(app, step, expected)
	case secureSurfaceWebSocket:
		return runSecureWebSocketStep(app, step, expected)
	case "routes":
		return runSecureRoutesStep(app, step, expected)
	case "openapi":
		return runSecureOpenAPIStep(app, setup, step, expected)
	default:
		return fmt.Errorf("unknown secure operation %q", step.Operation)
	}
}

func runSecureHTTPStep(app *apptheory.SecureApp, step FixtureSecureStep, expected FixtureSecureExpectedStep) error {
	if step.Request == nil {
		return fmt.Errorf("missing request")
	}
	body, err := decodeFixtureBody(step.Request.Body)
	if err != nil {
		return err
	}
	resp := app.Serve(context.Background(), apptheory.Request{
		Method: step.Request.Method, Path: step.Request.Path, Query: step.Request.Query,
		Headers: step.Request.Headers, Body: body, IsBase64: step.Request.IsBase64,
	})
	if expected.Response != nil {
		expectedHeaders := canonicalizeHeaders(expected.Response.Headers)
		actualHeaders := canonicalizeHeaders(resp.Headers)
		if err := compareFixtureResponseMeta(*expected.Response, resp, expectedHeaders, actualHeaders); err != nil {
			return err
		}
		if err := compareFixtureResponseBody(*expected.Response, resp); err != nil {
			return err
		}
	}
	return compareSecureStatus(expected, resp.Status, secureErrorCodeFromBody(resp.Body))
}

func runSecureAppSyncStep(app *apptheory.SecureApp, step FixtureSecureStep, expected FixtureSecureExpectedStep) error {
	if step.AWSEvent == nil {
		return fmt.Errorf("missing appsync event")
	}
	var event apptheory.AppSyncResolverEvent
	if err := json.Unmarshal(step.AWSEvent.Event, &event); err != nil {
		return err
	}
	status, code := secureAppSyncStatus(app.ServeAppSync(context.Background(), event))
	return compareSecureStatus(expected, status, code)
}

func runSecureWebSocketStep(app *apptheory.SecureApp, step FixtureSecureStep, expected FixtureSecureExpectedStep) error {
	if step.AWSEvent == nil {
		return fmt.Errorf("missing websocket event")
	}
	var event events.APIGatewayWebsocketProxyRequest
	if err := json.Unmarshal(step.AWSEvent.Event, &event); err != nil {
		return err
	}
	out := app.ServeWebSocket(context.Background(), event)
	return compareSecureStatus(expected, out.StatusCode, secureErrorCodeFromBody([]byte(out.Body)))
}

func runSecureRoutesStep(app *apptheory.SecureApp, step FixtureSecureStep, expected FixtureSecureExpectedStep) error {
	routes := app.Routes()
	if step.MutateRoutes && len(routes) > 0 {
		routes[0].Path = "/mutated"
		if len(routes[0].Scopes) > 0 {
			routes[0].Scopes[0] = secureMutatedValue
		}
		routes = app.Routes()
	}
	body, err := json.Marshal(routes)
	if err != nil {
		return err
	}
	var actual []map[string]any
	if err := json.Unmarshal(body, &actual); err != nil {
		return err
	}
	if !secureSubsetEqual(expected.Routes, actual) {
		return fmt.Errorf("routes mismatch")
	}
	return nil
}

func runSecureOpenAPIStep(app *apptheory.SecureApp, setup FixtureSecureSetup, step FixtureSecureStep, expected FixtureSecureExpectedStep) error {
	raw := setup.OpenAPI
	if len(step.OpenAPI) > 0 {
		raw = step.OpenAPI
	}
	var spec apptheory.SecureOpenAPISpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return err
	}
	doc, err := app.GenerateOpenAPI(spec)
	if errorErr := compareSecureOpenAPIError(expected, err); errorErr != nil {
		return errorErr
	}
	if err != nil {
		return nil
	}
	projection, err := secureOpenAPIProjection(doc)
	if err != nil {
		return err
	}
	if !secureMapSubset(expected.OpenAPI, projection) {
		return fmt.Errorf("openapi projection mismatch: expected %#v got %#v", expected.OpenAPI, projection)
	}
	if expected.OpenAPIJSON == "" {
		return nil
	}
	encoded, err := app.GenerateOpenAPIJSON(spec)
	if err != nil {
		return err
	}
	if string(encoded) != expected.OpenAPIJSON {
		return fmt.Errorf("openapi json mismatch")
	}
	return nil
}

func compareSecureOpenAPIError(expected FixtureSecureExpectedStep, got error) error {
	if expected.OpenAPIError == "" && expected.OpenAPIErrorContains == "" {
		if got != nil {
			return fmt.Errorf("unexpected openapi error: %w", got)
		}
		return nil
	}
	if got == nil {
		return fmt.Errorf("expected openapi error, got nil")
	}
	message := got.Error()
	if expected.OpenAPIError != "" && message != expected.OpenAPIError {
		return fmt.Errorf("openapi error: expected %q, got %q", expected.OpenAPIError, message)
	}
	if expected.OpenAPIErrorContains != "" && !strings.Contains(message, expected.OpenAPIErrorContains) {
		return fmt.Errorf("openapi error %q does not contain %q", message, expected.OpenAPIErrorContains)
	}
	return nil
}

func compareSecureStatus(expected FixtureSecureExpectedStep, status int, code string) error {
	if status != expected.Status {
		return fmt.Errorf("status: expected %d, got %d", expected.Status, status)
	}
	if expected.ErrorCode != "" && code != expected.ErrorCode {
		return fmt.Errorf("error code: expected %q, got %q", expected.ErrorCode, code)
	}
	return nil
}

func secureErrorCodeFromBody(body []byte) string {
	var value map[string]any
	if json.Unmarshal(body, &value) != nil {
		return ""
	}
	if envelope, ok := value["error"].(map[string]any); ok {
		return fmt.Sprint(envelope["code"])
	}
	return ""
}

func secureAppSyncStatus(value any) (int, string) {
	object, ok := value.(map[string]any)
	if !ok || object["pay_theory_error"] != true {
		return 200, ""
	}
	data, dataOK := object["error_data"].(map[string]any)
	info, infoOK := object["error_info"].(map[string]any)
	if !dataOK || !infoOK {
		return 500, ""
	}
	status := 500
	if number, ok := data["status_code"].(float64); ok {
		status = int(number)
	} else if number, ok := data["status_code"].(int); ok {
		status = number
	}
	return status, fmt.Sprint(info["code"])
}

func secureSubsetEqual(expected, actual []map[string]any) bool {
	if len(expected) != len(actual) {
		return false
	}
	for i := range expected {
		if !secureMapSubset(expected[i], actual[i]) {
			return false
		}
	}
	return true
}

func secureMapSubset(expected, actual map[string]any) bool {
	for key, want := range expected {
		got, ok := actual[key]
		if !ok || !jsonEqual(want, got) {
			return false
		}
	}
	return true
}

func secureOpenAPIProjection(doc map[string]any) (map[string]any, error) {
	paths, ok := doc["paths"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("openapi paths missing")
	}
	public, err := secureOperationAt(paths, "/public", "get")
	if err != nil {
		return nil, err
	}
	files, err := secureOperationAt(paths, "/files/{path}", "get")
	if err != nil {
		return nil, err
	}
	optional, err := secureOperationAt(paths, "/optional", "get")
	if err != nil {
		return nil, err
	}
	internal, err := secureOperationAt(paths, "/internal", "post")
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"x-apptheory-contract-mode": doc["x-apptheory-contract-mode"],
		"http_route_count":          len(paths),
		"has_appsync_path":          paths["/note"] != nil,
		"has_websocket_path":        paths["/send"] != nil,
		"proxy_path":                "/files/{path}",
		"public_posture":            public["x-apptheory-auth-posture"],
		"files_posture":             files["x-apptheory-auth-posture"],
		"files_scopes":              files["x-apptheory-required-scopes"],
		"optional_posture":          optional["x-apptheory-auth-posture"],
		"optional_security":         optional["security"],
		"internal_posture":          internal["x-apptheory-auth-posture"],
		"internal_security":         internal["security"],
	}, nil
}

func secureOperationAt(paths map[string]any, path, method string) (map[string]any, error) {
	item, ok := paths[path].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("openapi path %s missing", path)
	}
	operation, ok := item[method].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("openapi operation %s %s missing", method, path)
	}
	return operation, nil
}
