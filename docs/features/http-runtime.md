---
title: HTTP Runtime (P0–P2)
description: Tiered middleware, routing, normalization, and the AppTheory error envelope.
---

# HTTP Runtime (P0–P2)

The HTTP runtime is AppTheory's largest shared contract surface. It defines route matching, the middleware chain, request/response normalization, and the error envelope — and it is enforced identically in all three runtimes by the shared fixtures. The [272-vector corpus](../reference/contract-fixtures.md) includes 270 generic runner fixtures — including SP09 MCP, SP12 OAuth, and SP13 objectstore across Go, TypeScript, and Python — plus the two Go/CDK-TS MCP route/facade tables. <!-- apptheory-fixture-count: 273 -->

The runtime is **tiered.** You opt into a tier when you create the app:

| Runtime | Default | Override |
| --- | --- | --- |
| Go | P2 | `apptheory.New(apptheory.WithTier(apptheory.TierP0))` |
| TypeScript | P2 | `createApp({ tier: "p0" })` |
| Python | P2 | `create_app(tier="p0")` |

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

- **Request-id propagation** — `x-request-id` echoed on the response, generated when absent, and surfaced on the runtime context (`ctx.RequestID` in Go, `ctx.requestId` in TypeScript, `ctx.request_id` in Python).
- **Tenant extraction** — convention-based tenant resolution from headers or the auth identity, available on the runtime context (`TenantID` / `tenantId` / `tenant_id`).
- **Auth hooks** — pluggable identity resolvers; the resolved identity is exposed on the runtime context (`AuthIdentity` / `authIdentity` / `auth_identity`) or the request fails closed.
- **CORS** — opt-in preflight handling and response header rewrites.
- **Guardrails** — request size and execution-time caps that fail closed before the handler runs.
- **Middleware ordering** — the framework-defined order. You do not insert "before request-id." If the capability needs to run earlier, the tier model needs a new slot, and adding one is a contract change.

### P2 — observability + load shedding (default)

P1 plus:

- **Observability hooks** — one request log record, one metric record, and one span-shaped record per completed HTTP
  request, including `duration_ms` and inbound trace IDs extracted from `traceparent` or `X-Amzn-Trace-Id`. See
  [Observability Hooks](observability.md) and [Logging Profiles](logging-profiles.md).
- **Rate-limit / load-shed hooks** — the shared P2 contract pins the portable policy-hook outcome: a rejected request returns `app.rate_limited`, `429`, and `Retry-After` while still flowing through observability. Go additionally exports `RateLimitMiddleware`, which integrates with `pkg/limited` and fingerprints default credential-derived identifiers (`x-api-key`, `Authorization: Bearer`) with HMAC-SHA256 before they reach the limiter. TypeScript and Python expose policy hooks plus limiter primitives, but they do not currently ship a `RateLimitMiddleware` equivalent.

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

### Fail-closed registration

Default fluent registration fails closed for invalid patterns, duplicate canonical method/pattern pairs, and nil,
undefined, or `None` handlers. Misconfigured applications that older v1 lines could silently ignore now fail during
startup or test setup instead of drifting into unexpected runtime 404s. Use the normal registration path in new code:

```go
app.Get("/users/{id}", handler)
app.Handle("GET", "/users/{id}", handler)
```

```ts
app.get("/users/{id}", handler);
app.handle("GET", "/users/{id}", handler);
```

```python
app.get("/users/{id}", handler)
app.handle("GET", "/users/{id}", handler)
```

The strict helpers remain only as deprecated compatibility wrappers for code that depends on their older
error-returning or throwing shape. Their failures use the canonical AppTheory error path: Python strict helpers raise
`AppTheoryError`, and Go strict helpers return canonical `AppTheoryError` messages where applicable.

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

The default nested envelope remaps any error whose code string is `EMPTY_BODY` or `INVALID_JSON` to canonical
`app.bad_request` fields. The flat legacy HTTP format preserves those Lift-era codes/messages as a migration bridge.
The flat shape applies to **HTTP only.** AppSync and WebSocket error payloads keep their existing shapes regardless of
this setting — those surfaces have their own contracts.

## HTTP entrypoints

You almost never need these directly — use `HandleLambda` / `handleLambda` / `handle_lambda` and let the runtime dispatch. But if your Lambda is single-trigger, the dedicated entrypoints are available:

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| API Gateway v2 (HTTP API) | `ServeAPIGatewayV2` | `serveAPIGatewayV2` | `serve_apigw_v2` |
| Lambda Function URL | `ServeLambdaFunctionURL` | `serveLambdaFunctionURL` | `serve_lambda_function_url` |
| API Gateway v1 (REST proxy) | `ServeAPIGatewayProxy` | `serveAPIGatewayProxy` | `serve_apigw_proxy` |
| ALB target group | `ServeALB` | `serveALB` | `serve_alb` |

## Streaming responses through buffered adapters

HTTP API v2 (payload format 2.0) and the buffered Lambda Function URL path deliver
buffered responses only — they cannot stream incrementally. The adapters therefore
drain a streaming response body (`BodyReader`/`BodyStream`/`bodyStream`/`body_stream`)
into the buffered body with a bounded budget instead of silently dropping it:

- a **terminating stream** is drained and delivered as the buffered response body
  (bounded to 4 MiB / 5 seconds; the byte budget and time budget are identical in
  all three runtimes);
- a stream that does **not terminate within the budget** (a live session listener,
  an open replay) or a stream that **errors** fails closed with HTTP 500 and the
  nested AppTheory error body:
  `{"error":{"code":"app.internal","message":"streaming response body cannot be delivered by the HTTP API v2 adapter"}}`
  (the Function URL adapter names itself: `"...cannot be delivered by the Function URL adapter"`);
- a stream whose total length **exceeds 4 MiB** maps to HTTP 413 payload too large
  with the framework's size error body: `{"error":{"code":"app.too_large","message":"response too large"}}`,
  matching the `MaxResponseBytes` size semantics used elsewhere in the runtime;
- a stream that closes empty only because the deadline fired fails closed as well,
  so the empty-`200` reconnect loop cannot reappear at the deadline boundary.

No adapter performs an unbounded read, and none of the budgets are configurable:
a handler that wants true incremental SSE must use a response-streaming adapter
(API Gateway REST v1, or the Lambda Function URL streaming handler), not HTTP API v2.

## Header canonicalization

`Request.Headers` and `Response.Headers` keys are lower-cased. Look-ups are case-insensitive at the boundary, but if you iterate the map you see the canonical (lower-case) form.

## What's not in scope

- **CSRF protection** — application concern; not in the runtime contract.
- **`Forwarded` / `X-Forwarded-For` trust** — never; see [Source Provenance](source-provenance.md).
- **Retries** — handled by the AWS trigger configuration (DLQs, redrive policies), not by the runtime.

## Next reads

- [Source Provenance](source-provenance.md) — safe HTTP client-IP access
- [Observability Hooks](observability.md) — P2 duration, trace extraction, span/log records, and EMF sink boundaries
- [Logging Profiles](logging-profiles.md) — profile-backed structured JSON log output
- [Sanitization](sanitization.md) — safe logging helpers
- [Event Workloads](event-workloads.md) — the non-HTTP side of the runtime
- [Contract Fixtures](../reference/contract-fixtures.md) — 273 vectors: 271 generic fixtures across Go/TS/Python plus two Go/CDK-TS MCP route/facade tables <!-- apptheory-fixture-count: 273 -->
