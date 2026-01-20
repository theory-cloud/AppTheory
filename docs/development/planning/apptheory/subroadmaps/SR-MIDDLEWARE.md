# SR-MIDDLEWARE — Middleware + Context Extensibility (Lift Parity, Go/TS/Py)

Goal: AppTheory must provide a **Lift-grade middleware pipeline** (and improve on it) without breaking multi-language
parity.

Lift parity requirements (used by Autheory/K3/Lesser):

- Global middleware registration (`app.Use(...)`)
- Middleware ordering and predictable behavior under errors/panics
- Request-scoped context mutation (`ctx.Set(...)` / `ctx.Get(...)`) to share state across middleware + handlers
- A story for “global middleware” on non-HTTP triggers (events / websockets), without surprise behavior

## Scope

- Portable middleware pipeline API in Go/TS/Py (idiomatic per language, equivalent capabilities)
- Context “value bag” API (Set/Get) in Go/TS/Py
- Built-in middleware set for Lift parity (at least: RequestID, Recover, Logger, CORS, Timeout)
- Contract fixtures for ordering + error behavior (portable subset)
- Testkit support for unit-testing middleware chains (no AWS required)

Non-goals:

- Port every Lift middleware and every Lift integration wholesale in the first pass; prioritize what Autheory/K3/Lesser
  actually use, then iterate.

## Design requirements

- **Explicit ordering:** middleware ordering must be deterministic and documented.
- **Portable subset:** the middleware pipeline behavior must be fixture-tested where it affects externally observable
  runtime behavior (status codes, headers, error envelope).
- **No hidden globals:** middleware must not depend on global mutable state (multi-language determinism requirement).
- **Events story:** middleware should apply to:
  - HTTP requests (default)
  - WebSockets (default)
  - non-HTTP event triggers (opt-in; explicit mechanism)

## Current status (AppTheory `v0.2.0-rc.1`)

- Global middleware pipeline exists:
  - Go: `app.Use(mw)` where `mw` wraps an `apptheory.Handler`
  - TS: `app.use(mw)` where `mw(ctx, next)` can be async
  - Py: `app.use(mw)` where `mw(ctx, next)` is sync
- Context value bag exists (portable `Set`/`Get`):
  - Go: `ctx.Set(key, value)` / `ctx.Get(key)`
  - TS: `ctx.set(key, value)` / `ctx.get(key)`
  - Py: `ctx.set(key, value)` / `ctx.get(key, default=None)`
- Middleware applies to HTTP + WebSocket handlers; non-HTTP event trigger middleware remains an explicit follow-on.
- Contract fixture coverage exists for middleware + ctx bag: `contract-tests/fixtures/m12/middleware-ctx-bag.json`.

## Milestones

### MW0 — API design + contract decisions (portable boundary)

**Acceptance criteria**
- Go/TS/Py each has an idiomatic middleware API with equivalent capabilities.
- A written “portable middleware semantics” section exists (as an extension to
  `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md` or a v1 contract doc):
  - ordering rules
  - what happens on middleware errors
  - what happens on panics/exceptions
  - how request-id propagation behaves under failures
- A decision exists for non-HTTP triggers:
  - “default middleware applies to events” vs “explicit opt-in”
  - how “global middleware” is expressed portably

---

### MW1 — Context value bag (`Set`/`Get`) (portable)

**Acceptance criteria**
- Go: `(*Context).Set(key string, value any)` and `(*Context).Get(key string) any` (or equivalent).
- TS: `ctx.set(key, value)` / `ctx.get(key)` (or equivalent).
- Py: `ctx.set(key, value)` / `ctx.get(key)` (or equivalent).
- Unit tests prove values survive middleware layers and reach handlers.

---

### MW2 — Core middleware pipeline (portable)

**Acceptance criteria**
- Go/TS/Py support global middleware registration that wraps all handlers.
- Middleware can be stacked and behaves deterministically.
- Contract fixtures prove ordering and error behavior (portable subset).

---

### MW3 — Built-in middleware parity (Lift-required subset)

**Acceptance criteria**
- AppTheory ships a built-in middleware set that covers Lift usage in Autheory/K3/Lesser:
  - request-id middleware (generation + propagation)
  - recover/panic middleware (safe `app.internal`)
  - logger middleware (portable hook integration + optional Go-only logger)
  - CORS middleware with allow-list behavior (beyond “echo Origin”)
  - timeout middleware (portable semantics; integrates with `remaining_ms`)
- Migration guide maps Lift middleware to AppTheory equivalents.

---

### MW4 — Event triggers + “global middleware” parity

**Acceptance criteria**
- Middleware story is explicit and tested for:
  - SQS
  - EventBridge
  - DynamoDB Streams
  - WebSockets
- AppTheory supports a Lift-equivalent mechanism to apply select middleware to event triggers (or a better replacement),
  without surprising users.

---

### MW5 — Test harness parity (unit tests without AWS)

**Acceptance criteria**
- Testkits include helpers to unit test middleware and handlers without AWS events (HTTP request/context builders).
- Examples exist per language and run in CI.

## Risks and mitigation

- **Portability mismatch:** keep the portable subset small and fixture-backed; allow Go-only extensions explicitly.
- **API churn:** design MW0 carefully; middleware API is hard to change once adopted.
- **Overreach:** start with what Autheory/K3/Lesser use; expand only when a real app proves the need.
