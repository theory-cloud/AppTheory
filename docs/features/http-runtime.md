---
title: HTTP Runtime (P0–P2)
description: Tiered middleware, routing, normalization, and the AppTheory error envelope.
---

# HTTP Runtime (P0–P2)

The HTTP runtime is AppTheory's largest shared contract surface. It defines route matching, the middleware chain, request/response normalization, and the error envelope — and it is enforced identically in all three runtimes by the shared fixtures. The [274-vector corpus](../reference/contract-fixtures.md) includes 272 generic runner fixtures — including SP09 MCP, SP12 OAuth, and SP13 objectstore across Go, TypeScript, and Python — plus the two Go/CDK-TS MCP route/facade tables. <!-- apptheory-fixture-count: 274 -->

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

The **ALB target group** and **buffered API Gateway REST v1** conversions (and
the WebSocket adapter, which returns the v1 proxy shape) deliver a streaming body
through the same bounded drain as the shapes above: a terminating body becomes the
buffered response, a body over 4 MiB maps to 413, and a body that does not
terminate in time fails closed with the adapter named in the message
(`"...cannot be delivered by the ALB target group adapter"` /
`"...by the API Gateway REST v1 adapter"`). No buffered adapter drops a streaming
body.

When the time budget expires, the adapter does not walk away from the body: it
closes the reader (or the stream) so the producer can unwind and then waits for
the read it gave up on, **unconditionally** — there is no grace window and no
abandoned worker, so no producer goroutine/thread/promise outlives the invocation
that started it. A body that is neither closable nor terminating — a
handler-supplied source blocked inside a call it does not leave — cannot be
interrupted by construction; it is read on the invoking goroutine or waited for
unconditionally, so the Lambda function timeout is what bounds it rather than the
adapter. Every body the runtime itself produces is closable, and every wrapper the
runtime puts around a body forwards close to the body it wraps. See
[Invocation-scoped work](../development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md#invocation-scoped-work-normative).

### The invocation-scope guard

`scripts/verify-invocation-scope.sh` is part of `make rubric`. It runs
`scripts/tools/invocation_scope` over `runtime/`, `pkg/`, `testkit/`, `cmd/`,
`ts/src/` and `py/src/`, and fails on any asynchronous launch whose join the
proof cannot show. `scripts/invocation-scope-baseline.txt` lists exactly the
sites the proof cannot discharge, each with the join that keeps it inside its
invocation; every other launch is discharged by the proof itself, so the baseline
shrinks as the runtime makes a join visible to a parser.

Each language is read with its own parser, never with a text pattern:

- **Go** — `go/ast`. A launch is joined only when a join dominates every exit of
  the function that launched it: a `Wait()` whose `Add` runs before the launch and
  whose goroutine calls `Done`, a `defer <join>` registered before any return and
  reached on every path, a `for range` drain (or, for a close-only goroutine, a
  receive) over an unbuffered channel the goroutine closes as its last action, a
  `Stop()` or channel receive that releases an `AfterFunc`/`NewTimer`/`NewTicker`
  handle on every path, or an errgroup `Wait`. Recognized regardless of an
  aliased `time` import.
- **TypeScript** — the TypeScript compiler API, through
  `scripts/tools/invocation_scope/scan_typescript.mjs`. Each scope (the module,
  every function, every class-field initializer and static block) gets a
  control-flow graph; a launch is joined only when an `await` (or `return`) of the
  held target, or a `clearTimeout`/`clearInterval`/`clearImmediate` of a timer
  handle, dominates every exit. A TypeScript parse diagnostic fails the scan
  rather than being skipped.
- **Python** — the standard-library `ast` module, through
  `scripts/tools/invocation_scope/scan_python.py`, with the same per-scope
  control-flow graph. Threads are joined by `join()`, tasks and offloads by
  `await` (directly or through `gather`/`wait`), and an executor `submit` is
  joined lexically by its own `with` block.

A missing `node` or Python interpreter fails the guard; it never skips a
language, and it never reports an empty (vacuously clean) result. The guard's
self-tests in `scripts/tools/invocation_scope` pin a red case for every shape a
presence- or line-based reading accepts by mistake — a one-line
`if (cond) await p`, a join after an early return, a join inside a nested
uncalled function, a `cancel()` without a wait, a conditional `Stop()`, a
destructuring or array aggregate of promises, a walrus-bound task — and a green
case for every joined form (`try`/`finally`, both branches of an `if`/`else`,
`await Promise.all`/`allSettled`, `defer wg.Wait()`). `main_test.go` holds the Go
proofs and `selftest.go` the two scanner batteries; the battery runs from
`scripts/verify-invocation-scope.sh` because it needs the TypeScript compiler and
a Python interpreter, neither of which the release-gates snapshot (a tracked-tree
copy with no `node_modules`) provides.

Deliberately conservative, and reported rather than assumed joined:

- An exception raised outside a `try` body is not modeled as an exit, mirroring
  the Go proof.
- A `try` whose handlers are not exhaustive keeps a transfer edge to the exit, so
  a join after such a `try` is reported even though a catch-all would have
  discharged it.
- A thread built inside a comprehension is reported even when a later loop starts
  and joins it, because the comprehension hides the handle the guard tracks.
- A join that crosses a scope boundary — into another method, into a callback the
  caller may never call, or into a returned cleanup function — is reported. The
  join may well be real (every remaining baseline entry is of this shape: the Go
  producers joined by another method or by the consumer of a returned value, and
  the TypeScript drain-budget timer armed in a `Promise` executor and cleared in
  the race's `finally`); the proof simply cannot see across the boundary, so the
  site stays in the baseline with its strict join test.
- `unref()` is not a join: it releases the event loop, not the callback.
- A `switch` is modeled without fallthrough, and a promise whose producer is known
  only from its type (not from syntax) is left to
  `@typescript-eslint/no-floating-promises` inside `ts/**`.

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
- [Contract Fixtures](../reference/contract-fixtures.md) — 274 vectors: 272 generic fixtures across Go/TS/Python plus two Go/CDK-TS MCP route/facade tables <!-- apptheory-fixture-count: 274 -->
