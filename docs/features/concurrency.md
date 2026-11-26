---
title: Concurrency and Request Isolation
description: What the Go, TypeScript and Python runtimes keep per request, what they share, and what a handler author must not do.
---

# Concurrency and request isolation

This page states the runtime's concurrency guarantees. It answers one question for a handler author: when several
requests are live in one execution environment at the same time, what does each request own, what does the process
share, and which patterns are outside the contract?

The guarantees hold for every surface — HTTP, AppSync, WebSocket, MCP, and the event workloads — because they are
properties of the context objects and the middleware chain, not of a particular trigger.

## Why this is now a stated guarantee

A classic Lambda invocation handles one event at a time, so an execution environment can serve a second request only
after the first returned. An AWS Lambda [**Web Function**](web-functions.md) removes that: one environment serves many requests at once
(64 concurrently by default, up to 128). Lambda **Managed Instances** remove it for event functions: one environment
processes multiple invocations concurrently instead of sequentially. The runtime therefore cannot rely on "nothing
else is running" for correctness, and this page records the invariant that replaces that assumption.

**Which runtimes get that overlap upstream** is a fact about AWS, not about AppTheory. Lambda Managed Instances lists
Java, Python, Node.js, .NET and Rust (through the OS-only `provided.al2023` runtime); Lambda Web Functions offer
`nodejs24.x`, `nodejs26.x` and `python3.15`. **Go appears in neither list** — see
[Multi-concurrency is not available to Go upstream](#multi-concurrency-is-not-available-to-go-upstream) for what that
means here.

| Runtime | Overlap model in one environment | What "concurrent" means |
|---|---|---|
| Go | None upstream: one invocation at a time per execution environment | Two Go invocations never overlap in one environment, because AWS offers no multi-concurrency runtime for Go. The runtime is written to the single-invocation model and its request state is per call; see [the Go section](#multi-concurrency-is-not-available-to-go-upstream). |
| TypeScript | One event loop, N suspended `async` handler bodies | Two requests are "concurrent" when both handler bodies are suspended at an `await`. A synchronous stretch is never pre-empted. |
| Python | **Lambda Managed Instances**: separate processes, one invocation each. This is the Managed Instances model, not the Web Function one — see [Python specifics](#python-specifics). | Two Python requests are concurrent when they run in different processes, which share no interpreter memory. One process serves one invocation at a time, so a Python handler is never re-entered: the entry point stays a synchronous `def handler(event, context)`, async work runs only behind it through one `asyncio.run` loop created and closed inside that invocation, and no loop-bound state outlives it. See [Python specifics](#python-specifics). |

The two models differ in a way a reader of the runtime's own code must know: in TypeScript a shared mutable is safe
exactly when no `await` sits inside its read-modify-write window, whereas a Python process's shared mutable is safe
exactly when nothing else in the same process can run inside that window. AppTheory does not rely on "one invocation
per process" to make its Python stores correct: they are lock-guarded, and the Python concurrency tests drive them from
several threads on purpose. That is an **analysis method deliberately stronger than the real serving model**, so a
store that is correct only because AWS serializes processes still fails those tests rather than a deployment.

## Per request: never visible to another request

Each request owns its own instance of everything below. Two overlapping requests cannot observe each other's values.

- The request context (`Context` / `EventContext` / `WebSocketContext`, `ctx`) and everything reachable from it: the
  normalized request, path parameters, query, headers, cookies, body, and the source provenance.
- Identity and authorization: the resolved principal, the tenant, the scopes, and the pre-auth `requested_tenant_id`
  view. A failed or refused request never leaves a partially resolved identity behind, because the object is
  discarded with the request.
- Correlation: the request ID (server-issued or client-supplied), the trace ID, and the client request ID.
- Middleware scratch space: `ctx.set(key, value)` / `ctx.get(key)`. Middleware state is request state; a
  value written by an earlier middleware in *this* request's chain is the value this request's handler and later
  middlewares read, and it is dropped when the request ends — including when the handler throws or returns early.
- The response under construction, its headers, its cookies, and any streaming body produced for it.
- The logger binding. `getLogger().withRequestID(...)` (or `with_request_id`) returns a **new** logger that carries the
  binding; it never mutates the process logger. Log lines therefore carry the identity of the request that emitted
  them.
- Middleware chain closures created for the request: the wrapper around each middleware captures only the
  registration-time middleware and the next handler, and the per-request continuation is built per call.
- Guardrail budgets: the request-body size limit, the response-body size limit, the remaining-milliseconds deadline,
  and the timeout middleware's cancellation token.
- The MCP tool invocation context your tool handler receives (`McpToolContext`, with its caller view: session id,
  request id, identity, tenant and scopes). It is built for that call on the ordinary, streaming and task routes alike,
  so a handler never has to copy it and can never observe another call's view.

## Shared: process-wide by design, and safe under overlap

These exist once per execution environment and are shared by every request. Each is either immutable after
construction, keyed only by immutable inputs, or guarded. The [audit](../development/planning/apptheory/supporting/apptheory-runtime-concurrency-audit.md)
names the item and the test that pins it, one row at a time; this page states the guarantees, the audit carries the
evidence.

- **Configuration**: tier, error format, request-ID source, limits, CORS policy, observability hooks, auth hooks, the
  clock, and the ID generator, all fixed when the app is constructed.
- **Compiled routes and middleware lists**: written only by the registration calls (`get`, `post`, `use`, MCP
  `registerTool`), read-only while serving. Route matching allocates fresh parameter maps per call.
- **Warm caches keyed by immutable input**: the JWKS signing-key cache (keyed by `kid`), the OAuth provider's
  validator cache (keyed by issuer/audience/scopes/azp), the front-door parameter cache (keyed by the parameter name
  fixed at construction), the OAuth reference stores (keyed by opaque IDs), the MCP session/stream/task stores (keyed
  by session/stream/task ID), and the micro:vm session registry (keyed by tenant/namespace/session ID).
- **Clients**: the DynamoDB/S3/SSM clients, created once and reused. Creation is guarded so overlapping first requests
  build one client rather than several. The WebSocket management client is the exception: it belongs to
  `WebSocketContext` and is created per socket request, not per environment.
- **The process logger**: the sink installed with `setLogger(...)` / `set_logger(...)`. Install it at initialization.
  Request identity travels on a *derived* logger, never on this instance.
- **The logging profile's retained-entry ring and counters**: process-scoped diagnostics. `entries()`,
  `getStats()`, `isHealthy()` and `close()` describe the environment, not the call — they are not per-request views
  and must not be used to make a per-request decision.

## What a handler author must not do

These are the patterns that break the guarantee. They are not runtime options, so there is no flag to allow them.

1. **Do not stash request state in a module-level variable, a package-level singleton, a class attribute on a
   long-lived object, or a mutable default argument.** A module-scope "current request" is the single most common way
   to leak one request's identity into another. Use `ctx` and the arguments you were handed.
2. **Do not mutate a value you got from a shared cache and hand it back.** Treat cached records as read-only; the
   runtime clones on the way in and out precisely so a caller cannot corrupt the shared entry.
3. **Do not re-install the process logger, or any other process-wide setting, from a handler.** `setLogger`,
   `set_logger`, and equivalent setters belong in initialization code that runs before the first request.
4. **Do not read the logging profile's retained ring or counters to answer a request.** They describe the
   environment and mix every request's lines.
5. **Do not start work that outlives the request.** No detached promise, `setTimeout`, free-threaded task, or
   fire-and-forget coroutine. The invocation-scope rule already forbids it, and under overlap it additionally means
   work runs while unrelated requests are being served.
6. **Do not assume a handler body runs to completion uninterrupted.** Between two `await`s in TypeScript, or between
   two bytecodes in Python, another request can run. Re-read `ctx` rather than caching a derived value across a
   suspension point if another middleware could legitimately change it.

## Python specifics

On AWS Lambda, Python concurrency comes from **separate processes**: Lambda Managed Instances runs each concurrent
request in its own Python process, so two Python invocations in one execution environment share no interpreter memory.
AppTheory's Python entry point stays a synchronous `def handler(event, context)` under that model, and it is the only
entry point. Async runs only **behind** it: when a handler returns an awaitable, the runtime bridges it with one
`asyncio.run` loop, created and closed inside that same invocation. No loop-bound state may outlive an invocation, and
`asyncio.run` raises if an event loop is already running on the calling thread — a named, fail-closed error rather than
a shared loop across invocations.

That model is **Lambda Managed Instances**, and it is the one this section — and AppTheory's Python runtime — is
written against. It is not the model upstream uses for a Python [Web Function](web-functions.md): there, `python3.15`
(public preview) keeps one ASGI event loop, or a WSGI worker-thread pool, per execution environment and Lambda manages
the HTTP server itself. AppTheory refuses a Python Web Function at synthesis, so that model is upstream's, not this
runtime's, and nothing on this page should be read as support for it.

**AppTheory does not serve Python thread-per-request.** No thread pool serves your handler, no thread is created per
request, and `serve()` is never driven from inside a live event loop. The guarantees on this page are stated for the
real serving model — one synchronous invocation per process — and the runtime adds nothing to it.

The process-wide members listed above that fill lazily on the request path (the JWKS validator's key cache, resolution
windows and fetch budget; the Autheory discovery document and validator cache; the front-door SSM client; the MCP
stream spill object store; the MCP session/stream/task stores) are still guarded by a lock. That is deliberate defence
in depth, not a serving model: the Python concurrency tests drive those stores from several threads at once, an
analysis method stronger than what AWS runs, so a store that is only safe because one invocation holds the process
fails a test here instead of a deployment.

## TypeScript specifics

Node runs one thread, so the runtime's first obligation is the absence of a yield point: a shared store's
read-modify-write must complete without an `await` in the middle. The concurrency tests interleave every handler body at
an explicit barrier and assert that no request observes another's context, identity, headers, response state or logger
binding. If a future change introduces an `await` inside a critical section, the interleaved tests fail rather than a
deployed Web Function.

The second obligation is that a cache being filled is joined, not refused. When one request starts filling a shared
cache (a cold JWKS key set, a discovery document, a lazily created client), every request that arrives during the fill
waits for that fill and then reads the result; it must not fail a valid request because an unrelated request is still
in flight. The cold-cache tests hold a burst of valid tokens against one cold cache and require all of them to be
authorized.

That obligation follows the *whole* fill, not one step of it. A shared cache whose fill is a single operation is joined
by that operation. The JWKS validator is the case with two steps: when the first key-set document does not carry the
token's `kid`, the validator may refresh once more to absorb key publication lag, so a request that arrives during the
resolution follows the opening request through that permitted retry and reaches the same outcome it reaches — accepted
when the key is published, refused when it is not. It never starts a fetch of its own, never spends a second unit of the
unknown-`kid` fetch budget, and is still bounded by the same fetch timeout, per-`kid` bound, cooldown and budget.

Following the *request*, not the fetch, is the precise obligation, and the two differ when a `kid`'s resolution begins
behind another one's. If the opening request's first step joined a fill that a different `kid` started, its own permitted
retry cannot begin until that fill clears; a follower that watched only the fill would find nothing in flight in
between and refuse a token whose key the same resolution is about to publish. The runtime therefore tracks each `kid`'s
resolution as one window that ends when that whole resolution ends — success, refusal or error — and a follower waits
for the window it was admitted to.

A settled window is not always the end of the wait either. A `kid` that missed stays inside its refresh cooldown, and
the rotation that carries it can arrive through a fill another `kid` opened a moment later — the ordinary shape of a
key rollover, where the request that misses the new key and the request that triggers the new key set are different
users. When the followed window ends without the key and a fill is already running, the follower follows that fill too,
under the same deadline: it still starts no fetch and spends no budget unit, it follows at most the `maxRefreshPerKid +
1` fills one resolution may consist of, and a fill that does not publish the `kid` still ends in `unknown_kid`.

## Multi-concurrency is not available to Go upstream

AWS decides this, not AppTheory. The
[Lambda Managed Instances runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-runtimes.html)
page lists Java 21+, Python 3.13+, Node.js 22+, .NET 8+ and Rust (through the OS-only `provided.al2023` runtime).
**Go is not listed**, and the Lambda Web Function runtimes are `nodejs24.x`, `nodejs26.x` and `python3.15` — there is no
Go Web Function runtime either. So:

- **AppTheory's Go runtime serves one invocation at a time per execution environment.** That is the upstream execution
  model for Go on Lambda, and the Go runtime is written to it: request state lives in the call's `context.Context`, and
  the framework adds no in-process concurrency of its own.
- **Multi-concurrency for Go is not supported upstream**, so AppTheory cannot offer it without shipping a runtime AWS
  does not maintain. It does not: AppTheory deploys managed runtimes only, and adding a custom runtime image or runtime
  layer to work around an upstream gap is not a direction this framework takes.
- **Parity is preserved wherever upstream allows it.** Nothing in the Go API is weakened or marked unsupported for the
  features that a single-concurrency environment serves: routing, the middleware tiers, the error envelope, event
  normalization, the CDK constructs, the contract fixtures and the API snapshots are the same in Go as in TypeScript
  and Python, and every fixture runs in all three runtimes on every commit. Only the *overlap* dimension is missing, and
  it is missing because AWS does not offer it for Go.
- One recorded consequence is the JWKS validator. Its Go implementation refuses a request whose signing-key resolution
  window another request opened, where TypeScript and Python serve the peer (`runtime/oauth/jwks.go`); the audit records
  it as a residual tied to this upstream gap rather than as a parity defect. If AWS adds Go to Lambda Managed Instances,
  that behaviour becomes required parity work: the resolution window has to be published across the whole permitted
  retry loop, which is a redesign of the JWKS refresh state machine, and this page's Go row changes with it.

## Where this is proven

- `py/tests/test_concurrency_isolation.py` — overlapping HTTP requests through the real pipeline (including the
  failure and early-return paths), plus every shared store, cache and lazy client under overlap.
- `ts/test/concurrency-isolation.test.mjs` — the same interleavings on the Node event loop.
- The audit behind this page, with the item-by-item classification and file references:
  [Runtime concurrency audit](../development/planning/apptheory/supporting/apptheory-runtime-concurrency-audit.md).
