# ADR 0003 — SecureApp Closed-by-default HTTP Routing

Status: proposed

Issue: [theory-cloud/AppTheory#669](https://github.com/theory-cloud/AppTheory/issues/669)

## Context

AppTheory's current `App` route surface is intentionally permissive for compatibility. `Get`, `Post`, `Handle`, and
the other HTTP registration methods accept zero `RouteOption` values. A route with neither `RequireAuth`,
`OptionalAuth`, nor a scope option is open by omission. In the Go runtime, the router records this as
`AuthRequired == false` and `OptionalAuth == false`; TypeScript and Python currently record the equivalent
`authRequired == false` value.

The runtime and descriptive OpenAPI paths are also separate today:

- `runtime/router.go` owns canonical method/path registration and auth route options.
- `runtime/serve.go` resolves the route, applies the P2 policy hook, runs `authorize`, and only then enters the user
  `Use` middleware chain.
- `runtime/openapi.go` generates OpenAPI from an explicit `OpenAPISpec.Routes` table. It does not read the runtime
  router and currently has no auth-posture field.

That separation allows an application to repeat its access policy in a route guard, a default-deny middleware, and an
OpenAPI table. Issue #669 records the concrete result in Lesser: 32 of 239 routes had different runtime and published
auth postures. The design goal is not another optional policy flag. It is one opt-in application surface on which a
route cannot exist without one canonical auth-posture declaration.

This ADR specifies that surface for all three runtimes. Go sketches use the repository's current public naming and
fluent registration conventions; TypeScript and Python must expose idiomatic equivalents with the same contract.

## Decision summary

1. Add `NewSecure(opts ...Option) *SecureApp` in Go. `SecureApp` is a non-embedding facade over the existing `App`
   core, not a second router or runtime.
2. Require one opaque `AuthPosture` argument on every `SecureApp` HTTP registration method.
3. Use the closed vocabulary `Public`, `Optional`, `Authenticated(scopes...)`, and `InternalOnly`.
4. Enforce posture in the fixed framework auth stage, before every user `Use` middleware and handler. The stage cannot
   be removed or reordered.
5. Expose immutable, canonical route metadata through `SecureApp.Routes()`.
6. Add a secure OpenAPI entry point that joins descriptive operation metadata to the registered route set, requires
   exact method/path set equality, and takes auth posture only from `Routes()`.
7. Freeze the legacy `App` surface and behavior. Deprecation is advisory and has no removal date.

## 1. Constructor and type shape

The Go public shape is:

```go
// SecureApp is the closed-by-default AppTheory HTTP application surface.
// It shares App's router, Lambda dispatch, normalization, tiers, and adapters.
type SecureApp struct {
	core *App // named, unexported composition; never embedded
}

// NewSecure creates a closed-by-default AppTheory application.
func NewSecure(opts ...Option) *SecureApp
```

`NewSecure` constructs the same `App` core as `New`, applies the same `Option` values, and enables a private secure
registration/enforcement mode. The core still owns exactly one router and exactly one `HandleLambda` dispatch path.
Secure registration writes posture metadata into the same internal route record used for matching and authorization.
There is no secure router fork and no secure copy of request normalization, middleware, error handling, or Lambda
adapter logic.

`SecureApp` deliberately does **not** embed `*App`. Embedding would promote `App.Get` and `App.Handle`, allowing a
caller to register a route without a posture. It also exposes no `App()`, `Core()`, or `Unwrap()` method. Those would
be registration bypasses.

The facade forwards supported runtime operations to the shared core. HTTP registration and `Use` return
`*SecureApp`; `Serve`, `HandleLambda`, and the existing Lambda HTTP adapters delegate without changing behavior.
Non-HTTP event registrations may be forwarded because they are not HTTP auth-posture declarations. WebSocket route
postures are excluded from the first implementation (see Out of scope), so the first `SecureApp` surface must not
promote the legacy posture-less `WebSocket` registration method.

The secure surface supports P1 and P2. `NewSecure(WithTier(TierP0))` must panic during construction with a stable
registration/configuration error. P0 intentionally omits the auth stage; silently accepting P0 would make the secure
constructor capable of bypassing its defining guarantee. An unknown tier must also fail construction rather than
falling back to P2 on a secure app.

Language equivalents:

- TypeScript: `new SecureApp(options)`, using the same private runtime core as `App`.
- Python: `SecureApp(...)`, using the same private runtime core as `App`.

These are independent implementations of the shared contract, not bindings around the Go implementation.

## 2. Final posture model

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

Only these constructors produce valid values. The zero value and unknown kinds are invalid and panic at registration.
Posture constructors are not extensible interfaces: app-specific classes would make runtime and tooling support
open-ended again.

### Why `Authenticated`, not `Bearer`

Issue #669 proposed `Bearer(scopes...)`. The current AppTheory guard machinery does not prove an HTTP auth scheme:
`WithAuthHook` and `WithAuthPrincipalHook` are trusted principal resolvers, and a resolver may authenticate a bearer
token, a Lambda authorizer projection, a signed service request, or another credential. Naming the posture `Bearer`
would promise a runtime check that the existing guard stage does not perform.

The final name is therefore `Authenticated(scopes...)`. OAuth/bearer validation remains one supported way to produce
an `AuthPrincipal`; it is not reimplemented inside route registration. OpenAPI scheme names are configured once at
the document level, as described below. If AppTheory later standardizes a bearer-only principal hook, that is a
separate contract proposal and must not change this posture's semantics.

### Principal classification required by `InternalOnly`

The current Go principal has identity, scopes, and claims but no trusted principal class. The eventual implementation
adds the equivalent of:

```go
type PrincipalKind string

const (
	PrincipalExternal PrincipalKind = "external"
	PrincipalInternal PrincipalKind = "internal"
)

type AuthPrincipal struct {
	Identity string
	Kind     PrincipalKind
	Scopes   []string
	Claims   map[string]any
}
```

The legacy string `AuthHook` always produces an external principal. A principal-aware hook may return internal only
after the application has verified its service credential or instance key. Empty `Kind` normalizes to external for
legacy compatibility; any other unknown value fails authentication closed. Merely possessing a scope or claim never
implicitly upgrades a principal to internal.

### Runtime semantics

| Posture | Principal resolution | Anonymous result | Authenticated result |
|---|---|---|---|
| `Public()` | Do not invoke the auth hook. | Continue. | The framework does not enrich auth context on this route. |
| `Optional()` | Invoke the configured principal hook when the auth stage runs. | Continue when it returns no principal. | Normalize and attach the principal; a hook error still fails the request. |
| `Authenticated()` | Invoke the principal hook. | `401 app.unauthorized`, including when no hook is configured. | Continue for any valid external or internal principal. |
| `Authenticated(scopes...)` | Invoke the principal-aware hook. | `401 app.unauthorized`. | Require **all** normalized scopes; missing scope is `403 app.forbidden`. |
| `InternalOnly()` | Invoke the principal-aware hook. | `401 app.unauthorized`. | Continue only for `PrincipalInternal`; an external principal is `403 app.forbidden`. |

`Authenticated()` with no scopes is valid and means identity-only authentication. If scopes were supplied but all
normalize to empty strings, registration panics. Duplicate scopes are removed while preserving first occurrence for
introspection; enforcement is all-of, matching Go's existing `RequireScope` semantics. The separate existing
`RequireAnyScope` behavior is not a fifth posture. If an any-of requirement is needed, it requires a future contract
proposal rather than an ambiguous option on this surface.

## 3. Enforcement at registration

Every secure HTTP method takes one non-variadic posture argument:

```go
func (a *SecureApp) Handle(method, pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Get(pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Post(pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Put(pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Patch(pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Options(pattern string, handler Handler, posture AuthPosture) *SecureApp
func (a *SecureApp) Delete(pattern string, handler Handler, posture AuthPosture) *SecureApp
```

For Go and TypeScript, omitting posture is a compile-time error. Python raises its normal missing-required-argument
`TypeError`. All three implementations also validate the value at registration because JavaScript, untyped Python,
Go's zero value, and reflection can bypass static checking.

The equivalent typed call shapes are `secure.get(path, handler, posture): this` in TypeScript and
`secure.get(path, handler, posture) -> SecureApp` in Python. Their posture factories use the language's normal naming
convention, but serialize to the exact four `AuthPostureKind` strings above.

The secure methods do not accept legacy auth `RouteOption` values. Allowing both `Authenticated(...)` and
`OptionalAuth()` on one route would recreate two declarations and require a precedence rule. The deprecated
error-returning `*Strict` registration variants are not copied to `SecureApp`; secure registration has one path and
panics/throws on duplicate, malformed, nil-handler, or invalid-posture registrations, consistent with the current
fluent helpers.

Example:

```go
s := apptheory.NewSecure(
	apptheory.WithTier(apptheory.TierP2),
	apptheory.WithAuthPrincipalHook(resolvePrincipal),
)

s.Get("/timelines/public", publicTimeline, apptheory.Public())
s.Get("/notes/{id}", note, apptheory.Optional())
s.Get("/exports", export, apptheory.Authenticated("exports:read"))
s.Post("/internal/deliver", deliver, apptheory.InternalOnly())

// Does not compile: not enough arguments to s.Get.
// s.Get("/agents", agents)
```

## 4. Default-deny gate and middleware ordering

The secure gate is a fixed internal runtime stage, not an entry in the mutable `Use` slice. Calling `Use` cannot
remove it, run before it, or replace its result. This preserves the current portable order around auth:

1. normalize request and establish framework context;
2. resolve the canonical route;
3. apply the P2 policy hook when configured;
4. apply the secure route posture gate;
5. enter user `Use` middleware in registration order;
6. invoke the handler;
7. finalize response/CORS/observability under the existing tier contract.

A denied request never invokes user middleware or the handler. Auth-hook errors continue through the existing error
envelope and response-finalization path, so CORS and request IDs remain present as they are for current auth failures.
The gate must add the existing `"auth"` trace entry when it resolves a principal; `Public` adds none.

The secure gate replaces legacy per-route auth options for secure routes; it does not stack a second auth decision on
top of them. OAuth bearer middleware used solely to protect selected routes must be adapted into the configured
principal resolver during migration. General middleware remains unchanged.

CORS preflight is protocol control traffic, not anonymous execution of the route handler. A secure preflight may skip
principal resolution, but it must first prove that the requested method/path identifies a registered route. It returns
the existing preflight response only for such a route; an unknown route follows normal 404/405 behavior. The eventual
contract fixtures must pin this secure-only behavior without changing legacy `App` preflight behavior.

## 5. Route introspection

`SecureApp` exposes one read API, not both `Routes` and `Walk`:

```go
type SecureRoute struct {
	Method  string          `json:"method"`
	Path    string          `json:"path"`
	Posture AuthPostureKind `json:"posture"`
	Scopes  []string        `json:"scopes,omitempty"`
}

// Routes returns a registration-order snapshot of canonical HTTP routes.
func (a *SecureApp) Routes() []SecureRoute
```

The method and path come from the router **after** its existing normalization (`GET`, canonical braces, normalized
root/path), not from a parallel registry. Scopes come from the same immutable internal posture record used by the
gate. `Routes` returns a fresh slice and fresh scope slices on every call, never handlers or mutable internal route
objects. Mutating the result cannot affect dispatch, authorization, or a later snapshot.

Registration order is retained because it is real router state and supports deterministic audits. Consumers that need
another order may sort their snapshot. The built-in OpenAPI generator already sorts by canonical path and method.

`Routes()` covers normalized HTTP routes only. It excludes synthetic CORS preflight handling, WebSocket route keys,
AppSync field dispatch, and non-HTTP event-source registrations.

## 6. OpenAPI and contract interaction

The existing `GenerateOpenAPI(OpenAPISpec)` and `GenerateOpenAPIJSON(OpenAPISpec)` functions remain behavior-identical
for legacy callers. The implementation adds secure variants with a typed, document-level mapping from AppTheory's two
authenticated classes to the application's OpenAPI security schemes:

```go
type OpenAPIAuthSchemes struct {
	Authenticated []string `json:"authenticated"`
	InternalOnly  []string `json:"internal_only"`
}

type SecureOpenAPISpec struct {
	OpenAPISpec
	SecuritySchemes map[string]map[string]any `json:"security_schemes"`
	AuthSchemes     OpenAPIAuthSchemes        `json:"auth_schemes"`
}

func GenerateSecureOpenAPI(app *SecureApp, spec SecureOpenAPISpec) (map[string]any, error)
func GenerateSecureOpenAPIJSON(app *SecureApp, spec SecureOpenAPISpec) ([]byte, error)
```

`SecuritySchemes` describes schemes once for the document. `AuthSchemes` binds posture classes to one or more scheme
names once; it is not a per-route allowlist. Multiple names are OpenAPI alternatives, which lets a principal resolver
accept (for example) either an end-user bearer credential or an internal signed credential without repeating that
choice on every route. The generator validates that every referenced scheme exists. A document containing an
`Authenticated`, `Optional`, or `InternalOnly` route fails closed when its required mapping is absent.

Generation follows this algorithm:

1. Snapshot `app.Routes()`.
2. Canonicalize the method/path keys in `spec.OpenAPISpec.Routes` using the existing generator rules.
3. Require exact set equality. A descriptive route with no runtime registration, or a registered route with no
   descriptive operation, is an error naming the mismatched key.
4. Join operation metadata to `SecureRoute` by canonical method/path.
5. Generate OpenAPI security only from the joined `SecureRoute` posture:
   - `Public`: explicit `security: []`;
   - `Optional`: configured authenticated alternatives plus the anonymous `{}` alternative;
   - `Authenticated`: configured authenticated alternatives and all registered scopes;
   - `InternalOnly`: configured internal-only alternatives.
6. Emit `x-apptheory-auth-posture` on every operation and `x-apptheory-required-scopes` when non-empty, so a scheme
   (such as HTTP bearer, whose OpenAPI security requirement array cannot express OAuth scopes) never loses the
   runtime scope contract.
7. Sort and encode with the existing deterministic OpenAPI rules.

`OpenAPIRouteSpec` does not gain a route-level `Security`, `AuthRequired`, or `Posture` field. Such a field would be a
second source of truth. Downstream generators may consume `Routes()` directly, but they must use the same exact-set
join rule rather than infer auth from handler ASTs, legacy guards, or an allowlist.

This makes the Lesser failure mode registration/generation-impossible: one of the 32 divergent routes would either
receive the registered posture in its OpenAPI operation or stop generation on a missing/extra route. It cannot silently
default to public.

## 7. Backward compatibility and migration

The eventual implementation is purely additive for existing applications:

- `New(opts ...Option) *App` constructs exactly the same app as before.
- `App.Handle/Get/Post/...`, `RouteOption`, `RequireAuth`, `OptionalAuth`, `RequireScope`, and `RequireAnyScope` retain
  their signatures and runtime behavior.
- Legacy P0/P1/P2 ordering, CORS preflight, adapters, middleware, and OpenAPI generation do not change.
- No existing app is automatically converted and no default is flipped.

Go's `New` documentation gains:

```go
// Deprecated: use NewSecure for new HTTP applications. Existing applications
// may continue to use New; its route and runtime behavior is frozen.
```

TypeScript marks the legacy `App` constructor/class with `@deprecated`. Python documents the deprecation in the class
docstring and type surface but emits no runtime warning, because a new warning would itself be an observable behavior
change. Deprecation is discoverability, not a scheduled removal; removal would require a separate major-version
proposal and is not planned by this ADR.

Migration is per application:

1. Inventory the application's **effective runtime** posture, including default-deny allowlists and service-only
   gates; do not seed from a possibly divergent OpenAPI document.
2. Replace the constructor/type and add one posture to every HTTP registration.
3. Map legacy `RequireAuth` to `Authenticated()`, `RequireScope(a, b)` to `Authenticated(a, b)`, optional auth to
   `Optional()`, explicit anonymous routes to `Public()`, and verified service/instance-key routes to
   `InternalOnly()`.
4. Configure principal classification and the document-level OpenAPI scheme bindings.
5. Compare `Routes()` against the pre-migration effective route inventory and regenerate OpenAPI.
6. Remove the application-owned default-deny/auth allowlist only after runtime and generated-contract parity tests
   pass. Tightening posture is a later deliberate change, not part of the behavior-neutral migration.

## 8. Implementation test plan

The implementation starts with shared fixtures and lands only when Go, TypeScript, and Python pass the same cases.

### Shared contract fixtures

- Secure construction rejects P0 and unknown tiers; P1 and P2 accept the surface.
- Missing/invalid posture fails at registration in dynamic runtimes; Go/TypeScript signatures make omission a compile
  error for typed consumers.
- `Public` allows anonymous access and does not invoke the auth resolver.
- `Optional` allows no principal, enriches context for a valid principal, and fails on resolver error.
- `Authenticated()` returns 401 for no hook, nil/empty identity, and missing credentials; a valid principal continues.
- `Authenticated(scopes...)` requires all normalized scopes, distinguishes 401 from 403, and exposes normalized
  scopes in introspection.
- `InternalOnly` distinguishes anonymous 401, external-principal 403, and internal-principal success. Unknown
  principal kinds fail closed.
- A denied request proves user `Use` middleware and the handler did not run; accepted requests prove the fixed
  policy/auth/user-middleware order and trace.
- Secure CORS preflight succeeds only for a registered requested method/path and never invokes its handler.
- Legacy `App` fixtures remain byte-identical, including open-by-omission and P0 behavior.

### Registration and introspection tests

- All verb helpers and `Handle` store one posture; zero/unknown posture and empty supplied scopes panic/throw.
- Legacy `RouteOption` values cannot be passed to secure registration.
- `Routes()` returns canonical method/path, registration order, posture, and scopes.
- Duplicate/canonical-equivalent paths still fail through the existing router.
- Mutating a returned route/scope collection cannot change dispatch, enforcement, or later introspection.
- Routes do not expose handlers and do not include event, WebSocket, or synthetic preflight entries.

### OpenAPI tests

- The secure generator rejects missing runtime routes, extra descriptive routes, duplicate canonical keys, and missing
  scheme bindings.
- Each posture produces the specified `security` and `x-apptheory-*` output.
- Scope order and canonical JSON are byte-stable across all three runtimes.
- A mutation test that changes a registered posture changes both runtime authorization and generated OpenAPI from the
  same route record.
- Existing OpenAPI fixtures remain byte-identical.

### API snapshots and gates

The implementation changes exported APIs in all three runtimes. It must update `api-snapshots/go.txt`,
`api-snapshots/ts.txt`, and `api-snapshots/py.txt` in the same implementation change, after review of the new surface.
This design-only PR changes no snapshot. The implementation runs the full `make rubric` gate and the shared contract
corpus; language-specific tests supplement but do not replace fixtures.

## 9. Consumer documentation and release notes

The implementation release includes:

- a canonical `docs/features/secure-app.md` guide with constructor, posture table, middleware order, introspection, and
  OpenAPI examples;
- a migration procedure covering effective-policy inventory, allowlist retirement, and behavior-neutral rollout;
- Go, TypeScript, and Python API-reference updates generated from the reviewed public surface;
- a release note that calls the feature opt-in and additive, states that legacy `App` behavior is unchanged, and calls
  out the P1/P2 requirement and `Authenticated` naming;
- GitHub Releases installation references only.

The implementation commit uses a release-triggering Conventional Commit (for example,
`feat(runtime): add closed-default secure app routing`) and keeps all language versions/manifests aligned through the
normal release pipeline. This design commit is documentation-only and does not trigger a release.

## Consequences and risks

- The facade adds public surface and forwarding work, but named composition is required to make legacy registration
  unreachable without forking runtime behavior.
- `InternalOnly` requires trusted principal classification in every runtime. A wrong application auth hook can still
  misclassify a credential; AppTheory fails closed on missing/unknown classification but cannot replace credential
  verification owned by that hook.
- Exact OpenAPI route-set equality may initially reveal existing undocumented or documentation-only routes. That is an
  intended migration failure, not a reason to add an ignore list.
- Omitting posture is compile-time enforced only in typed call sites. Runtime validation remains mandatory for
  JavaScript, Python, reflection, and zero values.
- P0 exclusion is a deliberate constraint. Adding auth to P0 would redefine the tier contract; allowing P0 unchanged
  would violate the secure constructor's contract.

## Out of scope for the eventual implementation PR

- Any behavior or signature change to legacy `App`, `New`, legacy route options, legacy OpenAPI, or existing fixtures.
- Automatic migration or policy tightening in Lesser or any other consumer.
- Custom/app-defined posture classes, a setup-bootstrap posture, route-specific OpenAPI auth overrides, or ignore
  lists for route-set mismatches.
- WebSocket posture/introspection, AppSync field posture, and non-HTTP event-source auth posture.
- A new bearer-token validator, service/instance-key protocol, AWS authorizer, IAM policy, CDK construct, deployment,
  account, or secret change.
- A second Lambda entry point, raw-event bypass, raw SDK escape hatch, or a reorderable/disableable secure gate.
- Changes to P2 policy/rate limiting, general middleware ordering, or CORS behavior outside `SecureApp`.
- npm or PyPI publication; distribution remains immutable GitHub Releases only.

## Open questions for review

1. Confirm the deliberate `Bearer` to `Authenticated` rename. It matches the current principal-hook contract but is a
   visible difference from the issue sketch.
2. Confirm that the first implementation should reject P0 rather than define a secure-only auth extension to P0.
3. Confirm that document-level OpenAPI scheme binding plus the mandatory `x-apptheory-*` fields is sufficient for the
   first reference adopter's generator; no per-route security override will be accepted.
4. Confirm WebSocket route posture remains a separate follow-up rather than broadening the initial HTTP contract.

## Alternatives considered

### `NewSecure` returning `*App` with a private mode bit

Rejected. It would preserve the posture-optional `App.Get` method set, so omission could only be caught by a
registration-time panic. It would also put `Routes()` on legacy apps or require mode-dependent public method behavior.

### Embedding `*App` in `SecureApp`

Rejected. Promoted legacy registration methods and an exported embedded `App` field are direct bypasses.

### A global `SetAuthPolicy(ClosedByDefault)` option

Rejected. Correctness would depend on mutable configuration and call order, and external consumers would remain
exposed to a future default flip.

### Variadic posture with a registration-time panic

Rejected. A mandatory typed parameter gives Go and TypeScript consumers compile-time enforcement while still
retaining runtime validation for dynamic calls.

### Extensible posture interfaces

Rejected. Arbitrary application posture classes would require downstream generators to understand private policy and
would recreate drift. Application-specific bootstrap conditions belong in the handler/policy layer behind one of the
four route reachability postures.
