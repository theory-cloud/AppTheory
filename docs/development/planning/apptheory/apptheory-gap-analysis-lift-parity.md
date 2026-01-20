# AppTheory Lift-Parity Gap Analysis (Pay Theory: Autheory + K3, plus Lesser)

Goal: AppTheory is a **complete Lift replacement** (Go) and a **robust improvement** on Lift with **first-class**
TypeScript + Python support and **TableTheory-style distribution** (GitHub Releases only).

Non-negotiable: if a capability exists in Lift and is used by Pay Theory (Autheory/K3) or Lesser, AppTheory must
implement it (portable across Go/TS/Py where feasible; Go-only only when truly non-portable and explicitly documented).

## Status snapshot (current repo state)

- Repo: `AppTheory/`
- Branch: `premain`
- Release candidate: `v0.2.0-rc.1` (tagged)
- Version alignment:
  - `AppTheory/VERSION` = `0.2.0-rc.1`
  - `AppTheory/ts/package.json` = `0.2.0-rc.1`
  - `AppTheory/cdk/package.json` = `0.2.0-rc.1`
  - `AppTheory/py/pyproject.toml` = `0.2.0-rc.1`
- Quality gates:
  - `make rubric`: PASS
  - Contract fixtures exist for P0/P1/P2 + Lift parity extensions (`m1`/`m2`/`m3`) and run in Go/TS/Py.

## What `make rubric` passing actually means

`make rubric` runs `scripts/verify-rubric.sh`, which verifies (at minimum):

- Single-version alignment across Go/TS/Py/CDK
- Go formatting + Go lint (`golangci-lint` via `.golangci-v2.yml`)
- TS lint + packaging (`npm pack`)
- Python lint + packaging (wheel + sdist)
- CDK constructs build/tests + jsii packaging + synth drift gate
- Cross-language contract tests (fixtures) in Go/TS/Py
- Testkit examples run (TS + Py)

This is AppTheory’s equivalent of “release-ready”: if the rubric passes at a tag, GitHub Releases can safely attach the
artifacts without registry tokens.

## Lift parity coverage: what is already implemented

These are the Lift runtime surfaces that are now present in AppTheory (Go/TS/Py), with fixture coverage:

- **Single Lambda router**: `HandleLambda` routes:
  - API Gateway v2 (HTTP API)
  - Lambda Function URLs
  - API Gateway REST API v1 (Lambda proxy)
  - SQS
  - EventBridge
  - DynamoDB Streams
  - API Gateway v2 WebSockets
- **API Gateway REST API v1 adapter**, including SSE-compatible streaming response behavior for `text/event-stream`.
- **SSE helpers** (`SSEEvent`, `SSEResponse`) (current design is buffered framing; see “Remaining gaps” for “true stream”).
- **WebSockets** routing (`$connect/$disconnect/$default`), `ctx.AsWebSocket()`, and a WebSocket management client
  (`PostToConnection`, `GetConnection`, `DeleteConnection`) plus strict fakes in testkits.
- **Event sources**:
  - SQS partial batch failures
  - DynamoDB Streams partial batch failures
  - EventBridge routing (rule-name or pattern)
- **CDK parity for Lift parity extensions** (deploy story for these triggers):
  - REST API v1 + method-level streaming toggle
  - EventBridge handler wiring
  - DynamoDB Streams event source mappings
  - SQS queue processor wiring

## The key “robust improvement on Lift” constraint

Lift parity is only the baseline. AppTheory must improve on Lift by being:

- **Contract-first**: core runtime behavior is specified and fixture-tested across languages.
- **First-class across Go/TS/Py**: the portable core is not a “Go SDK with ports”.
- **Supply-chain safe**: GitHub Releases only; deterministic build gates.
- **Operationally safer defaults**: fewer “gotchas” like “must register OPTIONS routes or middleware won’t run”.

AppTheory already improves on Lift in some areas (contract tests, deterministic builds, `HandleLambda`, no-OPTIONS-needed
CORS preflight behavior), but there are still Lift parity gaps that block real migrations.

## Lift parity gaps that still block Autheory + K3 migrations

These are not “future improvements”; these are Lift features in active use.

### G0 — Middleware pipeline (`app.Use`) is missing (Go/TS/Py)

**Why it’s required**
- Autheory and K3 both rely on Lift’s global middleware chain (`app.Use(...)`) for:
  - request-scoped dependency injection (`ctx.Set("db", ...)`)
  - auth + auditing + tracing
  - security headers and rate limiting
- Lesser relies on Lift middleware (RequestID/Recover/Logger/Timeout) including “global middleware” patterns for
  non-HTTP triggers.

**Current AppTheory state**
- AppTheory has “built-in middleware semantics” for P1/P2 (request-id, recovery, minimal CORS), but **no user-extensible
  middleware chain**.

**Remediation**
- Implement a portable middleware pipeline in all three SDKs (Go/TS/Py) with explicit ordering and fixture coverage.
- Provide a migration path for Lift’s “global middleware” concept for non-HTTP triggers (events/websockets).

**Acceptance criteria**
- Go/TS/Py: `app.use(...)` (or idiomatic equivalent) exists and composes middleware around handlers.
- Middleware runs for:
  - HTTP requests
  - WebSockets
  - (explicit opt-in) event triggers (SQS/EventBridge/DynamoDB Streams)
- Contract fixtures prove:
  - ordering invariants
  - error envelope behavior under middleware errors/panics
  - request-id propagation regardless of middleware behavior

**Complex enough for a dedicated sub-roadmap**
- ✅ Add `docs/development/planning/apptheory/subroadmaps/SR-MIDDLEWARE.md` (new).

---

### G1 — Context value bag (`ctx.Set` / `ctx.Get`) is missing (Go/TS/Py)

**Why it’s required**
- K3 uses this to inject dependencies (DB/tokenService) and shared request state (request_id).
- Many Lift middleware patterns rely on setting/retrieving values in context.

**Current AppTheory state**
- `apptheory.Context` has no values map (no `Set`/`Get`).

**Remediation**
- Add a portable key/value bag to context in Go/TS/Py.

**Acceptance criteria**
- Go/TS/Py: `ctx.set(key, value)` + `ctx.get(key)` exist (idiomatic casing per language).
- Contract fixtures validate:
  - values survive middleware layers and reach handlers
  - reserved keys policy (if any) is documented

**Complex enough for a dedicated sub-roadmap**
- ✅ Include in `SR-MIDDLEWARE` (same workstream).

---

### G2 — Lift route patterns (`:param`) are not supported (Go/TS/Py)

**Why it’s required**
- Autheory uses Lift-style `:id` path params extensively.
- For “easy migration” (even if not drop-in), supporting both syntaxes materially reduces rewrite work and mistakes.

**Current AppTheory state**
- AppTheory router supports `{param}` segments only (contract syntax).

**Remediation**
- Accept both `:param` and `{param}` patterns at registration time (normalize to the contract model).

**Acceptance criteria**
- Go/TS/Py: `:param` routes work equivalently to `{param}` routes.
- Contract fixtures cover both syntaxes (and ensure they are equivalent).

---

### G3 — Lift services parity: EventBus (Autheory) is missing

**Why it’s required**
- Autheory imports `github.com/pay-theory/lift/pkg/services` for:
  - DynamoDB-backed EventBus
  - Memory EventBus (tests)
  - Event replay tooling
  - EventBridge detail shaping helpers

**Current AppTheory state**
- AppTheory provides **event triggers** (EventBridge + DynamoDB Streams) but not a durable EventBus abstraction.

**Remediation**
- Port the EventBus surface into AppTheory (Go first), with a clear multi-language portability story:
  - If full parity is feasible cross-language: design it as portable.
  - If not: ship Go-only first, explicitly documented (but still a parity requirement for Pay Theory).

**Acceptance criteria**
- An AppTheory EventBus API exists that can replace Autheory’s Lift EventBus usage (at least: create events, query, and
  DynamoDB persistence).
- Test coverage includes deterministic unit tests and any required strict fakes.

**Complex enough for a dedicated sub-roadmap**
- ✅ Add `docs/development/planning/apptheory/subroadmaps/SR-SERVICES.md` (new), starting with EventBus.

---

### G4 — Lift observability packages parity (K3)

**Why it’s required**
- K3 depends on:
  - `github.com/pay-theory/lift/pkg/observability`
  - `github.com/pay-theory/lift/pkg/observability/zap`
  - structured logger lifecycle (`Close()`), environment-aware behavior (`app.IsLambda()`), and optional SNS error
    notifications.

**Current AppTheory state**
- AppTheory exposes portable observability **hooks** (contract-backed) and also provides Go-only logger implementation
  packages for Lift parity:
  - Go: `pkg/observability` (`StructuredLogger`, `LoggerConfig`, `HooksFromLogger`, `NewTestLogger`, `NewNoOpLogger`)
  - Go: `pkg/observability/zap` (`NewZapLogger`, `NewZapLoggerFactory`, `WithEnvironmentErrorNotifications`,
    `NewSNSNotifier`)
  - Go: `apptheory.IsLambda()` / `app.IsLambda()` helpers exist for environment-aware behavior.

**Remediation**
- ✅ Define an AppTheory Go logger interface + zap integration package that can replace K3’s usage.
- ✅ Keep the portable hooks as the “contract surface”; allow Go-only integrations on top.

**Acceptance criteria**
- K3 can create a structured logger and connect it to AppTheory’s runtime without re-implementing the entire logging
  stack in each service.
- Log payload sanitization guidance is included (see G5).

**Complex enough for a dedicated sub-roadmap**
- ✅ Extend `docs/development/planning/apptheory/subroadmaps/SR-PROD-FEATURES.md` to include “logger implementation
  packages” as a Go-only-but-supported layer.

---

### G5 — Lift sanitization utilities (K3)

**Why it’s required**
- K3 uses `github.com/pay-theory/lift/pkg/utils/sanitization` for safe logging (e.g. `SanitizeJSON`).

**Current AppTheory state**
- Sanitization helpers exist in Go/TS/Py:
  - Go: `pkg/sanitization` (`SanitizeLogString`, `SanitizeJSON`, `SanitizeXML`, `PaymentXMLPatterns`)
  - TS: `ts/dist/index.js` (`sanitizeLogString`, `sanitizeJSON`, `sanitizeXML`, `paymentXMLPatterns`)
  - Py: `py/src/apptheory/sanitization.py` (`sanitize_log_string`, `sanitize_json`, `sanitize_xml`, `payment_xml_patterns`)

**Remediation**
- Add an AppTheory sanitization package:
  - minimum: log-forging prevention + JSON redaction/masking helpers
  - align with the “portable core” where possible

**Acceptance criteria**
- K3 can safely log raw AWS events / request payloads without leaking secrets or enabling log forging.

**Complex enough for a dedicated sub-roadmap**
- ✅ Add `docs/development/planning/apptheory/subroadmaps/SR-SANITIZATION.md` (new).

## Lift parity gaps that are required for Lesser (and good AppTheory DX)

### G6 — Naming utilities parity (`lift/pkg/naming`) are missing

**Why it’s required**
- Lesser imports `github.com/pay-theory/lift/pkg/naming` for deterministic resource naming patterns.

**Remediation**
- Add a small, deterministic naming utility across Go/TS/Py (stage normalization + resource naming helpers).

**Acceptance criteria**
- Naming helpers exist in all three SDKs and are covered by unit tests (not necessarily contract fixtures).

**Complex enough for a dedicated sub-roadmap**
- ✅ Add `docs/development/planning/apptheory/subroadmaps/SR-NAMING.md` (new).

---

### G7 — Lift testing package parity (`lift/pkg/testing`) is missing

**Why it’s required**
- Lesser and K3 documentation reference Lift’s test helpers (`NewTestApp`, `CreateTestContext`, etc).

**Current AppTheory state**
- AppTheory has testkits and fakes for core triggers, but does not provide a Lift-like test harness for HTTP handler
  tests and middleware tests.

**Remediation**
- Expand AppTheory testkits to include:
  - request/context builders for unit tests (without AWS events)
  - middleware harness helpers (especially once `app.use` exists)

**Acceptance criteria**
- For Go/TS/Py: it is easy to unit test handlers and middleware without CDK/AWS.

**Complex enough for a dedicated sub-roadmap**
- ✅ Extend `docs/development/planning/apptheory/subroadmaps/SR-MOCKS.md` to include “test harness parity”.

---

### G8 — “True streaming” SSE API is missing (Go/TS/Py)

**Why it’s required**
- Lift supports SSE via an event-by-event streaming API (`SSEResponse(ctx, <-chan SSEEvent)`), not only a buffered body.

**Current AppTheory state**
- AppTheory can return SSE-framed bodies and can emit a REST v1 streaming response type, but does not yet expose a
  channel/stream-driven SSE response API.

**Remediation**
- Implement a “true streaming SSE” API in Go/TS/Py aligned to each language’s streaming primitives.

**Acceptance criteria**
- A long-lived SSE endpoint can stream multiple events over time without buffering the full response in memory.
- Contract fixtures cover framing + required headers; an integration example exists in CDK.

**Complex enough for a dedicated sub-roadmap**
- ✅ Extend `docs/development/planning/apptheory/subroadmaps/SR-SSE.md`.

## CDK parity gaps (Autheory + K3)

Autheory and K3 use a much larger slice of Lift’s CDK constructs than Lesser does (tables, KMS keys, roles, queues,
alarms, DNS, certificates, security, etc).

**Current AppTheory state**
- AppTheory CDK is TS-first jsii and currently covers a focused set of constructs (API + triggers + basic alarms).

**Remediation**
- Expand AppTheory CDK parity to cover the constructs/patterns required for Autheory + K3 **or** provide a documented,
  supported “template-first” posture for the remainder (still first-class for Go/TS/Py via jsii examples).

**Acceptance criteria**
- There is a clear, validated path to deploy Autheory and K3 using AppTheory’s CDK story without falling back to Lift
  constructs long-term.

**Complex enough for a dedicated sub-roadmap**
- ✅ Extend `docs/development/planning/apptheory/subroadmaps/SR-CDK.md` with a dedicated “Autheory + K3 construct parity”
  milestone list (or create `SR-CDK-PAYTHEORY.md` if it becomes too large).

## Remediation roadmap (sequenced)

This is the shortest path to “Lift replacement + improvement” for the apps that matter (Autheory + K3 first).

### R0 — Fix planning doc drift (small, immediate)

**Goal:** ensure the repo’s planning docs reflect reality (`v0.2.0-rc.1` capabilities already implemented).

**Acceptance criteria**
- Parity matrix marks implemented Lift parity extensions as `✅`.
- Lesser gap analysis is updated to stop listing already-implemented features as gaps.

---

### R1 — Middleware + Context portability (largest runtime blocker; `SR-MIDDLEWARE`)

**Goal:** unblock real Lift app migrations without sacrificing cross-language parity.

**Acceptance criteria**
- `app.use` + `ctx.set/get` exist in Go/TS/Py.
- Built-in middleware set covers Lift’s commonly-used defaults (RequestID, Recover, Logger, CORS, Timeout) with a
  portable subset fixture-backed.
- Migration guide includes “Lift middleware → AppTheory middleware” mapping.

---

### R2 — “True streaming” SSE parity (`SR-SSE`)

**Goal:** fully replace Lift SSE usage for long-lived connections.

**Acceptance criteria**
- Go/TS/Py support event-by-event SSE streaming (not only buffered bodies).
- CDK/docs show how to enable response streaming for REST API v1 SSE endpoints.

---

### R3 — Autheory EventBus parity (`SR-SERVICES`)

**Goal:** close the biggest Lift services dependency for Pay Theory.

**Acceptance criteria**
- An AppTheory EventBus package replaces `lift/pkg/services` EventBus usage in Autheory (Go).
- A portability decision exists for TS/Py (portable vs Go-only) and is documented.

---

### R4 — K3 observability + sanitization parity (`SR-PROD-FEATURES` + `SR-SANITIZATION`)

**Goal:** preserve K3’s operational behavior and safety posture.

**Acceptance criteria**
- Zap-based structured logger integration exists (Go) and is easy to use across services.
- Sanitization helpers exist (at least JSON + log forging prevention) and are used in examples/docs.

---

### R5 — Naming utilities parity (`SR-NAMING`)

**Goal:** preserve deterministic naming patterns used by Lift apps and CDK templates.

**Acceptance criteria**
- Go/TS/Py naming helpers exist and are tested.

---

### R6 — CDK parity for Autheory + K3 (`SR-CDK`)

**Goal:** keep AppTheory’s deploy story “Lift-grade” for the hardest real apps.

**Acceptance criteria**
- AppTheory CDK includes (or ships templates/examples for) the constructs Autheory + K3 require, with pinned synth gates.
- Versioning/distribution remain GitHub Releases only.

---

### R7 — Testing harness parity (`SR-MOCKS`)

**Goal:** keep the “fast, AWS-free” unit testing experience for handlers and middleware.

**Acceptance criteria**
- Test harness helpers exist for handler and middleware unit tests (Go/TS/Py).

---

### R8 — Lint parity with TableTheory (TS + Py) (`SR-LINT`)

**Goal:** match TableTheory’s contributor experience and quality posture.

Note: you asked to “bring in the lint config from TableTheory” — treat this as part of the plan, not required for
Lift feature parity, but required for “first-class repo quality”.

**Acceptance criteria**
- TS lint matches TableTheory’s posture (eslint on source, not only `dist/`).
- Py lint matches TableTheory’s posture (ruff config + formatting/lint gating).
