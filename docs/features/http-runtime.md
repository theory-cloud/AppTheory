---
title: HTTP Runtime (P0–P2)
description: Tiered middleware, routing, normalization, and the AppTheory error envelope.
---

# HTTP Runtime (P0–P2)

The HTTP runtime is AppTheory's largest contract surface. It defines route matching, the middleware chain, request/response normalization, and the error envelope — and it is enforced identically in all three runtimes by the [128 contract fixtures](../reference/contract-fixtures.md).

The runtime is **tiered.** You opt into a tier when you create the app:

| Runtime | Default | Override |
| --- | --- | --- |
| Go | P2 | `apptheory.New(apptheory.WithTier(apptheory.TierP0))` |
| TypeScript | P2 | `createApp({ tier: TIER_P0 })` |
| Python | P2 | `create_app(tier=TIER_P0)` |

The tier is a contract, not a menu. You do not invent a P1.5. If you need a capability from a higher tier without the full tier, check whether it is already available as a discrete primitive at the lower tier — if not, the right answer is to use the tier that contains it.

## What each tier includes

### P0 — minimal runtime

The smallest viable AppTheory:

- Path matching (literal and `{param}` segments)
- Method dispatch
- Request/response normalization (headers lower-cased, query parsed, body decoded)
- The AppTheory error envelope
- `SourceProvenance` (see [Source Provenance](source-provenance.md)) — available even at P0
- Strict route helpers (`GetStrict`, `handleStrict`, `handle_strict`)

P0 is appropriate for tightly scoped functions that do their own auth, observability, and shedding.

### P1 — production HTTP defaults

P0 plus:

- **Request-id propagation** — `x-request-id` echoed on the response, generated when absent, surfaced on `ctx.RequestID()`.
- **Tenant extraction** — convention-based tenant resolution from headers or the auth identity, available as `ctx.TenantID()`.
- **Auth hooks** — pluggable identity resolvers; `ctx.AuthIdentity()` returns the resolved value or fails closed.
- **CORS** — opt-in preflight handling and response header rewrites.
- **Guardrails** — request size and execution-time caps that fail closed before the handler runs.
- **Middleware ordering** — the framework-defined order. You do not insert "before request-id." If the capability needs to run earlier, the tier model needs a new slot, and adding one is a contract change.

### P2 — observability + load shedding (default)

P1 plus:

- **Observability hooks** — structured request log, span hooks, structured access-log fields. See [Logging Profiles](logging-profiles.md).
- **Rate-limit / load-shed hooks** — `RateLimitMiddleware` integrates with `pkg/limited` (Go) and the equivalents in TypeScript/Python to gate requests against DynamoDB-backed buckets. Credential-derived identifiers (`x-api-key`, `Authorization: Bearer`) are fingerprinted with HMAC-SHA256 before reaching the limiter — raw credentials never land in a rate-limit table.

P2 is what production applications use unless they have a reason not to. The default is P2 because most consumers should not be assembling these pieces from scratch.

## Route registration

```go
app.Get   ("/users/{id}", handler)
app.Post  ("/users",       handler)
app.Put   ("/users/{id}", handler)
app.Patch ("/users/{id}", handler)
app.Delete("/users/{id}", handler)
app.Handle("GET", "/users/{id}", handler)
```

TypeScript: `app.get`, `app.post`, `app.put`, `app.patch`, `app.delete`, `app.handle`.
Python: `app.get`, `app.post`, `app.put`, `app.patch`, `app.delete`, `app.handle` (also usable as decorators).

If two routes are equally specific, the router prefers **earlier registration order**.

### Strict registration

Default registration is compatibility-oriented and may silently ignore invalid patterns. In tests and CI, use the strict helpers:

```go
app.GetStrict("/users/{id}", handler)
app.HandleStrict("GET", "/users/{id}", handler)
```

```ts
app.handleStrict("GET", "/users/{id}", handler);
```

```python
app.handle_strict("GET", "/users/{id}", handler)
```

Strict registration fails immediately on bad patterns instead of silently 404-ing in production.

## Response helpers

```go
apptheory.Text(200, "pong")
apptheory.JSON(200, map[string]any{"ok": true})       // may error on unmarshalable values
apptheory.MustJSON(200, map[string]any{"ok": true})   // panics on unmarshalable values
apptheory.Binary(200, body, "application/octet-stream")
apptheory.SSEResponse(/* … */)
```

TypeScript: `text`, `json`, `html`, `binary`, `sse`.
Python: `text`, `json`, `html`, `binary`, `sse`.

## The error envelope

Default HTTP error responses use a **nested envelope**:

```json
{
  "error": {
    "code": "not_found",
    "message": "User not found",
    "details": { "id": "u_42" }
  },
  "request_id": "req-1"
}
```

To match Lift's flat shape (one-time migration aid only — not for new apps):

```go
app := apptheory.New(apptheory.WithHTTPErrorFormat(apptheory.HTTPErrorFormatFlatLegacy))
```

```ts
const app = createApp({ httpErrorFormat: HTTP_ERROR_FORMAT_FLAT_LEGACY });
```

```python
app = create_app(http_error_format=HTTP_ERROR_FORMAT_FLAT_LEGACY)
```

The flat shape applies to **HTTP only.** AppSync and WebSocket error payloads keep their existing shapes regardless of this setting — those surfaces have their own contracts.

## HTTP entrypoints

You almost never need these directly — use `HandleLambda` / `handleLambda` / `handle_lambda` and let the runtime dispatch. But if your Lambda is single-trigger, the dedicated entrypoints are available:

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| API Gateway v2 (HTTP API) | `ServeAPIGatewayV2` | `serveAPIGatewayV2` | `serve_apigw_v2` |
| Lambda Function URL | `ServeLambdaFunctionURL` | `serveLambdaFunctionURL` | `serve_lambda_function_url` |
| API Gateway v1 (REST proxy) | `ServeAPIGatewayProxy` | `serveAPIGatewayProxy` | `serve_apigw_proxy` |
| ALB target group | `ServeALB` | `serveALB` | `serve_alb` |

## Header canonicalization

`Request.Headers` and `Response.Headers` keys are lower-cased. Look-ups are case-insensitive at the boundary, but if you iterate the map you see the canonical (lower-case) form.

## What's not in scope

- **CSRF protection** — application concern; not in the runtime contract.
- **`Forwarded` / `X-Forwarded-For` trust** — never; see [Source Provenance](source-provenance.md).
- **Retries** — handled by the AWS trigger configuration (DLQs, redrive policies), not by the runtime.

## Next reads

- [Source Provenance](source-provenance.md) — safe HTTP client-IP access
- [Logging Profiles](logging-profiles.md) — P2 observability output shapes
- [Sanitization](sanitization.md) — safe logging helpers
- [Event Workloads](event-workloads.md) — the non-HTTP side of the runtime
- [Contract Fixtures](../reference/contract-fixtures.md) — the 128-fixture covenant
