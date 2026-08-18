# ADR 0003 — SecureApp Closed-by-default HTTP and AppSync Routing

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

The design goal is not another optional policy flag. It is one opt-in application surface on which a routable HTTP
operation or AppSync field cannot exist without one canonical auth-posture declaration. This ADR specifies that
surface for all three runtimes. Go sketches use the repository's public naming style; TypeScript and Python expose
idiomatic equivalents with the same contract.

## Decision summary

1. Add `NewSecure(SecureOptions) *SecureApp` in Go. `SecureOptions` is a closed configuration value; `NewSecure` does
   not accept arbitrary `Option func(*App)` callbacks.
2. Keep one private runtime core, router, normalization path, middleware path, and Lambda entry point. `SecureApp` is
   a non-embedding facade, not a second runtime.
3. Require one opaque `AuthPosture` argument on every secure HTTP and AppSync field registration.
4. Use the closed vocabulary `Public`, `Optional`, `Authenticated(scopes...)`, and `InternalOnly`.
5. Store posture presence separately from posture kind. A matched secure route without a posture record fails closed;
   absence never means `Public`.
6. Enforce posture in the fixed framework auth stage, before every user `Use` middleware and handler. The stage cannot
   be removed or reordered.
7. Expose immutable, canonical route metadata, including an HTTP/AppSync surface discriminator, through
   `SecureApp.Routes()`.
8. Make secure OpenAPI generation a `SecureApp` method. It exact-joins the descriptive table to the HTTP projection
   of `Routes()` and takes auth posture only from the route record.
9. Freeze legacy behavior for applications constructed with `New`. Secure construction has a separate closed option
   shape and does not weaken or reinterpret the legacy constructor.

## 1. Constructor, options, and type shape

The Go public shape is:

```go
// SecureApp is the closed-by-default AppTheory HTTP and AppSync application surface.
type SecureApp struct {
	core *App // named, unexported composition; never embedded
}

// SecureOptions is the closed configuration surface accepted by NewSecure.
type SecureOptions struct {
	Clock            Clock
	IDGenerator      IDGenerator
	Tier             Tier
	HTTPErrorFormat  HTTPErrorFormat
	Limits           Limits
	CORS             CORSConfig
	PrincipalResolver SecurePrincipalResolver
	Observability    ObservabilityHooks
	PolicyHook       PolicyHook
}

// NewSecure creates a closed-by-default AppTheory application.
func NewSecure(opts SecureOptions) *SecureApp
```

`SecureOptions` intentionally is not `Option` and contains no function that receives `*App`. `Option` is currently
the exported function type `func(*App)`: accepting it would allow a caller to capture the core and later call
posture-less registration or apply mutable options to it. A closed value also gives Go the same construction model as
the TypeScript and Python option objects. The framework copies the supplied values into a private core; custom code
can receive `*Context` through hooks but can never receive the core.

An omitted tier selects P2. P1 and P2 are valid. P0 and every non-empty unknown tier fail construction with the stable
secure configuration error. The options are validated before the constructor returns. The secure option vocabulary
does not include WebSocket enablement or a WebSocket client factory. Go therefore rejects legacy
`WithWebSocketSupport()` and `WithWebSocketClientFactory(...)` by type; TypeScript and Python reject those keys at
construction even when dynamic calls bypass static checking. A private-core invariant also rejects any secure core
that reaches the end of construction with WebSocket state enabled.

`NewSecure` builds the same internal `App` core used by `New`, but it does not call `New(opts ...Option)` and does not
run caller-supplied core mutators. The core still owns one router and one `HandleLambda` dispatch path. Secure route
registration adds surface and posture metadata to that router's route record. There is no secure copy of request
normalization, middleware, error handling, or adapter logic.

`SecureApp` does **not** embed `*App` and exposes no `App()`, `Core()`, or `Unwrap()` method. HTTP registration, AppSync
field registration, and `Use` return `*SecureApp`; `Serve`, `HandleLambda`, and the existing Lambda HTTP and AppSync
adapters delegate to the core. Non-router event registrations may be forwarded because they never enter the HTTP
router. No legacy `WebSocket` method is forwarded in this implementation.

Language equivalents:

- TypeScript: `new SecureApp(options)`, with a closed, runtime-validated options object.
- Python: `SecureApp(...)`, with explicit keyword parameters and rejection of unknown keywords.

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

For Go and TypeScript, omitting posture is a compile-time error. Python raises its normal missing-required-argument
`TypeError`. All three validate the value at registration because JavaScript, untyped Python, Go's zero value, and
reflection can bypass static checking. The secure methods do not accept legacy auth `RouteOption` values. The
deprecated `*Strict` registration variants are not copied to `SecureApp`; secure registration has one path and
panics/throws on duplicate, malformed, nil-handler, or invalid-posture registrations.

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
it, run before it, or replace its result. The portable P1/P2 order is:

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

Trace behavior follows the existing portable contract: the gate appends `"auth"` before calling the resolver whenever
the posture is `Optional`, `Authenticated`, or `InternalOnly`. It does so regardless of whether resolution returns a
principal, returns nil, or errors. Thus an anonymous successful `Optional()` request still has `"auth"` in its
handler-visible `MiddlewareTrace`. `Public()` does not append `"auth"`.

CORS preflight is protocol control traffic, not anonymous handler execution. The final design deliberately keeps the
current uniform, non-oracular behavior: any syntactically recognized preflight returns the same existing 204 response
and requested-method header without route resolution, posture lookup, principal resolution, user middleware, or
handler invocation. Registered `Public`, `Authenticated`, and `InternalOnly` paths and unknown paths are
indistinguishable to an anonymous preflight caller. This avoids exposing the secure route inventory and avoids the
earlier design's required relocation of preflight into the shared route-resolution path. Legacy and secure preflight
output remain byte-identical.

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
	SecureRouteHTTP    SecureRouteSurface = "http"
	SecureRouteAppSync SecureRouteSurface = "appsync"
)

type SecureRoute struct {
	Surface           SecureRouteSurface `json:"surface"`
	Method            string             `json:"method"`
	Path              string             `json:"path"`
	Posture            AuthPostureKind    `json:"posture"`
	Scopes             []string           `json:"scopes,omitempty"`
	AppSyncParentType  string             `json:"appsync_parent_type,omitempty"`
	AppSyncField       string             `json:"appsync_field,omitempty"`
}

// Routes returns a registration-order snapshot of canonical router routes.
func (a *SecureApp) Routes() []SecureRoute
```

Method and path come from the router after canonicalization. Surface and posture come from the same immutable route
record used by matching and the gate. AppSync metadata is present only for `appsync` routes and must agree with the
canonical method/path mapping. `Routes()` returns fresh route/scope collections on every call, never handlers or
mutable route objects. Registration order is retained for deterministic audits; consumers may sort their snapshot.

`Routes()` includes HTTP routes and AppSync field routes. It excludes synthetic CORS preflight, WebSocket route keys,
and SQS, SNS, Kinesis, EventBridge, and DynamoDB registrations, which use separate registries and never touch the
router.

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

AppSync routes are excluded from the exact-set join by their stored route surface, not by an ignore list. They are
GraphQL field operations, not REST/OpenAPI operations, and remain visible in `Routes()` for audit and future GraphQL
contract generation. A descriptive OpenAPI entry that names only an AppSync route is therefore an extra descriptive
route and fails the HTTP exact-set comparison.

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
- Legacy P0/P1/P2 ordering, uniform CORS preflight, adapters, middleware, AppSync dispatch, and OpenAPI output remain
  byte-identical.
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
2. Separate HTTP operations from AppSync fields and replace the constructor/type. Add one posture to every secure
   `Get/Post/...` and `AppSyncField` registration.
3. Map legacy `RequireAuth` to `Authenticated()`, non-empty `RequireScope(a, b)` to `Authenticated(a, b)`, optional
   auth to `Optional()`, explicit anonymous routes to `Public()`, and verified service/instance-key routes to
   `InternalOnly()`.
4. Replace legacy auth hooks with one `SecurePrincipalResolver`. Implement AppSync resolution from
   `ctx.AsAppSync().Identity`, classify principals, and configure document-level OpenAPI schemes.
5. Compare `Routes()` against the effective route inventory and generate through the `SecureApp` method. Require the
   secure document marker and per-operation posture extensions in the adopter's contract test.
6. Remove the application-owned default-deny/auth allowlist only after runtime and generated-contract parity tests
   pass. Tightening posture is a later deliberate change, not part of behavior-neutral migration.

## 8. Implementation test plan

The implementation starts with shared fixtures and lands only when Go, TypeScript, and Python pass the same cases.
The fixture schema and runners must grow beyond their current `auth_required` boolean to carry secure posture,
normalized scopes, principal identity/kind, route surface, and AppSync identity inputs.

### Shared core auth and ordering fixtures

- Secure construction rejects P0, unknown tiers, unknown option keys, WebSocket enablement, and a WebSocket client
  factory; P1/P2 and omitted-as-P2 accept.
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
- Registered Public/Authenticated/InternalOnly and unknown-path CORS preflights produce the same existing 204 bytes,
  never resolve a route/principal, and never invoke middleware/handler.
- A synthetic matched secure route with no posture record returns `500 app.internal` and cannot execute.
- Legacy `App` fixtures remain byte-identical, including open-by-omission, P0, preflight, and AppSync behavior.

### Registration, AppSync, and introspection tests

- All HTTP verb helpers, `Handle`, and `AppSyncField` store exactly one posture; zero/unknown posture and empty
  supplied scopes panic/throw.
- Arbitrary Go `Option func(*App)` values are not assignable to `SecureOptions`; no constructor callback can capture
  the core.
- `Routes()` returns canonical method/path, registration order, surface, posture, scopes, and AppSync metadata.
- HTTP dispatch cannot match an AppSync-only secure route and AppSync dispatch cannot match an HTTP-only secure route.
- AppSync Query/Subscription/other parent-type mapping is pinned; every AppSync field requires posture.
- AppSync `Authenticated` and `InternalOnly` resolvers see the populated identity map before auth and produce the same
  401/403/success matrix as HTTP.
- Duplicate/canonical-equivalent paths still fail through the router, including cross-surface duplicates.
- Mutating a returned route/scope collection cannot change dispatch, enforcement, or later introspection.
- Routes expose no handlers and omit event, WebSocket, and synthetic preflight entries.

### OpenAPI tests

- Router registration, introspection, and secure description input share the exact canonical-key corpus: roots,
  missing leading slashes, surrounding/per-segment whitespace, colon/braced parameters, queries, malformed segments,
  and final proxies.
- The secure method rejects missing HTTP routes, extra descriptive routes, duplicate canonical keys, missing scheme
  bindings, and emitted proxy collisions.
- AppSync routes are present in `Routes()` but structurally absent from the OpenAPI equality set; a descriptive entry
  for an AppSync-only route is rejected as extra.
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

- a canonical `docs/features/secure-app.md` guide with constructor, posture table, middleware/preflight order,
  AppSync identity, introspection, and OpenAPI examples;
- a migration procedure covering effective-policy inventory, legacy empty-scope behavior, resolver conversion,
  allowlist retirement, and behavior-neutral rollout;
- Go, TypeScript, and Python API-reference updates generated from the reviewed public surface;
- a release note that calls the feature opt-in/additive for legacy users, states that TS/Python gain principal auth
  machinery, and calls out P1/P2, WebSocket rejection, and `Authenticated` naming;
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
- Exact OpenAPI equality may reveal undocumented or documentation-only HTTP routes. That is an intended migration
  failure, not a reason for an ignore list.
- Uniform preflight deliberately reveals no registered-route differential. It also means preflight success is not
  proof that a route exists; the actual request still undergoes normalization, matching, and posture enforcement.
- The legacy OpenAPI generator cannot infer which app a manually created `OpenAPISpec` describes. The secure API
  therefore uses a distinct spec, app-bound methods, an output marker, deprecation guidance, and a mandatory adopter
  assertion rather than pretending the free function can inspect state it does not receive.
- P0 and WebSocket exclusions are deliberate constraints. Adding auth to either requires a contract proposal rather
  than silent fallback.

## Out of scope for the eventual implementation PR

- Behavior or signature changes to apps constructed with legacy `New`, legacy route options, or legacy OpenAPI
  output.
- Automatic migration or policy tightening in Lesser or any other consumer.
- Custom/app-defined posture classes, setup-bootstrap posture, route-specific OpenAPI auth overrides, or ignore lists
  for route-set mismatches.
- WebSocket posture/introspection and non-router event-source auth posture. WebSocket configuration is rejected on
  `SecureApp` until that follow-up exists.
- GraphQL schema generation for AppSync. AppSync route posture, identity, and introspection are in scope here; only
  documentation generation beyond `Routes()` is deferred.
- A new bearer-token validator, service/instance-key protocol, AWS authorizer, IAM policy, CDK construct, deployment,
  account, or secret change.
- A second Lambda entry point, raw-event bypass, raw SDK escape hatch, or reorderable/disableable secure gate.
- Changes to P2 policy/rate limiting or general user-middleware ordering.
- npm or PyPI publication; distribution remains immutable GitHub Releases only.

## Open questions for review — resolved

1. **Q1 endorsed:** keep the deliberate `Bearer` to `Authenticated` rename. The rationale is now the
   transport-neutral reachability contract, not the availability of a Go-only hook.
2. **Q2 endorsed and extended:** reject P0, every unknown tier, WebSocket enablement, and WebSocket client-factory
   configuration during secure construction.
3. **Q3 endorsed, with the review conditions closed:** retain document-level scheme binding and refuse per-route
   overrides. The shared canonical route-key algorithm/proxy emission rules (finding 4) and recursive
   security-scheme canonicalization domain (finding 11) now make the exact join and byte-stability claim sufficient.
4. **Q4 endorsed:** WebSocket posture remains a follow-up. The current ADR closes the immediate gap by making
   WebSocket options and registration unavailable/rejected on `SecureApp` (finding 12).

The adversarial review changed the design in these material ways: arbitrary `Option` callbacks became closed
`SecureOptions`; absent posture gained an explicit fail-closed invariant; TypeScript/Python auth work is budgeted as
new core machinery; AppSync became an in-scope, surface-tagged route class; canonical keys and proxy emission became
one cross-runtime contract; principal classification moved to an additive secure type; secure OpenAPI became
app-bound with a migration marker; preflight became explicitly uniform/non-oracular; trace behavior was aligned with
the existing contract; security-scheme values gained recursive validation; and WebSocket configuration became a
construction error.

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
