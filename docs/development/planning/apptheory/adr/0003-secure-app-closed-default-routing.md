# ADR 0003 — SecureApp Closed-by-default HTTP, AppSync, and WebSocket Routing

Status: proposed

Issue: [theory-cloud/AppTheory#669](https://github.com/theory-cloud/AppTheory/issues/669)

## Context

AppTheory's current `App` route surface is intentionally permissive for compatibility. `Get`, `Post`, `Handle`, and
the other HTTP registration methods accept zero `RouteOption` values. A route with neither `RequireAuth`,
`OptionalAuth`, nor a scope option is open by omission. Go records `AuthRequired == false` and
`OptionalAuth == false`. TypeScript and Python currently record only the equivalent `authRequired == false` /
`auth_required == false` boolean; they do **not** yet have Go's optional-auth flag, route scopes, principal type, or
principal-aware hook.

The runtime and descriptive OpenAPI paths are also separate today:

- `runtime/router.go` owns canonical method/path registration and Go's auth route options.
- `runtime/serve.go` resolves the route, applies the P2 policy hook, runs `authorize`, and only then enters the user
  `Use` middleware chain.
- `runtime/openapi.go` generates OpenAPI from an explicit `OpenAPISpec.Routes` table. It does not read the runtime
  router and currently has no auth-posture field.

That separation allows an application to repeat its access policy in a route guard, a default-deny middleware, and an
OpenAPI table. Issue #669 records the concrete result in Lesser: 32 of 239 routes had different runtime and published
auth postures. One current sharp edge reinforces the premise: Go's `RequireScope(" ")` normalizes to an empty list and
returns before setting `authRequired`, so a route whose supplied scopes all normalize away is fully open.

AppSync is not a separate routing plane. `ServeAppSync` converts a resolver event to `GET /<field>` for `Query` and
`Subscription`, or `POST /<field>` otherwise, populates `ctx.appsync`, and calls the same portable serve path and
router as HTTP. A secure design must therefore classify and gate AppSync field routes rather than exclude them as an
event source.

WebSocket routing currently has the same omission problem in a separate registry. `WebSocket(routeKey, handler)`
enables WebSocket dispatch and stores only a route key and handler. `ServeWebSocket` normalizes the event, builds the
connection context, wraps the handler with the global user middleware chain, and invokes it without `applyPolicy`,
`authorize`, or any other auth stage. API Gateway supplies handshake headers at `$connect`; ordinary message frames
do not carry a fresh `Authorization` header.

The design goal is not another optional policy flag. It is one opt-in application surface on which a routable HTTP
operation, AppSync field, or WebSocket route key cannot exist without one canonical auth-posture declaration. This
ADR specifies that surface for all three runtimes. Go sketches use the repository's public naming style; TypeScript
and Python expose idiomatic equivalents with the same contract.

## Decision summary

1. Add `NewSecure(SecureOptions) *SecureApp` in Go. `SecureOptions` is a closed configuration value; `NewSecure` does
   not accept arbitrary `Option func(*App)` callbacks.
2. Keep one private runtime core, the existing HTTP router and WebSocket registry, existing normalization/middleware
   paths, and one Lambda entry point. `SecureApp` is a non-embedding facade, not a second runtime.
3. Require one opaque `AuthPosture` argument on every secure HTTP, AppSync field, and WebSocket route-key
   registration.
4. Use the closed vocabulary `Public`, `Optional`, `Authenticated(scopes...)`, and `InternalOnly`.
5. Store posture presence separately from posture kind. A matched secure route without a posture record fails closed;
   absence never means `Public`.
6. Enforce posture in the fixed framework auth stage, before every user `Use` middleware and handler. The stage runs
   for secure P0/P1/P2 and secure WebSocket dispatch and cannot be removed or reordered.
7. Extend P0 only for the secure surface: secure P0 adds posture presence and gate stages while retaining every other
   P0 omission. Legacy P0 fixtures and bytes remain frozen.
8. Expose immutable, canonical route metadata, including an HTTP/AppSync/WebSocket surface discriminator, through
   `SecureApp.Routes()`.
9. Make secure OpenAPI generation a `SecureApp` method. It exact-joins the descriptive table to the HTTP projection
   of `Routes()` and takes auth posture only from the route record; AppSync and WebSocket entries are structurally
   excluded by stored surface.
10. Keep WebSocket registration on the same facade and dispatch entry point. Every built-in or custom route key has
    independent posture, and every non-public invocation resolves a trusted connection principal before user
    middleware.
11. Freeze legacy behavior for applications constructed with `New`. Secure construction has a separate closed option
   shape and does not weaken or reinterpret the legacy constructor.

## 1. Constructor, options, and type shape

The Go public shape is:

```go
// SecureApp is the closed-by-default AppTheory HTTP, AppSync, and WebSocket surface.
type SecureApp struct {
	core *App // named, unexported composition; never embedded
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

// NewSecure creates a closed-by-default AppTheory application.
func NewSecure(opts SecureOptions) *SecureApp
```

`SecureOptions` intentionally is not `Option` and contains no function that receives `*App`. `Option` is currently
the exported function type `func(*App)`: accepting it would allow a caller to capture the core and later call
posture-less registration or apply mutable options to it. A closed value also gives Go the same construction model as
the TypeScript and Python option objects. The framework copies the supplied values into a private core; custom code
can receive `*Context` through hooks but can never receive the core.

An omitted tier selects P2. P0, P1, and P2 are valid; every non-empty unknown tier fails construction with the stable
secure configuration error. The options are validated before the constructor returns. This deliberately extends the
P0 tier contract for the secure surface only, as specified in §4. The operator accepted that compatibility trade on
2026-08-18 because a secure application that cannot run its posture gate is a contradiction. The legacy `New`
constructor's unknown-tier fallback and every legacy P0 byte remain unchanged.

`SecureOptions` includes WebSocket enablement and the management-client factory because WebSocket posture is part of
the initial contract. `WebSocketSupport: true` enables Lambda event recognition before any route is registered;
secure `WebSocket` registration also enables it, matching the legacy registration shape. Enabling support without a
registered route is valid: every WebSocket event returns the existing tier-specific 404 and no handler can execute,
so there is no unpostured route. A nil/omitted factory selects the existing default. A supplied factory must be
callable/non-nil; dynamic TypeScript/Python calls with an invalid factory or any unknown option key fail construction
rather than being ignored. Legacy `WithWebSocketSupport()` and `WithWebSocketClientFactory(...)` values remain
unassignable to `SecureOptions`; their behavior is represented by these closed fields, not by admitting arbitrary
`Option` callbacks.

`NewSecure` builds the same internal `App` core used by `New`, but it does not call `New(opts ...Option)` and does not
run caller-supplied core mutators. The core still owns one HTTP/AppSync router, one WebSocket registry, and one
`HandleLambda` dispatch path. Secure registration adds surface and posture metadata to the corresponding private
route record. There is no secure copy of request normalization, middleware, error handling, or adapter logic.

`SecureApp` does **not** embed `*App` and exposes no `App()`, `Core()`, or `Unwrap()` method. HTTP registration, AppSync
field registration, secure WebSocket registration, and `Use` return `*SecureApp`; `Serve`, `ServeWebSocket`,
`HandleLambda`, and the existing Lambda adapters delegate to the core. Non-router event registrations may be
forwarded because they never enter the HTTP router. The legacy posture-less `WebSocket` method is not promoted or
forwarded; `SecureApp` declares the mandatory-posture method in §3.

Language equivalents:

- TypeScript: `new SecureApp(options)`, with a closed, runtime-validated options object including
  `webSocketSupport` and `webSocketClientFactory`.
- Python: `SecureApp(...)`, with explicit `websocket_support` / `websocket_client_factory` keyword parameters and
  rejection of unknown keywords.

These are independent implementations of the shared contract. They share behavior, not a Go implementation. In
particular, TypeScript and Python gain new core auth machinery in this work: normalized principals, scopes,
optional-auth resolution, principal classification, and handler-visible principal context. They are not thin facades
over their current boolean-only auth cores.

## 2. Final posture and principal models

The posture passed at registration is opaque so callers cannot manufacture arbitrary posture classes:

```go
type AuthPostureKind string

const (
	AuthPosturePublic        AuthPostureKind = "public"
	AuthPostureOptional      AuthPostureKind = "optional"
	AuthPostureAuthenticated AuthPostureKind = "authenticated"
	AuthPostureInternalOnly  AuthPostureKind = "internal_only"
)

type AuthPosture struct {
	kind   AuthPostureKind
	scopes []string
}

func Public() AuthPosture
func Optional() AuthPosture
func Authenticated(scopes ...string) AuthPosture
func InternalOnly() AuthPosture
```

Only these constructors produce valid values. The zero value and unknown kinds are invalid and panic/throw at
registration. Posture constructors are not extensible interfaces: app-specific classes would make runtime and
tooling support open-ended again.

### Why `Authenticated`, not `Bearer`

Posture describes who may reach a route, not the wire credential that established identity. A principal resolver may
validate an HTTP bearer token, consume an AWS authorizer projection, verify a signed service request, or interpret an
AppSync identity. Calling the posture `Bearer` would claim a credential-scheme check that route registration does not
and should not perform. This rationale is language-neutral and does not depend on Go's existing
`WithAuthPrincipalHook` being present in the other runtimes.

The final name is therefore `Authenticated(scopes...)`. OpenAPI scheme names are configured once at the document
level. A future standardized bearer-only resolver would be a separate contract proposal and would not alter this
posture's semantics.

### Additive principal classification

This ADR does **not** add `Kind` to Go's exported `AuthPrincipal`. Adding any field, even at the end, breaks callers
that use unkeyed composite literals and would make the change source-breaking rather than purely additive. The legacy
type and `PrincipalAuthHook` remain unchanged. Secure applications use a new result type:

```go
type PrincipalKind string

const (
	PrincipalExternal PrincipalKind = "external"
	PrincipalInternal PrincipalKind = "internal"
)

type SecurePrincipal struct {
	Identity string
	Scopes   []string
	Claims   map[string]any
	Kind     PrincipalKind
}

type SecurePrincipalResolver func(*Context) (*SecurePrincipal, error)
```

The secure gate normalizes a fresh copy and exposes it through a new read-only context accessor; it also continues to
populate the existing identity/base-principal context fields where they exist. TypeScript and Python add equivalent
principal values and context access in their cores. Existing Go unkeyed `AuthPrincipal` literals continue to compile;
no migration is required for legacy `App` callers. Migrating to `SecureApp` requires wrapping a legacy string or
principal hook in the new resolver and classifying the result.

The legacy string-hook migration always returns an external principal. A resolver may return `internal` only after
the application has verified its service credential or instance key. Merely possessing a scope or claim never
upgrades a principal to internal.

Normalization is exact:

- `Kind == ""` normalizes to `external` for migrated legacy resolvers.
- `external` and `internal` are the only accepted non-empty values.
- Any other value is an invalid principal. It is rejected as `401 app.unauthorized`, not normalized to external and
  not treated as anonymous.
- Kind validation occurs before the empty-identity check. Thus `Optional()` cannot turn an unknown-kind resolver
  result into anonymous success.
- The field-by-field secure-principal normalizer must copy the normalized `Kind` as well as identity, scopes, and
  claims. A shared fixture pins this to prevent the current Go `normalizeAuthPrincipal` copy pattern from silently
  dropping classification in the new normalizer.

### Runtime semantics

| Posture | Principal resolution | No valid principal | Valid principal |
|---|---|---|---|
| `Public()` | Do not invoke the resolver. | Continue. | The framework does not enrich principal context on this route. |
| `Optional()` | Invoke the resolver. | Continue only for nil or a known-kind result with empty identity. Resolver errors and unknown kinds fail; they never fall back to anonymous. | Normalize and attach the principal. |
| `Authenticated()` | Invoke the resolver. | `401 app.unauthorized`, including when no resolver is configured. | Continue for an external or internal principal. |
| `Authenticated(scopes...)` | Invoke the resolver. | `401 app.unauthorized`. | Require **all** normalized scopes; a missing scope is `403 app.forbidden`. |
| `InternalOnly()` | Invoke the resolver. | `401 app.unauthorized`; an unknown kind is also 401 because the credential did not yield a valid principal. | Continue only for `internal`; a known external principal is `403 app.forbidden`. |

`Authenticated()` with no scopes is identity-only authentication. If scopes were supplied but all normalize to empty
strings, registration panics/throws. Duplicate scopes are removed while preserving first occurrence for
introspection; enforcement is all-of, matching Go's existing non-empty `RequireScope` behavior. Existing
`RequireAnyScope` is not a fifth posture. Any-of requirements require a future contract proposal rather than another
option on this surface.

## 3. Registration and route surfaces

Every secure HTTP method takes one non-variadic posture argument:

```go
func (a *SecureApp) Handle(method, pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Get(pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Post(pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Put(pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Patch(pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Options(pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Delete(pattern string, handler Handler, posture AuthPosture) *SecureApp

// AppSyncField registers a field on the shared router and tags it as AppSync-only.
func (a *SecureApp) AppSyncField(
	parentTypeName, fieldName string,
	handler Handler,
	posture AuthPosture,
) *SecureApp

// WebSocket registers one API Gateway WebSocket route key with mandatory posture.
func (a *SecureApp) WebSocket(
	routeKey string,
	handler WebSocketHandler,
	posture AuthPosture,
) *SecureApp
```

`AppSyncField` trims and requires both names, maps `Query` and `Subscription` to `GET /<field>`, maps every other
non-empty parent type to `POST /<field>`, and stores the parent type and field name in the route record. This preserves
the existing AppSync adapter mapping. HTTP helpers tag routes `http`; `AppSyncField` tags routes `appsync`. Both live
in the same router and portable serve path. The HTTP adapter matches only `http` secure routes, and the AppSync adapter
passes a structural surface selector that matches only `appsync` secure routes. Legacy `App` routes keep their current
shared behavior. Duplicate method/path registration remains rejected across both secure surfaces, preserving the
router's current uniqueness invariant.

Every AppSync field therefore receives one of the same four postures at registration and appears in `Routes()`.
`Authenticated` and `InternalOnly` do not trust AppSync identity automatically. Before the fixed auth stage,
`ServeAppSync` has populated `ctx.AsAppSync().Identity`; the configured `SecurePrincipalResolver` must recognize that
context, validate/interpret the identity map, and return a classified principal. It must not fall back to an HTTP
`Authorization` header for an AppSync route. No resolver or no valid identity is 401; a known external identity on
`InternalOnly` is 403. `Public` does not invoke the resolver, and `Optional` follows the exact fallback rules in §2.

WebSocket registration retains the existing route-key-first shape and adds exactly one non-variadic posture argument;
there are no parallel `Connect`, `Disconnect`, or `Default` helpers. The literal `$connect`, `$disconnect`, and
`$default` keys and every custom route key all register through `WebSocket(routeKey, handler, posture)`. The key is
trimmed, must be non-empty, and otherwise remains case-sensitive and opaque because API Gateway route selection is
not an HTTP path. Duplicate trimmed keys, a nil handler, or an invalid posture panic/throw rather than being ignored or
overwritten. Each key has independent posture:

- `$connect` gates the handshake. `Authenticated`/`InternalOnly` reject the upgrade before user middleware or the
  connect handler; `Optional` can attach a verified principal while still admitting an anonymous connection; and
  `Public` deliberately performs no principal resolution.
- `$default` and custom message keys gate every selected message invocation using that key's posture. They do not
  inherit `$connect`'s declared posture, because a more sensitive message operation may require additional scopes or
  internal classification.
- `$disconnect` is gated like every other key. Applications that must always run cleanup register it as `Public` or
  `Optional`; choosing `Authenticated` or `InternalOnly` deliberately prevents the handler when the trusted
  connection principal is missing or no longer valid.

Secure registration does not require `$connect`, `$disconnect`, and message keys to coexist in one `SecureApp`.
`AppTheoryWebSocketApi` already permits separate route Lambda handlers, so each function registers and gates the route
keys it can execute. `WebSocketSupport: true` with no registrations is likewise a closed 404-only dispatcher, not an
alternate posture-less registration path.

For Go and TypeScript, omitting posture is a compile-time error. Python raises its normal missing-required-argument
`TypeError`. All three validate the value at registration because JavaScript, untyped Python, Go's zero value, and
reflection can bypass static checking. The secure methods do not accept legacy auth `RouteOption` values. The
deprecated `*Strict` registration variants are not copied to `SecureApp`; secure HTTP, AppSync, and WebSocket
registration has one path and panics/throws on duplicate, malformed, nil-handler, or invalid-posture registrations.

Example:

```go
s := apptheory.NewSecure(apptheory.SecureOptions{
	Tier:              apptheory.TierP2,
	PrincipalResolver: resolvePrincipal,
})

s.Get("/timelines/public", publicTimeline, apptheory.Public())
s.Get("/notes/{id}", note, apptheory.Optional())
s.Get("/exports", export, apptheory.Authenticated("exports:read"))
s.Post("/internal/deliver", deliver, apptheory.InternalOnly())
s.AppSyncField("Query", "note", noteField, apptheory.Authenticated("notes:read"))
s.WebSocket("$connect", connect, apptheory.Optional())
s.WebSocket("sendMessage", sendMessage, apptheory.Authenticated("messages:write"))
s.WebSocket("$disconnect", disconnect, apptheory.Public())

// Does not compile: not enough arguments to s.Get.
// s.Get("/agents", agents)
```

## 4. Default-deny gate, preflight, and middleware ordering

The secure core records posture presence independently of kind. After a secure route match, a missing posture record
is a framework invariant failure and returns `500 app.internal` through the normal response/error projection. It does
not become `Public`, does not invoke user middleware, and does not invoke the handler. This check defends against a
future registration bug or an illicit posture-less route even though the closed constructor and facade are the
primary structural controls.

The secure gate is a fixed internal runtime stage, not an entry in the mutable `Use` slice. Calling `Use` cannot remove
it, run before it, or replace its result. The portable P1/P2 HTTP/AppSync order is:

1. canonicalize headers and establish request/observability state;
2. if the request is CORS preflight, return the uniform preflight response described below, before request
   normalization or route resolution;
3. normalize the request and establish framework context;
4. resolve the canonical route for the adapter's route surface;
5. on a secure core, prove the matched route has a posture record;
6. apply the P2 policy hook when configured;
7. apply the secure posture gate;
8. enter user `Use` middleware in registration order;
9. invoke the handler;
10. finalize response/CORS/observability under the existing tier contract.

A denied request never invokes user middleware or the handler. Resolver errors continue through the existing error
envelope and finalization path, so CORS and request IDs remain present as they are for current auth failures.

### Secure P0 extension

Current `serveP0` (`runtime/serve.go:191-241`) calls neither `applyPolicy` nor `authorize`. `NewSecure` nevertheless
supports `TierP0`. The secure-constructor-only P0 branch uses the same P0 normalization, router, context, middleware,
handler, and error projection and inserts only the two stages required to make secure routing truthful. A matched
secure P0 request traverses these stages in order:

1. normalize the request with the existing P0 `normalizeRequest` path;
2. resolve the canonical route for the adapter's stored surface, returning the current P0 404/405 projection when
   unmatched;
3. construct the current minimal P0 `Context`, including normalized request, params, clock/IDs, trace ID, and any
   adapter-specific `serveOptions.configure` values;
4. enter the current P0 panic-recovery/error-projection boundary;
5. prove that the matched secure route has a posture record, returning `500 app.internal` if it does not;
6. run the secure posture gate and attach any normalized principal;
7. wrap the route handler with global user `Use` middleware in registration order;
8. invoke the handler and project handler errors or nil output through the current P0 error path; and
9. normalize and return the response.

This is an explicit extension of the P0 tier contract **only for applications constructed with `NewSecure`**. Secure
P0 adds the posture-presence check, principal resolution/enforcement, secure principal context, and an `"auth"` trace
entry when resolution is attempted. It does not become P1 or P2. In particular, it still omits all of the stages that
the code's P0 path omits today:

- portable request-state setup: generated/propagated request ID, tenant extraction, remaining-time population, the
  `request_id`/`recovery`/`logging`/`cors` middleware-trace prefix, and the portable handler trace marker;
- the uniform early CORS-preflight short circuit and all CORS/response-header/request-ID finalization;
- `normalizeRequestWithMaxBytes`, post-normalization request-size enforcement, response-size rejection, and streamed
  response limiting;
- `applyPolicy`, including the P2 rate-limit/load-shedding policy hook, even when a hook was supplied;
- P2 observability timing, log, metric, and span recording.

P0 continues to run user `Use` middleware; that middleware is not one of its omissions. The only ordering change for a
secure P0 route is that the unskippable posture check/gate now runs before that existing user chain. Apps constructed
with legacy `New(WithTier(TierP0))` never enter this branch, retain the posture-less path, and must keep every existing
fixture byte-identical.

Trace behavior follows the existing portable contract: the gate appends `"auth"` before calling the resolver whenever
the posture is `Optional`, `Authenticated`, or `InternalOnly`. It does so regardless of whether resolution returns a
principal, returns nil, or errors. Thus an anonymous successful `Optional()` request still has `"auth"` in its
handler-visible `MiddlewareTrace`. `Public()` does not append `"auth"`.

### Secure WebSocket dispatch

The secure WebSocket registry stores posture presence and normalized posture beside each route key. `ServeWebSocket`
continues to use the single Lambda dispatcher and existing `WebSocketContext`; it does not translate a route key into
the HTTP router. Its secure dispatch order is:

1. trim and look up the route key, select the existing tier-specific request-ID/error shape, and normalize the proxy
   request;
2. build `WebSocketContext` and the containing `Context`, including connection ID, route key, event type, domain,
   stage, management endpoint, normalized headers/query/body, tenant, deadline, and request ID where the tier already
   provides them;
3. return the existing 404 projection when no route key matches;
4. prove the matched secure WebSocket record has posture, returning `500 app.internal` otherwise;
5. run the fixed secure posture gate;
6. enter the existing global user `Use` middleware chain in registration order;
7. invoke the WebSocket handler; and
8. normalize the response into the existing API Gateway proxy/error projection.

The gate therefore runs after the trusted WebSocket connection context exists but before `applyMiddlewares` can invoke
any user middleware. It applies at P0, P1, and P2. This ADR does not silently import HTTP-only portable stages into
WebSocket dispatch: WebSockets still do not run `applyPolicy`, CORS, HTTP size guardrails/finalization, or P2 HTTP
observability. The contract change is the fixed posture check/gate and principal context only; legacy `App.WebSocket`
dispatch remains byte-identical.

The same `SecurePrincipalResolver` handles WebSocket contexts. On `$connect`, it can validate handshake headers/query
from `ctx.Request` while using trusted connection metadata from `ctx.AsWebSocket()`. On a successful `Optional`,
`Authenticated`, or `InternalOnly` gate, the normalized `SecurePrincipal` is exposed through the same read-only
context accessor used by HTTP/AppSync and mirrored into the existing identity/base-principal context fields where
available. The connect handler may then persist that normalized principal against `ConnectionID` in a trusted
server-side connection store.

Message frames and `$disconnect` must not be treated as authenticated merely because API Gateway admitted the socket.
They normally have no fresh `Authorization` header. For each non-public invocation, the resolver must load and
revalidate the connection-established principal from a trusted server-side store by `ConnectionID`; AppTheory never
trusts identity or scopes from the message body and never uses warm Lambda memory as a connection cache. If no valid
connection principal is available, `Authenticated`/`InternalOnly` return 401 and
`Optional` continues anonymously under §2; scopes and internal classification are checked on every invocation. This
per-key gate, rather than `$connect`-only enforcement, preserves route-specific scopes, revocation, and fail-closed
behavior. The persistence schema/backend remains application-owned behind the resolver; this ADR adds no second auth
hook or raw-event bypass.

For P1/P2, CORS preflight is protocol control traffic, not anonymous handler execution. The final design deliberately
keeps the current uniform, non-oracular behavior: any syntactically recognized preflight returns the same existing
204 response and requested-method header without route resolution, posture lookup, principal resolution, user
middleware, or handler invocation. Registered `Public`, `Authenticated`, and `InternalOnly` paths and unknown paths
are indistinguishable to an anonymous preflight caller. This avoids exposing the secure route inventory and avoids
the earlier design's required relocation of preflight into the shared route-resolution path. Legacy and secure P1/P2
preflight output remain byte-identical. Secure P0 retains P0's existing lack of a preflight short circuit and treats an
OPTIONS request through ordinary P0 normalization/matching before the secure gate.

## 5. Canonical route keys and introspection

The implementation introduces one internal `canonicalRouteKey(method, path)` algorithm in each runtime and uses it
for secure router registration, `Routes()`, and both sides of the secure OpenAPI exact-set join. The algorithm is
contract visible and identical in Go, TypeScript, and Python:

1. trim surrounding whitespace from the method and uppercase it; secure registration/description rejects an empty
   result before constructing the key, while legacy registration retains its existing validation behavior;
2. trim surrounding whitespace from the path, discard the first `?` and everything after it, use `/` for empty, and
   prepend `/` when absent;
3. split on `/` after removing the single leading slash; `/` has no segments, while any other empty segment is
   invalid;
4. trim each segment; convert `:name` to `{name}`; trim parameter names inside braces; canonicalize a final
   `{name+}` as a proxy segment; reject empty names, stray braces, and a proxy outside the final segment;
5. rebuild `/` or `/<canonical segments>` and return the key `UPPER_METHOD + " " + canonical_path`.

This replaces use of the legacy OpenAPI-only normalization (which merely trims and prepends `/`) in the **secure
join**. The legacy generator retains its current normalization and output for compatibility.

`SecureApp` exposes one read API:

```go
type SecureRouteSurface string

const (
	SecureRouteHTTP      SecureRouteSurface = "http"
	SecureRouteAppSync   SecureRouteSurface = "appsync"
	SecureRouteWebSocket SecureRouteSurface = "websocket"
)

type SecureRoute struct {
	Surface           SecureRouteSurface `json:"surface"`
	Method            string             `json:"method"`
	Path              string             `json:"path"`
	Posture            AuthPostureKind    `json:"posture"`
	Scopes             []string           `json:"scopes,omitempty"`
	AppSyncParentType  string             `json:"appsync_parent_type,omitempty"`
	AppSyncField       string             `json:"appsync_field,omitempty"`
	WebSocketRouteKey  string             `json:"websocket_route_key,omitempty"`
}

// Routes returns a registration-order snapshot of secure route registrations.
func (a *SecureApp) Routes() []SecureRoute
```

Method and path come from the HTTP/AppSync router after canonicalization. WebSocket keys come from the secure
WebSocket registry after trim and retain exact case; `Method`, `Path`, and AppSync fields are empty for a `websocket`
entry, while `WebSocketRouteKey` is empty for `http` and `appsync`. Surface and posture come from the same immutable
record used by the corresponding matcher and gate. AppSync metadata is present only for `appsync` routes and must
agree with the canonical method/path mapping.

`Routes()` returns fresh route/scope collections on every call, never handlers or mutable route objects. One secure
registration ordinal preserves deterministic order across HTTP, AppSync, and WebSocket registries; consumers may sort
their snapshot. It excludes only synthetic CORS preflight and SQS, SNS, Kinesis, EventBridge, and DynamoDB
registrations. Those event sources have separate registries and are not posture-bearing routes in this ADR.

## 6. OpenAPI and contract interaction

Secure OpenAPI generation belongs to the secure app, not to a second free function:

```go
type OpenAPIAuthSchemes struct {
	Authenticated []string `json:"authenticated"`
	InternalOnly  []string `json:"internal_only"`
}

type SecureOpenAPISpec struct {
	Title           string                         `json:"title"`
	Version         string                         `json:"version"`
	Routes          []OpenAPIRouteSpec             `json:"routes"`
	SecuritySchemes map[string]map[string]any      `json:"security_schemes"`
	AuthSchemes     OpenAPIAuthSchemes             `json:"auth_schemes"`
}

func (a *SecureApp) GenerateOpenAPI(spec SecureOpenAPISpec) (map[string]any, error)
func (a *SecureApp) GenerateOpenAPIJSON(spec SecureOpenAPISpec) ([]byte, error)
```

`SecureOpenAPISpec` deliberately does not embed `OpenAPISpec`, and there is no free
`GenerateSecureOpenAPI(app, spec)` alternative. The secure methods emit top-level
`x-apptheory-contract-mode: "secure-v1"`. The existing `GenerateOpenAPI(OpenAPISpec)` and
`GenerateOpenAPIJSON(OpenAPISpec)` functions remain byte-identical and supported for legacy `App`, but their
documentation states that they cannot read secure posture and are unsupported/deprecated for `SecureApp` adopters.
A migration is not accepted until its generated-document test requires the secure marker and posture extension on
every HTTP operation; a document produced by the legacy function fails that check. This is an explicit boundary: the
legacy free function is not part of `SecureApp`'s contract, even though Go cannot prevent a caller from manually
constructing an unrelated legacy spec.

`SecuritySchemes` describes schemes once for the document. `AuthSchemes` binds posture classes to scheme names once;
it is not a per-route allowlist. Multiple names are OpenAPI alternatives. Every referenced name must exist. A
document containing an `Authenticated`, `Optional`, or `InternalOnly` HTTP route fails closed when the required
mapping is absent.

Caller-supplied `SecuritySchemes` values pass one recursive canonical-JSON validator in all three runtimes before
generation. It accepts only null, booleans, strings, arrays, and objects with string keys; arrays retain order and
object keys sort by Unicode scalar-value order before existing canonical JSON escaping/encoding. Values are copied
recursively. Numbers (including integer-looking floats), non-finite values, undefined/sentinel values, non-string
keys, cycles, and runtime-specific objects are rejected. OpenAPI security-scheme objects do not require numeric
members, so this closed numeric-free domain preserves the useful scheme vocabulary while guaranteeing cross-runtime
bytes. Adding numbers later requires a fixture-backed canonical-number contract rather than relying on Go, JS, and
Python defaults.

Generation follows this algorithm:

1. Snapshot `app.Routes()` and structurally select routes whose `Surface == "http"`.
2. Compute `canonicalRouteKey` for that HTTP projection and for every descriptive route.
3. Reject duplicate canonical descriptive keys.
4. Require exact set equality. A descriptive route with no HTTP registration, or an HTTP registration with no
   descriptive operation, is an error naming the canonical key.
5. Join operation metadata to `SecureRoute` by canonical key.
6. Generate OpenAPI security only from the joined route posture:
   - `Public`: explicit `security: []`;
   - `Optional`: configured authenticated alternatives plus the anonymous `{}` alternative;
   - `Authenticated`: configured authenticated alternatives and all registered scopes;
   - `InternalOnly`: configured internal-only alternatives.
7. Emit `x-apptheory-auth-posture` on every operation and `x-apptheory-required-scopes` when non-empty.
8. Sort and encode with the existing deterministic OpenAPI rules.

AppSync and WebSocket routes are excluded from the exact-set join by their stored route surfaces, not by an ignore
list. AppSync entries are GraphQL field operations; WebSocket route keys are API Gateway message-selection values,
not HTTP method/path operations. Both remain visible in `Routes()` for audit and future transport-specific contract
generation. A descriptive OpenAPI entry that names only an AppSync or WebSocket route is therefore an extra
descriptive route and fails the HTTP exact-set comparison.

The join retains the router's canonical proxy key, for example `GET /files/{path+}`. During OpenAPI emission only,
that route becomes `/files/{path}` with a required path parameter named `path` and
`x-apptheory-proxy: true`, meaning one-or-more trailing path segments. The generator errors if proxy translation would
collide with another emitted method/path. The internal plus-bearing key remains the audit/join key, so proxy semantics
are never erased during equality checking.

`OpenAPIRouteSpec` does not gain route-level `Security`, `AuthRequired`, or `Posture`. Downstream generators may
consume `Routes()` directly, but they must apply the same HTTP-surface projection and exact-set join rather than infer
auth from handler ASTs, legacy guards, or an allowlist.

## 7. Backward compatibility and migration

The implementation is additive for applications that remain on legacy construction:

- `New(opts ...Option) *App` constructs exactly the same app as before.
- `App.Handle/Get/Post/...`, `RouteOption`, `RequireAuth`, `OptionalAuth`, `RequireScope`, and `RequireAnyScope` retain
  their signatures and runtime behavior for apps constructed with `New`.
- Legacy P0/P1/P2 ordering, uniform P1/P2 CORS preflight, adapters, middleware, AppSync/WebSocket dispatch, and OpenAPI
  output remain byte-identical.
- `AuthPrincipal` is unchanged, including field count/order, so existing unkeyed composite literals still compile.
- No existing app is automatically converted and no default is flipped.

The compatibility promise is expressly about `New`, not about applying arbitrary `Option` values to a secure core:
`NewSecure` accepts `SecureOptions`, and its private core is never exposed. This resolves the option-capture bypass
without adding mode-dependent behavior to legacy `App.Handle/Get/...`.

Go's `New` documentation gains:

```go
// Deprecated: use NewSecure for new HTTP and AppSync applications. Existing
// applications may continue to use New; its route and runtime behavior is frozen.
```

TypeScript marks the legacy `App` constructor/class with `@deprecated`. Python documents deprecation in the class
docstring/type surface but emits no runtime warning. The legacy OpenAPI functions receive the SecureApp-specific
warning described in §6. Deprecation is discoverability, not scheduled removal.

Migration is per application:

1. Inventory the application's **effective runtime** posture, including default-deny allowlists and service-only
   gates; do not seed from a possibly divergent OpenAPI document. Treat legacy `RequireScope`/`RequireAnyScope` calls
   whose inputs all normalize empty as open, because current Go returns before setting `authRequired`.
2. Separate HTTP operations, AppSync fields, and WebSocket route keys and replace the constructor/type. Add one posture
   to every secure `Get/Post/...`, `AppSyncField`, and `WebSocket` registration.
3. Map legacy `RequireAuth` to `Authenticated()`, non-empty `RequireScope(a, b)` to `Authenticated(a, b)`, optional
   auth to `Optional()`, explicit anonymous routes to `Public()`, and verified service/instance-key routes to
   `InternalOnly()`.
4. Replace legacy auth hooks with one `SecurePrincipalResolver`. Implement AppSync resolution from
   `ctx.AsAppSync().Identity`; for WebSockets, validate `$connect` and load/revalidate connection principals by
   `ctx.AsWebSocket().ConnectionID` on later keys. Classify principals and configure document-level OpenAPI schemes.
5. Compare `Routes()` against the effective HTTP, AppSync, and WebSocket inventory and generate through the
   `SecureApp` method. Require the secure document marker and per-operation posture extensions in the adopter's
   contract test.
6. Remove the application-owned default-deny/auth allowlist only after runtime and generated-contract parity tests
   pass. Tightening posture is a later deliberate change, not part of behavior-neutral migration.

## 8. Implementation test plan

The implementation starts with shared fixtures and lands only when Go, TypeScript, and Python pass the same cases.
The fixture schema and runners must grow beyond their current `auth_required` boolean to carry secure posture,
normalized scopes, principal identity/kind, route surface, AppSync identity inputs, and ordered WebSocket
connect/message/disconnect sequences with a trusted connection-principal test store.

### Shared core auth and ordering fixtures

- Secure construction accepts P0/P1/P2 and omitted-as-P2, rejects unknown tiers/option keys, accepts WebSocket support
  and an omitted/default or valid client factory, and rejects an invalid dynamic factory value.
- TypeScript and Python prove their new principal, scope, optional-auth, and principal-context core behavior rather
  than delegating to a boolean-only legacy path.
- Missing/invalid posture fails registration in dynamic runtimes; typed signatures make omission a compile error.
- `Public` allows anonymous access, does not invoke the resolver, and has no `"auth"` trace.
- `Optional` distinguishes nil/empty known-kind fallback from resolver error and unknown-kind rejection; every
  attempted resolution appends `"auth"`, including anonymous success.
- `Authenticated()` returns 401 for no resolver, nil/empty identity, missing credentials, and unknown kind. A valid
  external or internal principal continues.
- `Authenticated(scopes...)` requires all normalized scopes, distinguishes 401 from 403, preserves first-occurrence
  scope order, and exposes scopes in introspection.
- `InternalOnly` distinguishes anonymous/unknown-kind 401, known-external 403, and internal success.
- A field-by-field normalization fixture proves `Kind` survives normalization in all three runtimes.
- A denied request proves user `Use` middleware and handler did not run; accepted requests prove the fixed
  policy/auth/user-middleware order and handler-visible trace.
- Secure P0 fixtures pin the exact normalize/match/context/posture/auth/`Use`/handler/response order for every posture;
  they also prove no policy hook, portable request state, CORS/preflight finalization, size/stream limit, handler trace,
  or observability stage was imported.
- Registered Public/Authenticated/InternalOnly and unknown-path P1/P2 CORS preflights produce the same existing 204
  bytes, never resolve a route/principal, and never invoke middleware/handler; secure P0 retains ordinary P0 OPTIONS
  routing.
- A synthetic matched secure route with no posture record returns `500 app.internal` and cannot execute.
- Legacy `App` fixtures remain byte-identical, including open-by-omission, P0, preflight, AppSync, and WebSocket
  behavior.

### Registration, AppSync, WebSocket, and introspection tests

- All HTTP verb helpers, `Handle`, `AppSyncField`, and `WebSocket` store exactly one posture; zero/unknown posture and
  empty supplied scopes panic/throw.
- Arbitrary Go `Option func(*App)` values are not assignable to `SecureOptions`; no constructor callback can capture
  the core.
- `Routes()` returns canonical method/path or exact trimmed WebSocket key, one cross-surface registration order,
  surface, posture, scopes, and surface-specific metadata.
- HTTP dispatch cannot match an AppSync-only secure route and AppSync dispatch cannot match an HTTP-only secure route.
- AppSync Query/Subscription/other parent-type mapping is pinned; every AppSync field requires posture.
- AppSync `Authenticated` and `InternalOnly` resolvers see the populated identity map before auth and produce the same
  401/403/success matrix as HTTP.
- Duplicate/canonical-equivalent HTTP/AppSync paths still fail through the router, including cross-surface
  duplicates; duplicate trimmed WebSocket keys also fail instead of first-match/overwrite drift.
- Mutating a returned route/scope collection cannot change dispatch, enforcement, or later introspection.
- Routes expose no handlers and omit only non-posture event registrations and synthetic preflight entries.

### Shared WebSocket posture fixtures

- `$connect`, `$disconnect`, `$default`, and a custom route key each require posture and appear as `websocket`
  entries in `Routes()`; invalid/missing posture, nil handlers, empty keys, and duplicate keys fail registration.
- `Public` skips the resolver; `Optional`, `Authenticated`, scoped `Authenticated`, and `InternalOnly` reproduce the
  shared nil/error/unknown-kind/external/internal 401/403/success matrix and `"auth"` trace rules.
- A denied WebSocket invocation proves no user `Use` middleware or handler ran; an accepted invocation proves
  posture gate -> user middleware -> handler ordering at P0/P1/P2.
- `$connect` fixtures resolve handshake headers/query, expose the normalized principal before the handler, and persist
  it in the fixture's trusted connection store only after a successful gate.
- Ordered message and disconnect fixtures omit `Authorization`, resolve by `ConnectionID`, require all per-key scopes,
  re-check internal classification, and fail 401 when the connection principal is missing/revoked. Client-supplied
  body identity never authenticates a frame.
- `$connect` posture is not inherited: a connection accepted as `Optional` can still receive 403 on a scoped custom
  key, while `$disconnect` registered `Public` still runs after the principal record is removed.
- A synthetic matched secure WebSocket record without posture returns `500 app.internal`; enabling WebSocket support
  with no routes returns the existing tier-specific 404 and invokes neither resolver nor middleware.
- Client-factory configuration and management calls remain orthogonal to auth, and all existing WebSocket response,
  error-envelope, connection-context, and send-message fixtures remain byte-identical for legacy `App`.

### OpenAPI tests

- Router registration, introspection, and secure description input share the exact canonical-key corpus: roots,
  missing leading slashes, surrounding/per-segment whitespace, colon/braced parameters, queries, malformed segments,
  and final proxies.
- The secure method rejects missing HTTP routes, extra descriptive routes, duplicate canonical keys, missing scheme
  bindings, and emitted proxy collisions.
- AppSync and WebSocket routes are present in `Routes()` but structurally absent from the OpenAPI equality set; a
  descriptive entry for either non-HTTP surface is rejected as extra.
- `{path+}` emits as `{path}` plus required path parameter and `x-apptheory-proxy: true`.
- Each posture produces the specified `security` and `x-apptheory-*` output, plus the top-level secure marker.
- Security-scheme canonicalization recursively covers nested OAuth flow/scope maps and rejects every disallowed value
  class, especially numbers and non-finite/runtime-specific values.
- Scope order and canonical JSON are byte-stable across all three runtimes.
- A mutation test that changes a registered posture changes runtime authorization and generated OpenAPI from the same
  route record.
- Passing a migration through the legacy generator fails the required secure-marker/posture assertion; existing
  legacy OpenAPI fixtures themselves remain byte-identical.

### Compatibility, API snapshots, and gates

- A Go compile fixture with the existing three-field unkeyed `AuthPrincipal` literal remains valid.
- The implementation updates `api-snapshots/go.txt`, `api-snapshots/ts.txt`, and `api-snapshots/py.txt` in the same
  change after review of the new surface. This design-only PR changes no snapshot.
- The implementation runs `make rubric` and the shared contract corpus; language-specific tests supplement but do
  not replace fixtures.

## 9. Consumer documentation and release notes

The implementation release includes:

- a canonical `docs/features/secure-app.md` guide with constructor, posture table, P0/P1/P2 middleware/preflight order,
  AppSync identity, WebSocket connection-principal handling, introspection, and OpenAPI examples;
- a migration procedure covering effective-policy inventory, legacy empty-scope behavior, resolver conversion,
  allowlist retirement, and behavior-neutral rollout;
- Go, TypeScript, and Python API-reference updates generated from the reviewed public surface;
- a release note that calls the feature opt-in/additive for legacy users, states that TS/Python gain principal auth
  machinery, and calls out the secure-only P0 extension, initial WebSocket posture, and `Authenticated` naming;
- GitHub Releases installation references only.

The implementation commit uses a release-triggering Conventional Commit (for example,
`feat(runtime): add closed-default secure app routing`) and keeps all language versions/manifests aligned through the
normal release pipeline. This design commit is documentation-only and does not trigger a release.

## Consequences and risks

- The facade and closed options add public surface and forwarding work, but they prevent core capture without
  introducing a second router.
- TypeScript and Python require substantive core auth work, not facade-only work. Shared fixtures budget and enforce
  that parity.
- `InternalOnly` requires trusted principal classification in every runtime. AppTheory fails closed on missing or
  unknown classification but cannot replace credential verification owned by the resolver.
- AppSync becomes contract-visible on the secure route surface. Structural surface matching prevents accidental
  cross-transport reachability while retaining one router/serve path.
- P0 gains auth only on the secure surface. That is a deliberate tier-contract exception accepted by the operator;
  keeping the branch private to `NewSecure` and freezing legacy fixtures contains the compatibility risk.
- WebSocket posture is checked on every route-key invocation, not only `$connect`. Applications must provide a trusted
  connection-principal lookup behind the resolver for frames and disconnects; absent or revoked state fails closed.
- WebSocket entries make `Routes()` a cross-registry audit view. A global secure registration ordinal is additional
  implementation state, but avoids a second introspection API and keeps one posture inventory.
- Exact OpenAPI equality may reveal undocumented or documentation-only HTTP routes. That is an intended migration
  failure, not a reason for an ignore list.
- Uniform P1/P2 preflight deliberately reveals no registered-route differential. It also means preflight success is
  not proof that a route exists; the actual request still undergoes normalization, matching, and posture enforcement.
- The legacy OpenAPI generator cannot infer which app a manually created `OpenAPISpec` describes. The secure API
  therefore uses a distinct spec, app-bound methods, an output marker, deprecation guidance, and a mandatory adopter
  assertion rather than pretending the free function can inspect state it does not receive.

## Out of scope for the eventual implementation PR

- Behavior or signature changes to apps constructed with legacy `New`, legacy route options, or legacy OpenAPI
  output.
- Automatic migration or policy tightening in Lesser or any other consumer.
- Custom/app-defined posture classes, setup-bootstrap posture, route-specific OpenAPI auth overrides, or ignore lists
  for route-set mismatches.
- Non-router event-source auth posture. HTTP, AppSync, and WebSocket posture/introspection are in scope here.
- A framework-owned WebSocket connection-principal table, persistence schema, or second WebSocket-specific auth
  hook. Connection lookup remains behind the one `SecurePrincipalResolver` contract.
- GraphQL schema generation for AppSync. AppSync route posture, identity, and introspection are in scope here; only
  documentation generation beyond `Routes()` is deferred.
- A new bearer-token validator, service/instance-key protocol, AWS authorizer, IAM policy, CDK construct, deployment,
  account, or secret change.
- A second Lambda entry point, raw-event bypass, raw SDK escape hatch, or reorderable/disableable secure gate.
- Changes to P2 policy/rate limiting, adding the HTTP policy stage to WebSocket dispatch, or general user-middleware
  ordering.
- npm or PyPI publication; distribution remains immutable GitHub Releases only.

## Operator decisions resolving review questions

1. **Q1 approved:** keep the deliberate `Bearer` to `Authenticated` rename. The rationale is now the
   transport-neutral reachability contract, not the availability of a Go-only hook.
2. **Q2 reversed by the operator on 2026-08-18:** support P0 while continuing to reject every unknown tier. The
   reviewer recommended rejecting P0 because today's `serveP0` has neither `applyPolicy` nor `authorize` and adding
   auth changes the meaning of the tier. The operator overrode that recommendation: the secure surface extends P0
   with only posture presence and the fixed gate, because accepting an ungated secure P0 would be contradictory. The
   objection remains valid as a compatibility risk, so §4 freezes every other P0 omission and legacy P0 bytes.
3. **Q3 approved, with the review conditions closed:** retain document-level scheme binding and refuse per-route
   overrides. The shared canonical route-key algorithm/proxy emission rules (finding 4) and recursive
   security-scheme canonicalization domain (finding 11) now make the exact join and byte-stability claim sufficient.
4. **Q4 reversed by the operator on 2026-08-18:** WebSocket posture is part of the initial contract. The reviewer
   recommended deferral/rejection because current `ServeWebSocket` applies user middleware without an auth stage.
   The operator overrode that recommendation. Secure WebSocket registration now requires posture per route key, the
   fixed gate runs before user middleware on every dispatch, `Routes()` includes a `websocket` surface, and OpenAPI
   excludes it structurally.

The adversarial review changed the design in these material ways: arbitrary `Option` callbacks became closed
`SecureOptions`; absent posture gained an explicit fail-closed invariant; TypeScript/Python auth work is budgeted as
new core machinery; AppSync became an in-scope, surface-tagged route class; canonical keys and proxy emission became
one cross-runtime contract; principal classification moved to an additive secure type; secure OpenAPI became
app-bound with a migration marker; preflight became explicitly uniform/non-oracular; trace behavior was aligned with
the existing contract; and security-scheme values gained recursive validation. The 2026-08-18 operator rework then
extended secure P0 with the minimum fixed gate, admitted closed WebSocket options, and brought per-key WebSocket
posture, connection-principal resolution, introspection, structural OpenAPI exclusion, and shared fixtures into the
initial contract.

## Alternatives considered

### `NewSecure(opts ...Option)`

Rejected. `Option` is `func(*App)`, so a caller can capture the core during construction and retain both legacy route
registration and post-construction option mutation. A facade alone cannot repair that leak.

### Secure mode changing legacy `App.Handle/Get/...`

Rejected as the primary control. Making legacy methods reject only on a secure-mode core can stop one captured-core
registration path, but arbitrary captured `Option` functions can also mutate tier and WebSocket state. Closed
construction removes the core reference entirely and keeps legacy method behavior tied solely to `New`.

### `NewSecure` returning `*App` with a private mode bit

Rejected. It preserves the posture-optional method set and makes omission only a runtime panic. It would also put
`Routes()` on legacy apps or require mode-dependent public introspection behavior.

### Embedding `*App` in `SecureApp`

Rejected. Promoted legacy registration methods and the embedded field are direct bypasses.

### A global `SetAuthPolicy(ClosedByDefault)` option

Rejected. Correctness would depend on mutable configuration/call order and remain exposed to default drift.

### Reject P0 on `NewSecure`

Considered and recommended by the adversarial reviewer because P0 currently omits both `applyPolicy` and `authorize`;
rejecting it would have preserved the tier definition without an exception. The operator overrode that recommendation
on 2026-08-18. The accepted design supports P0 but changes only the secure-constructor path by inserting posture
presence and the fixed gate. Unknown tiers still fail construction, and legacy P0 remains byte-identical.

### Defer WebSocket posture and reject its options

Considered and recommended by the adversarial reviewer because current `ServeWebSocket` has no auth stage. The
operator overrode that recommendation on 2026-08-18 and placed WebSocket posture in the initial contract. Continuing
to defer would leave a first-class Lambda route registry absent from the secure inventory; silently forwarding the
legacy method would be worse because it would execute unpostured handlers.

### Enforce WebSocket posture only at `$connect`

Rejected. API Gateway naturally receives credentials and supports authorizers at connection time, but `$connect`-only
enforcement cannot represent per-message scopes, principal revocation, or a stricter internal-only custom key. Every
route key therefore declares posture and the resolver revalidates trusted connection state on every non-public
invocation.

### Route-aware secure CORS preflight

Rejected. Moving preflight after route resolution would create a 204/404/405 route-enumeration oracle, including for
`InternalOnly` routes, and would require a shared-path ordering change for no handler-security benefit. Uniform
control traffic is the single non-oracular path.

### Variadic posture with a registration-time panic

Rejected. A mandatory typed parameter gives Go and TypeScript compile-time enforcement while retaining runtime
validation for dynamic calls.

### Extensible posture interfaces

Rejected. Arbitrary application posture classes would require downstream generators to understand private policy and
would recreate drift. Application-specific bootstrap conditions belong behind one of the four route postures.
