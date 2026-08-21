package apptheory

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

// AuthPostureKind is the closed secure-route authorization vocabulary.
type AuthPostureKind string

const (
	AuthPosturePublic             AuthPostureKind = "public"
	AuthPostureOptional           AuthPostureKind = "optional"
	AuthPostureAuthenticated      AuthPostureKind = "authenticated"
	AuthPostureAuthenticatedAnyOf AuthPostureKind = "authenticated_any_of"
	AuthPostureInternalOnly       AuthPostureKind = "internal_only"
)

// AuthPosture is an opaque secure-route posture. Use Public, Optional,
// Authenticated, AuthenticatedAnyOf, or InternalOnly to construct one.
type AuthPosture struct {
	kind           AuthPostureKind
	scopes         []string
	scopesSupplied bool
}

func (p AuthPosture) copy() AuthPosture {
	return AuthPosture{kind: p.kind, scopes: append([]string(nil), p.scopes...), scopesSupplied: p.scopesSupplied}
}

func (p AuthPosture) validate() error {
	switch p.kind {
	case AuthPosturePublic, AuthPostureOptional, AuthPostureInternalOnly:
		if len(p.scopes) != 0 || p.scopesSupplied {
			return errors.New("apptheory: invalid auth posture")
		}
	case AuthPostureAuthenticated, AuthPostureAuthenticatedAnyOf:
		if p.scopesSupplied && len(p.scopes) == 0 {
			return errors.New("apptheory: authenticated scopes normalize to empty")
		}
	default:
		return errors.New("apptheory: invalid auth posture")
	}
	return nil
}

// Public permits anonymous access and performs no principal resolution.
func Public() AuthPosture { return AuthPosture{kind: AuthPosturePublic} }

// Optional resolves a principal when available and otherwise admits a known anonymous result.
func Optional() AuthPosture { return AuthPosture{kind: AuthPostureOptional} }

// Authenticated requires a valid principal and all supplied normalized scopes.
func Authenticated(scopes ...string) AuthPosture {
	return AuthPosture{kind: AuthPostureAuthenticated, scopes: normalizeScopeList(scopes), scopesSupplied: len(scopes) > 0}
}

// AuthenticatedAnyOf requires a valid principal and at least one supplied normalized scope.
func AuthenticatedAnyOf(scopes ...string) AuthPosture {
	return AuthPosture{kind: AuthPostureAuthenticatedAnyOf, scopes: normalizeScopeList(scopes), scopesSupplied: true}
}

// InternalOnly requires a valid principal classified as internal.
func InternalOnly() AuthPosture { return AuthPosture{kind: AuthPostureInternalOnly} }

// PrincipalKind classifies a secure principal after application-owned credential verification.
type PrincipalKind string

const (
	PrincipalExternal PrincipalKind = "external"
	PrincipalInternal PrincipalKind = "internal"
)

// SecurePrincipal is the normalized principal used by SecureApp gates.
type SecurePrincipal struct {
	Identity string
	Scopes   []string
	Claims   map[string]any
	Kind     PrincipalKind
}

// SecurePrincipalResolver resolves and validates a principal for HTTP, AppSync, or WebSocket context.
type SecurePrincipalResolver func(*Context) (*SecurePrincipal, error)

type secureCloneVisit struct {
	typeOf  reflect.Type
	pointer uintptr
}

func cloneSecureValue(value any) any {
	cloned := cloneSecureReflect(reflect.ValueOf(value), map[secureCloneVisit]reflect.Value{})
	if !cloned.IsValid() {
		return nil
	}
	return cloned.Interface()
}

func cloneSecureReflect(value reflect.Value, seen map[secureCloneVisit]reflect.Value) reflect.Value {
	if !value.IsValid() {
		return value
	}
	switch value.Kind() {
	case reflect.Interface:
		return cloneSecureInterface(value, seen)
	case reflect.Pointer:
		return cloneSecurePointer(value, seen)
	case reflect.Map:
		return cloneSecureMap(value, seen)
	case reflect.Slice:
		return cloneSecureSlice(value, seen)
	case reflect.Array:
		return cloneSecureArray(value, seen)
	case reflect.Struct:
		return cloneSecureStruct(value, seen)
	default:
		return value
	}
}

func cloneSecureInterface(value reflect.Value, seen map[secureCloneVisit]reflect.Value) reflect.Value {
	if value.IsNil() {
		return reflect.Zero(value.Type())
	}
	out := reflect.New(value.Type()).Elem()
	out.Set(cloneSecureReflect(value.Elem(), seen))
	return out
}

func cloneSecurePointer(value reflect.Value, seen map[secureCloneVisit]reflect.Value) reflect.Value {
	if value.IsNil() {
		return reflect.Zero(value.Type())
	}
	visit := secureCloneVisit{typeOf: value.Type(), pointer: value.Pointer()}
	if existing, ok := seen[visit]; ok {
		return existing
	}
	out := reflect.New(value.Type().Elem())
	seen[visit] = out
	out.Elem().Set(cloneSecureReflect(value.Elem(), seen))
	return out
}

func cloneSecureMap(value reflect.Value, seen map[secureCloneVisit]reflect.Value) reflect.Value {
	if value.IsNil() {
		return reflect.Zero(value.Type())
	}
	visit := secureCloneVisit{typeOf: value.Type(), pointer: value.Pointer()}
	if existing, ok := seen[visit]; ok {
		return existing
	}
	out := reflect.MakeMapWithSize(value.Type(), value.Len())
	seen[visit] = out
	iter := value.MapRange()
	for iter.Next() {
		out.SetMapIndex(cloneSecureReflect(iter.Key(), seen), cloneSecureReflect(iter.Value(), seen))
	}
	return out
}

func cloneSecureSlice(value reflect.Value, seen map[secureCloneVisit]reflect.Value) reflect.Value {
	if value.IsNil() {
		return reflect.Zero(value.Type())
	}
	visit := secureCloneVisit{typeOf: value.Type(), pointer: value.Pointer()}
	if existing, ok := seen[visit]; ok {
		return existing
	}
	out := reflect.MakeSlice(value.Type(), value.Len(), value.Len())
	seen[visit] = out
	for i := 0; i < value.Len(); i++ {
		out.Index(i).Set(cloneSecureReflect(value.Index(i), seen))
	}
	return out
}

func cloneSecureArray(value reflect.Value, seen map[secureCloneVisit]reflect.Value) reflect.Value {
	out := reflect.New(value.Type()).Elem()
	for i := 0; i < value.Len(); i++ {
		out.Index(i).Set(cloneSecureReflect(value.Index(i), seen))
	}
	return out
}

func cloneSecureStruct(value reflect.Value, seen map[secureCloneVisit]reflect.Value) reflect.Value {
	out := reflect.New(value.Type()).Elem()
	for i := 0; i < value.NumField(); i++ {
		if out.Field(i).CanSet() && value.Field(i).CanInterface() {
			out.Field(i).Set(cloneSecureReflect(value.Field(i), seen))
		}
	}
	return out
}

func cloneSecureClaims(claims map[string]any) map[string]any {
	cloned, ok := cloneSecureValue(claims).(map[string]any)
	if !ok {
		panic("apptheory: secure claims clone invariant")
	}
	return cloned
}

func cloneSecurePrincipal(principal *SecurePrincipal) *SecurePrincipal {
	if principal == nil {
		return nil
	}
	out := &SecurePrincipal{
		Identity: principal.Identity,
		Scopes:   append([]string{}, principal.Scopes...),
		Kind:     principal.Kind,
	}
	if principal.Claims != nil {
		out.Claims = cloneSecureClaims(principal.Claims)
	}
	return out
}

func normalizeSecurePrincipal(principal *SecurePrincipal) (*SecurePrincipal, bool) {
	if principal == nil {
		return nil, false
	}
	kind := PrincipalKind(strings.TrimSpace(string(principal.Kind)))
	if kind == "" {
		kind = PrincipalExternal
	}
	if kind != PrincipalExternal && kind != PrincipalInternal {
		return nil, true
	}
	out := cloneSecurePrincipal(principal)
	out.Identity = strings.TrimSpace(out.Identity)
	out.Scopes = normalizeScopeList(out.Scopes)
	if out.Scopes == nil {
		out.Scopes = []string{}
	}
	out.Kind = kind
	return out, false
}

func securePrincipalHasAllScopes(principal *SecurePrincipal, scopes []string) bool {
	if principal == nil {
		return false
	}
	set := securePrincipalScopeSet(principal)
	for _, scope := range scopes {
		if _, ok := set[scope]; !ok {
			return false
		}
	}
	return true
}

func securePrincipalHasAnyScope(principal *SecurePrincipal, scopes []string) bool {
	if principal == nil {
		return false
	}
	set := securePrincipalScopeSet(principal)
	for _, scope := range scopes {
		if _, ok := set[scope]; ok {
			return true
		}
	}
	return false
}

func securePrincipalScopeSet(principal *SecurePrincipal) map[string]struct{} {
	set := make(map[string]struct{}, len(principal.Scopes))
	for _, scope := range principal.Scopes {
		set[scope] = struct{}{}
	}
	return set
}

func securePrincipalSatisfiesScopes(principal *SecurePrincipal, posture AuthPosture) bool {
	switch posture.kind {
	case AuthPostureAuthenticated:
		return securePrincipalHasAllScopes(principal, posture.scopes)
	case AuthPostureAuthenticatedAnyOf:
		return securePrincipalHasAnyScope(principal, posture.scopes)
	default:
		return true
	}
}

// SecureRouteSurface identifies the transport registry that owns a secure route.
type SecureRouteSurface string

const (
	SecureRouteHTTP      SecureRouteSurface = "http"
	SecureRouteAppSync   SecureRouteSurface = "appsync"
	SecureRouteWebSocket SecureRouteSurface = "websocket"
)

// SecureRoute is immutable secure route introspection metadata.
type SecureRoute struct {
	Surface           SecureRouteSurface `json:"surface"`
	Method            string             `json:"method"`
	Path              string             `json:"path"`
	Posture           AuthPostureKind    `json:"posture"`
	Scopes            []string           `json:"scopes,omitempty"`
	AppSyncParentType string             `json:"appsync_parent_type,omitempty"`
	AppSyncField      string             `json:"appsync_field,omitempty"`
	WebSocketRouteKey string             `json:"websocket_route_key,omitempty"`
}

// SecureOptions is the closed configuration surface accepted by NewSecure.
type SecureOptions struct {
	Clock                  Clock
	IDGenerator            IDGenerator
	Tier                   Tier
	HTTPErrorFormat        HTTPErrorFormat
	Limits                 Limits
	CORS                   CORSConfig
	PrincipalResolver      SecurePrincipalResolver
	Observability          ObservabilityHooks
	PolicyHook             PolicyHook
	WebSocketSupport       bool
	WebSocketClientFactory WebSocketClientFactory
}

// SecureApp is the closed-by-default AppTheory HTTP, AppSync, and WebSocket surface.
type SecureApp struct {
	core *App
}

// NewSecure creates a closed-by-default AppTheory application.
func NewSecure(opts SecureOptions) *SecureApp {
	tier := opts.Tier
	if tier == "" {
		tier = TierP2
	}
	if tier != TierP0 && tier != TierP1 && tier != TierP2 {
		panic("apptheory: invalid secure configuration")
	}
	clock := opts.Clock
	if clock == nil {
		clock = RealClock{}
	}
	ids := opts.IDGenerator
	if ids == nil {
		ids = RandomIDGenerator{}
	}
	factory := opts.WebSocketClientFactory
	if factory == nil {
		factory = defaultWebSocketClientFactory
	}
	core := &App{
		router:                 newRouter(),
		clock:                  clock,
		ids:                    ids,
		tier:                   tier,
		httpErrorFormat:        normalizeHTTPErrorFormat(opts.HTTPErrorFormat),
		limits:                 opts.Limits,
		cors:                   normalizeCORSConfig(opts.CORS),
		obs:                    opts.Observability,
		policy:                 opts.PolicyHook,
		secure:                 true,
		secureResolver:         opts.PrincipalResolver,
		webSocketEnabled:       opts.WebSocketSupport,
		webSocketClientFactory: factory,
	}
	return &SecureApp{core: core}
}

func (a *SecureApp) requireCore() *App {
	if a == nil || a.core == nil {
		panic("apptheory: secure app is nil")
	}
	return a.core
}

func canonicalRouteKey(method, path string) (string, string, error) {
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		return "", "", routeRegistrationError("route method is empty")
	}
	path = normalizePath(path)
	segments, canonical, err := parseRouteSegments(splitPath(path))
	if err != nil {
		return "", "", err
	}
	for _, segment := range segments {
		if segment.Kind != routeSegmentStatic && strings.ContainsAny(segment.Value, "{}") {
			return "", "", routeRegistrationError("invalid route pattern")
		}
	}
	if len(canonical) == 0 {
		path = "/"
	} else {
		path = "/" + strings.Join(canonical, "/")
	}
	return method + " " + path, path, nil
}

func (a *SecureApp) register(method, pattern string, handler Handler, posture AuthPosture, surface SecureRouteSurface, parent, field string) *SecureApp {
	core := a.requireCore()
	if err := posture.validate(); err != nil {
		panic(err)
	}
	_, canonicalPath, err := canonicalRouteKey(method, pattern)
	if err != nil {
		panic(err)
	}
	if err := core.router.addSecure(method, canonicalPath, handler, surface, posture); err != nil {
		panic(err)
	}
	core.secureRoutes = append(core.secureRoutes, SecureRoute{
		Surface: surface, Method: strings.ToUpper(strings.TrimSpace(method)), Path: canonicalPath,
		Posture: posture.kind, Scopes: append([]string(nil), posture.scopes...),
		AppSyncParentType: parent, AppSyncField: field,
	})
	return a
}

// Handle registers a posture-bearing HTTP route.
func (a *SecureApp) Handle(method, pattern string, handler Handler, posture AuthPosture) *SecureApp {
	return a.register(method, pattern, handler, posture, SecureRouteHTTP, "", "")
}
func (a *SecureApp) Get(pattern string, handler Handler, posture AuthPosture) *SecureApp {
	return a.Handle("GET", pattern, handler, posture)
}
func (a *SecureApp) Post(pattern string, handler Handler, posture AuthPosture) *SecureApp {
	return a.Handle("POST", pattern, handler, posture)
}
func (a *SecureApp) Put(pattern string, handler Handler, posture AuthPosture) *SecureApp {
	return a.Handle("PUT", pattern, handler, posture)
}
func (a *SecureApp) Patch(pattern string, handler Handler, posture AuthPosture) *SecureApp {
	return a.Handle("PATCH", pattern, handler, posture)
}
func (a *SecureApp) Options(pattern string, handler Handler, posture AuthPosture) *SecureApp {
	return a.Handle("OPTIONS", pattern, handler, posture)
}
func (a *SecureApp) Delete(pattern string, handler Handler, posture AuthPosture) *SecureApp {
	return a.Handle("DELETE", pattern, handler, posture)
}

// AppSyncField registers one posture-bearing AppSync field on the shared router.
func (a *SecureApp) AppSyncField(parentTypeName, fieldName string, handler Handler, posture AuthPosture) *SecureApp {
	parent := strings.TrimSpace(parentTypeName)
	field := strings.TrimSpace(fieldName)
	if parent == "" || field == "" {
		panic(routeRegistrationError("appsync parent type and field are required"))
	}
	method := appSyncMethodPost
	if parent == "Query" || parent == "Subscription" {
		method = appSyncMethodGet
	}
	return a.register(method, "/"+field, handler, posture, SecureRouteAppSync, parent, field)
}

// WebSocket registers one posture-bearing API Gateway WebSocket route key.
func (a *SecureApp) WebSocket(routeKey string, handler WebSocketHandler, posture AuthPosture) *SecureApp {
	core := a.requireCore()
	if err := posture.validate(); err != nil {
		panic(err)
	}
	key := strings.TrimSpace(routeKey)
	if key == "" || handler == nil {
		panic(routeRegistrationError("invalid websocket route"))
	}
	for _, route := range core.webSocketRoutes {
		if route.RouteKey == key {
			panic(routeRegistrationError("duplicate websocket route"))
		}
	}
	core.webSocketEnabled = true
	core.webSocketRoutes = append(core.webSocketRoutes, webSocketRoute{RouteKey: key, Handler: handler, Secure: true, PosturePresent: true, Posture: posture.copy()})
	core.secureRoutes = append(core.secureRoutes, SecureRoute{Surface: SecureRouteWebSocket, Posture: posture.kind, Scopes: append([]string(nil), posture.scopes...), WebSocketRouteKey: key})
	return a
}

// Routes returns a defensive registration-order snapshot.
func (a *SecureApp) Routes() []SecureRoute {
	core := a.requireCore()
	out := make([]SecureRoute, len(core.secureRoutes))
	for i, route := range core.secureRoutes {
		out[i] = route
		out[i].Scopes = append([]string(nil), route.Scopes...)
	}
	return out
}

func (a *App) resolveSecurePrincipal(ctx *Context) (*SecurePrincipal, bool, error) {
	if a == nil || a.secureResolver == nil {
		return nil, false, nil
	}
	principal, err := a.secureResolver(ctx)
	if err != nil {
		return nil, false, err
	}
	normalized, invalidKind := normalizeSecurePrincipal(principal)
	return normalized, invalidKind, nil
}

func (a *App) secureGate(route route, requestCtx *Context) error {
	if !route.PosturePresent {
		return &AppError{Code: errorCodeInternal, Message: errorMessageInternal}
	}
	posture := route.Posture
	if err := posture.validate(); err != nil {
		return &AppError{Code: errorCodeInternal, Message: errorMessageInternal}
	}
	if posture.kind == AuthPosturePublic {
		return nil
	}
	requestCtx.MiddlewareTrace = append(requestCtx.MiddlewareTrace, "auth")
	principal, invalidKind, err := a.resolveSecurePrincipal(requestCtx)
	if err != nil {
		return err
	}
	if invalidKind {
		return &AppError{Code: errorCodeUnauthorized, Message: errorMessageUnauthorized}
	}
	if principal == nil || principal.Identity == "" {
		if posture.kind == AuthPostureOptional {
			return nil
		}
		return &AppError{Code: errorCodeUnauthorized, Message: errorMessageUnauthorized}
	}
	requestCtx.securePrincipal = cloneSecurePrincipal(principal)
	requestCtx.AuthIdentity = principal.Identity
	requestCtx.AuthPrincipal = &AuthPrincipal{Identity: principal.Identity, Scopes: append([]string(nil), principal.Scopes...)}
	if principal.Claims != nil {
		requestCtx.AuthPrincipal.Claims = cloneSecureClaims(principal.Claims)
	}
	if !securePrincipalSatisfiesScopes(principal, posture) {
		return &AppError{Code: errorCodeForbidden, Message: errorMessageForbidden}
	}
	if posture.kind == AuthPostureInternalOnly && principal.Kind != PrincipalInternal {
		return &AppError{Code: errorCodeForbidden, Message: errorMessageForbidden}
	}
	return nil
}

func routeToSecureGate(wsRoute webSocketRoute) route {
	return route{Secure: wsRoute.Secure, PosturePresent: wsRoute.PosturePresent, Posture: wsRoute.Posture.copy()}
}

func (a *App) authorizeSecure(route route, requestCtx *Context, requestID string, errorResponder requestErrorResponder) (Response, string, bool) {
	if err := a.secureGate(route, requestCtx); err != nil {
		code := errorCodeForError(err)
		if errorResponder != nil {
			return errorResponder(err, requestCtx.Request, requestID), code, true
		}
		return a.responseForHTTPErrorWithRequestIDTraceID(err, requestID, requestCtx.TraceID), code, true
	}
	return Response{}, "", false
}

func (a *App) authorizeSecureP0(route route, requestCtx *Context, opts serveOptions) (Response, bool) {
	if err := a.secureGate(route, requestCtx); err != nil {
		return a.respondToServeError(opts, err, requestCtx.Request, opts.fallbackRequestID), true
	}
	return Response{}, false
}

// Forwarded runtime and event-source surface.
func (a *SecureApp) Serve(ctx context.Context, req Request) Response {
	return a.requireCore().Serve(ctx, req)
}
func (a *SecureApp) ServeALB(ctx context.Context, event events.ALBTargetGroupRequest) events.ALBTargetGroupResponse {
	return a.requireCore().ServeALB(ctx, event)
}
func (a *SecureApp) ServeAPIGatewayProxy(ctx context.Context, event events.APIGatewayProxyRequest) events.APIGatewayProxyResponse {
	return a.requireCore().ServeAPIGatewayProxy(ctx, event)
}
func (a *SecureApp) ServeAPIGatewayV2(ctx context.Context, event events.APIGatewayV2HTTPRequest) events.APIGatewayV2HTTPResponse {
	return a.requireCore().ServeAPIGatewayV2(ctx, event)
}
func (a *SecureApp) ServeLambdaFunctionURL(ctx context.Context, event events.LambdaFunctionURLRequest) events.LambdaFunctionURLResponse {
	return a.requireCore().ServeLambdaFunctionURL(ctx, event)
}
func (a *SecureApp) ServeAppSync(ctx context.Context, event AppSyncResolverEvent) any {
	return a.requireCore().ServeAppSync(ctx, event)
}
func (a *SecureApp) ServeWebSocket(ctx context.Context, event events.APIGatewayWebsocketProxyRequest) events.APIGatewayProxyResponse {
	return a.requireCore().ServeWebSocket(ctx, event)
}
func (a *SecureApp) ServeDynamoDBStream(ctx context.Context, event events.DynamoDBEvent) events.DynamoDBEventResponse {
	return a.requireCore().ServeDynamoDBStream(ctx, event)
}
func (a *SecureApp) ServeEventBridge(ctx context.Context, event events.EventBridgeEvent) (any, error) {
	return a.requireCore().ServeEventBridge(ctx, event)
}
func (a *SecureApp) ServeKinesis(ctx context.Context, event events.KinesisEvent) events.KinesisEventResponse {
	return a.requireCore().ServeKinesis(ctx, event)
}
func (a *SecureApp) ServeSNS(ctx context.Context, event events.SNSEvent) ([]any, error) {
	return a.requireCore().ServeSNS(ctx, event)
}
func (a *SecureApp) ServeSQS(ctx context.Context, event events.SQSEvent) events.SQSEventResponse {
	return a.requireCore().ServeSQS(ctx, event)
}
func (a *SecureApp) HandleLambda(ctx context.Context, event json.RawMessage) (any, error) {
	return a.requireCore().HandleLambda(ctx, event)
}
func (a *SecureApp) Use(mw Middleware) *SecureApp            { a.requireCore().Use(mw); return a }
func (a *SecureApp) UseEvents(mw EventMiddleware) *SecureApp { a.requireCore().UseEvents(mw); return a }
func (a *SecureApp) IsLambda() bool                          { return a.requireCore().IsLambda() }
func (a *SecureApp) SQS(queueName string, handler SQSHandler) *SecureApp {
	a.requireCore().SQS(queueName, handler)
	return a
}
func (a *SecureApp) SNS(topicName string, handler SNSHandler) *SecureApp {
	a.requireCore().SNS(topicName, handler)
	return a
}
func (a *SecureApp) Kinesis(streamName string, handler KinesisHandler) *SecureApp {
	a.requireCore().Kinesis(streamName, handler)
	return a
}
func (a *SecureApp) EventBridge(selector EventBridgeSelector, handler EventBridgeHandler) *SecureApp {
	a.requireCore().EventBridge(selector, handler)
	return a
}
func (a *SecureApp) DynamoDB(tableName string, handler DynamoDBStreamHandler) *SecureApp {
	a.requireCore().DynamoDB(tableName, handler)
	return a
}
