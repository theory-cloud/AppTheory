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
after the first returned. An AWS Lambda **Web Function** removes that: one environment serves many requests at once
(64 concurrently by default, up to 128). The runtime therefore cannot rely on "nothing else is running" for
correctness, and this page records the invariant that replaces that assumption.

| Runtime | Overlap model in one environment | What "concurrent" means |
|---|---|---|
| Go | One goroutine per request | Addressed by `context.Context`; Go is out of scope for the Web Function wiring (AWS has no Go Web Function runtime) and unchanged by this note. |
| TypeScript | One event loop, N suspended `async` handler bodies | Two requests are "concurrent" when both handler bodies are suspended at an `await`. A synchronous stretch is never pre-empted. |
| Python | Threads, one per request | Two requests are concurrent when two threads run at once. The runtime's entry points are synchronous; the runtime does **not** support asyncio-task concurrency (see [Python specifics](#python-specifics)). |

The two non-Go models differ in a way that matters when you read the runtime's own code: in TypeScript a shared
mutable is safe exactly when no `await` sits inside its read-modify-write window, whereas in Python it needs an actual
lock, because the interpreter can switch threads at any call boundary.

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

The Python runtime's entry points are synchronous. When a handler returns an awaitable, the runtime bridges it with
`asyncio.run`, which raises if an event loop is already running on the calling thread. That is the documented,
fail-closed behaviour: a Python AppTheory app is served by a thread-per-request server, never by an asyncio server
driving `serve()` from inside a live loop. Concurrency in one Python environment therefore means threads, and the
guarantees above are stated for that model.

The process-wide members listed above that fill lazily on the request path (the JWKS validator's key cache, windows
and fetch budget; the Autheory discovery document and validator cache; the front-door SSM client; the MCP stream
spill object store; the MCP session/stream/task stores) are guarded by a lock, because Python can switch threads
inside them.

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

## Where this is proven

- `py/tests/test_concurrency_isolation.py` — overlapping HTTP requests through the real pipeline (including the
  failure and early-return paths), plus every shared store, cache and lazy client under overlap.
- `ts/test/concurrency-isolation.test.mjs` — the same interleavings on the Node event loop.
- The audit behind this page, with the item-by-item classification and file references:
  [Runtime concurrency audit](../development/planning/apptheory/supporting/apptheory-runtime-concurrency-audit.md).
