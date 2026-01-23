# SR-MOCKS — Local Testkits + AWS Mocks (Go/TS/Py)

Goal: keep AppTheory “generative-coding friendly” and production-ready by providing a strong local testing story in each
language:

- deterministic time/randomness
- event builders / local invocation harness
- strict fakes/mocks for any AWS clients AppTheory wraps
- examples that require zero AWS credentials

## Scope

- Language-specific testkits (public API, documented)
- Deterministic clock/randomness injection points
- Mock/fake implementations for AWS SDK calls AppTheory makes (only for what AppTheory owns)

Non-goals:

- Full-featured local AWS emulation (LocalStack-style) unless it becomes necessary; prefer strict fakes for unit tests and
  DynamoDB Local only when required by integration semantics.

## Current status (AppTheory `v0.2.0-rc.1`)

- Determinism primitives exist (clock + IDs):
  - Go: `Clock` + `IDGenerator` are injectable via app options; `testkit.New()` provides `ManualClock` and
    `ManualIDGenerator`.
  - TS: clock + ID generators are injectable via `new App({ clock, ids })` and used by `ctx.now()` / `ctx.newId()`.
  - Py: clock + ID generators are injectable via `App(clock=..., id_generator=...)` and used by `ctx.now()` /
    `ctx.new_id()`.
- Local invocation and event builders exist per language (no AWS credentials required):
  - Go: `apptheory/testkit` builds synthetic HTTP/WebSocket/SQS/EventBridge/DynamoDB events.
  - TS: event builders are exported from `ts/dist/index.js`.
  - Py: event builders live in `py/src/apptheory/testkit.py`.
- Strict fakes exist for AppTheory-owned AWS clients:
  - Go: WebSocket Management API client fake (`testkit/websockets.go`), SNS fake (`testkit/sns.go`)
  - TS: WebSocket management client strict fake (no AWS SDK dependency)
  - Py: WebSocket management client strict fake (boto3 optional)

## Milestones

### K0 — Inventory AWS touchpoints (what AppTheory wraps)

**Acceptance criteria**
- A list exists of AWS clients AppTheory will wrap directly (if any) per language.
- Anything not wrapped is documented as user-space (and not part of AppTheory’s mocks).

Inventory doc:

- `docs/development/planning/apptheory/supporting/apptheory-aws-touchpoints.md`

---

### K1 — Determinism primitives (clock + randomness)

**Acceptance criteria**
- Each language runtime can inject:
  - a clock/`now()` provider
  - a randomness/ID provider
- Testkits expose helpers to fix time and deterministic IDs.

---

### K2 — Local invocation harness + event builders

**Acceptance criteria**
- Each language exposes helpers to build supported events (starting with HTTP/Lambda URL/APIGWv2).
- Each language supports local invocation without AWS credentials and without network calls.

---

### K3 — Strict fakes/mocks for AWS clients (owned surface)

**Acceptance criteria**
- Each language provides strict, expectation-driven fakes for the AWS clients it wraps.
- Tests can assert:
  - the exact API calls made
  - argument shapes
  - call counts
  - deterministic ordering where relevant

Status (today):

- AppTheory’s HTTP contract slice wraps **no AWS SDK clients** (see
  `docs/development/planning/apptheory/supporting/apptheory-aws-touchpoints.md`), so there are no shipped AWS-client fakes
  yet for HTTP-only behavior.
- Lift parity requires AppTheory-owned AWS clients for:
  - API Gateway Management API (WebSocket message delivery / connection inspection)
  - (potentially) response streaming helpers where the runtime must own a platform integration
  When these are implemented, strict fakes MUST ship in Go/TS/Py and be exercised in contract fixtures.
- For data access, use **TableTheory** (companion framework) and its language-specific test/mocks utilities.

---

### K4 — Documentation + canonical examples

**Acceptance criteria**
- Each language’s docs include a full “unit test without AWS” example using the testkit.
- Examples run in CI without credentials.

---

### K5 — Lift-style test harness parity (handlers + middleware)

**Acceptance criteria**
- Each language provides ergonomic helpers comparable to Lift’s `pkg/testing` patterns:
  - create a request/context for handler tests
  - invoke a handler or route without AWS events
  - (once middleware exists) run middleware chains deterministically in tests
- Docs include “how to test middleware” per language.

Status (today):

- Middleware + `ctx.set/get` are covered in `examples/testkit/ts.mjs` and `examples/testkit/py.py` and documented in
  `ts/README.md` and `py/README.md`.

## Risks and mitigation

- **Mock drift:** keep mocks small and strict; only mock what AppTheory owns.
- **Non-deterministic tests:** make determinism injectable by default; no hidden global time/entropy use in core code.
