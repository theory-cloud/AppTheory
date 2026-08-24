---
title: SecureApp Closed-Default Routing
---

# SecureApp Closed-Default Routing

`SecureApp` is AppTheory's closed-by-default application surface for HTTP, AppSync, and API Gateway WebSocket routes.
Every routable operation must declare exactly one authorization posture at registration, and AppTheory enforces that
posture before user middleware or the handler. Applications that continue to use the legacy `App` surface keep their
existing open-by-omission behavior.

Install AppTheory from a pinned immutable [GitHub Release](https://github.com/theory-cloud/AppTheory/releases); the
project does not publish the runtime to npm or PyPI.

## Create a secure app

Secure construction accepts a closed option value. It does not accept legacy option callbacks or expose the private
`App` core.

```go
app := apptheory.NewSecure(apptheory.SecureOptions{
    Tier:              apptheory.TierP2,
    PrincipalResolver: resolvePrincipal,
})
```

```ts
const app = new SecureApp({
  tier: "p2",
  principalResolver: resolvePrincipal,
});
```

```py
app = SecureApp(tier="p2", principal_resolver=resolve_principal)
```

An omitted tier selects P2. P0, P1, and P2 are supported; any unknown tier fails construction. TypeScript rejects
unknown option keys and invalid dynamic values. Python uses explicit keyword parameters, so unknown keys raise
`TypeError`. Go accepts only `SecureOptions`, not `Option func(*App)`.

## Authorization postures

| Posture | Resolver behavior | Missing principal | Valid principal |
| --- | --- | --- | --- |
| `Public()` / `public()` | Resolver is not called | Continue anonymously | Principal context is not enriched |
| `Optional()` / `optional()` | Resolver is called | Continue only for nil or a known-kind empty identity | Attach normalized principal |
| `Authenticated(scopes...)` / `authenticated(*scopes)` | Resolver is called | `401 app.unauthorized` | Require identity and every normalized scope |
| `AuthenticatedAnyOf(scopes...)` / `authenticated_any_of(*scopes)` | Resolver is called | `401 app.unauthorized` | Require identity and at least one normalized scope |
| `InternalOnly()` / `internal_only()` | Resolver is called | `401 app.unauthorized` | Require `kind == internal`; external is 403 |

TypeScript uses `Public`, `Optional`, `Authenticated`, `AuthenticatedAnyOf`, and `InternalOnly`. Python uses the
lower-case equivalents. Scope normalization trims values, removes empty entries and duplicates, and preserves first
occurrence. Supplying only scopes that normalize empty fails registration; `AuthenticatedAnyOf` also rejects an
omitted scope list. `Authenticated` remains all-of. `AuthenticatedAnyOf` is any-of: a valid identity missing every
registered scope receives the same `403 app.forbidden` envelope as the all-of path.

Use the any-of posture for established scope aliases. For example, a Mastodon-compatible timeline may accept either
the specific `read:statuses` scope or the broader `read` scope without moving authorization into the handler:

```go
app.Get("/api/v1/timelines/home", timelineHandler,
    apptheory.AuthenticatedAnyOf("read:statuses", "read"))
```

TypeScript uses `AuthenticatedAnyOf("read:statuses", "read")`; Python uses
`authenticated_any_of("read:statuses", "read")`.

Resolvers return `SecurePrincipal` values with `identity`, `scopes`, `claims`, and `kind`. Empty kind normalizes to
`external` for legacy-hook migration. The only recognized non-empty kinds are `external` and `internal`. Unknown kinds
always fail with 401, including under `Optional`; optional authentication never downgrades an invalid credential to
anonymous access.

```go
func resolvePrincipal(ctx *apptheory.Context) (*apptheory.SecurePrincipal, error) {
    // Verify the application credential before classifying the principal.
    return &apptheory.SecurePrincipal{
        Identity: "user-123",
        Kind:     apptheory.PrincipalExternal,
        Scopes:   []string{"notes:read"},
        Claims:   map[string]any{"issuer": "example"},
    }, nil
}
```

Handlers read the result through `ctx.SecurePrincipal()`, `ctx.securePrincipal()`, or `ctx.secure_principal()`.
Every call returns a new deep copy. Mutating it cannot change gate state, later dispatch, or another accessor result.

## Denial response headers

A `SecurePrincipalResolver` denial rendered through the portable error path can carry a bounded caller-supplied
response header set on the resulting 401/403. Return `AppTheoryError` with `Headers` (Go), `headers` (TypeScript), or
`headers` (Python) set, and the error renderer merges the canonicalized headers into the response. The driving case is
MCP OAuth discovery: a protected resource must challenge the client with
`WWW-Authenticate: Bearer resource_metadata="..."` (MCP spec 2025-06-18, RFC 9728) on a 401.

```go
return nil, apptheory.NewAppTheoryError("app.unauthorized", "unauthorized").
    WithHeaders(map[string][]string{
        "WWW-Authenticate": {oauth.ProtectedResourceWWWAuthenticate(metaURL)},
    })
```

```ts
throw new AppTheoryError("app.unauthorized", "unauthorized").withHeaders({
  "WWW-Authenticate": [`Bearer resource_metadata="${metaURL}"`],
});
```

```py
raise AppTheoryError("app.unauthorized", "unauthorized").with_headers(
    {"WWW-Authenticate": [f'Bearer resource_metadata="{meta_url}"']}
)
```

The default denial vocabulary is unchanged. The 401/403 status is still derived from the error code
(`app.unauthorized` → 401, `app.forbidden` → 403), and a denial without `Headers` renders byte-identical to previous
releases: the same `{"error": {...}}` envelope, `content-type`, and request-id headers, with no `WWW-Authenticate`.
Header names are canonicalized to lowercase through the existing header pipeline, and the error renderer continues to
own `content-type`. Denials synthesized by the gate itself (missing principal, unknown kind, missing scope) never
carry headers; only the resolver's own returned error can attach them, keeping the closed surface explicit.

## Register routes

Posture is a mandatory, non-variadic argument on HTTP, AppSync, and WebSocket registrations.

```go
app.Get("/public", publicHandler, apptheory.Public())
app.Get("/notes/{id}", noteHandler, apptheory.Optional())
app.Post("/exports", exportHandler, apptheory.Authenticated("exports:write"))
app.Get("/api/v1/timelines/home", timelineHandler, apptheory.AuthenticatedAnyOf("read:statuses", "read"))
app.Post("/internal/deliver", deliverHandler, apptheory.InternalOnly())
app.AppSyncField("Query", "note", noteHandler, apptheory.Authenticated("notes:read"))
app.WebSocket("$connect", connectHandler, apptheory.Optional())
app.WebSocket("sendMessage", messageHandler, apptheory.Authenticated("messages:write"))
app.WebSocket("$disconnect", disconnectHandler, apptheory.Public())
```

The TypeScript methods are `get`, `post`, `appSyncField`, and `webSocket`; Python uses `get`, `post`,
`appsync_field`, and `websocket`. The facade does not forward legacy posture-less registrations or deprecated strict
variants. Non-HTTP event registrations such as SQS, SNS, Kinesis, EventBridge, and DynamoDB Streams are forwarded
unchanged because they are separate, non-posture-bearing registries.

## Fixed ordering by tier

The secure gate is a framework stage, not a user middleware. `Use` cannot remove, replace, or run before it.

P1 and P2 HTTP/AppSync requests use this order:

1. establish canonical headers and portable request state;
2. return uniform CORS preflight before route lookup when applicable;
3. normalize the request and context;
4. match the route on its HTTP or AppSync surface;
5. prove posture metadata is present;
6. run the P2 policy hook when configured;
7. resolve and enforce the secure posture;
8. run user middleware in registration order;
9. run the handler and existing response finalization.

P0 is a deliberate secure-only extension. It retains P0 normalization, context, middleware, handler, and response
projection while inserting only posture-presence and posture-gate stages before user middleware. It does not import
request IDs, CORS, size limits, policy hooks, observability, or other P1/P2 stages. Legacy P0 behavior does not change.

For P1/P2, every syntactically recognized CORS preflight returns the existing uniform 204 response before route or
principal resolution. Public, authenticated, internal, and unknown paths are indistinguishable. Secure P0 has no
preflight shortcut and routes `OPTIONS` normally.

A matched secure record without posture metadata is an invariant failure: AppTheory returns `500 app.internal`
without invoking the resolver, user middleware, or handler.

## AppSync identity

`AppSyncField` trims and requires the parent type and field. Query and Subscription map to `GET /field`; other parent
types map to `POST /field`. AppSync routes are tagged `appsync`, and HTTP adapters cannot match them.

AppTheory does not trust AppSync identity automatically. The resolver must read the already-populated
`ctx.AsAppSync().Identity`, `ctx.asAppSync().identity`, or `ctx.as_appsync().identity`, validate it, and return a
classified principal. It must not fall back to an HTTP authorization header for an AppSync route.

## WebSocket connection principals

Each WebSocket key declares its own posture, including `$connect`, `$default`, custom keys, and `$disconnect`.
Posture is checked on every invocation before user middleware.

At `$connect`, the resolver can validate handshake headers/query and the trusted WebSocket context. After a successful
gate, the connect handler may store the normalized principal in an application-owned server-side store keyed by
connection ID. For messages and disconnects, the same resolver must load and revalidate that trusted record by
`ConnectionID`. Do not trust identity or scopes in the frame body, and do not use warm Lambda memory as the
connection store. Missing or revoked state fails authenticated/internal routes with 401.

`webSocketSupport: true` / `websocket_support=True` / `WebSocketSupport: true` enables Lambda WebSocket recognition
before a key is registered. Registering a secure key also enables it. An enabled dispatcher with no matching key
returns the existing tier-specific 404.

## Route inventory

`Routes()` / `routes()` returns a fresh registration-order snapshot. Each record carries `surface`, canonical HTTP
method/path, posture, normalized scopes, and surface-specific AppSync or WebSocket metadata. It never exposes
handlers. Mutating the returned records or scopes cannot affect enforcement or later snapshots.

The inventory includes HTTP, AppSync, and WebSocket routes. It excludes synthetic preflight behavior and non-router
event sources.

## Secure OpenAPI

Generate secure OpenAPI through the app-bound method, never the legacy free function:

```go
document, err := app.GenerateOpenAPI(apptheory.SecureOpenAPISpec{
    Title:   "Notes API",
    Version: "1.0.0",
    SecuritySchemes: map[string]map[string]any{
        "BearerAuth": {"type": "http", "scheme": "bearer"},
        "ServiceAuth": {"type": "apiKey", "in": "header", "name": "x-service-key"},
    },
    AuthSchemes: apptheory.OpenAPIAuthSchemes{
        Authenticated: []string{"BearerAuth"},
        InternalOnly:  []string{"ServiceAuth"},
    },
    Routes: descriptions,
})
```

TypeScript uses `app.generateOpenAPI(spec)` with `securitySchemes` and `authSchemes`; Python uses
`app.generate_openapi(spec)` with `security_schemes` and `auth_schemes`.

Generation exact-joins the description table to the HTTP projection of `routes()` by canonical method/path. Missing,
extra, duplicate, or colliding descriptions fail. AppSync and WebSocket routes are structurally excluded. Posture is
read only from the registered route record; per-route security overrides and ignore lists do not exist.

Every document emits `x-apptheory-contract-mode: secure-v1`; every operation emits
`x-apptheory-auth-posture`, and scoped routes emit `x-apptheory-required-scopes`. Final proxy routes such as
`/files/{path+}` emit as `/files/{path}` with a required path parameter and `x-apptheory-proxy: true`.
`Authenticated` emits all required scopes in each configured authenticated security requirement.
`AuthenticatedAnyOf` emits one security requirement per scheme/scope pair, preserving OpenAPI's OR semantics.
Security-scheme values are recursively copied and accept only null, booleans, strings, arrays, and string-keyed
objects. Numbers, undefined/sentinel values, cycles, and runtime-specific objects fail closed. Canonical secure JSON
is byte-stable across Go, TypeScript, and Python.

## Next step

For an existing application, follow the [SecureApp migration procedure](../migration/secure-app.md). Do not remove an
application-owned default-deny guard until route inventory, runtime authorization, and secure OpenAPI parity all pass.
