# SR-CONTRACT — Runtime Contract + Contract Tests

Goal: prevent cross-language semantic drift by defining AppTheory’s core behavior as a **versioned runtime contract**
validated by shared **fixture-driven contract tests** across Go/TypeScript/Python.

This workstream is the backbone of “first-class in all languages”. If contract fixtures are weak, parity will drift.

## Scope (what the contract owns)

Portable semantics only (P0/P1/P2 tiers):

- Event adapters (initially HTTP via Lambda Function URL / API Gateway v2)
- Canonical request/response model
- Routing semantics (path matching, method dispatch)
- Header/query/body decoding rules (including base64 behavior)
- Cookie behavior (if supported)
- Error taxonomy + status mapping
- Middleware ordering + invariants
- Context fields that must exist across languages (request-id, tenant, auth hooks)

Non-goals (for contract v0):

- Contract v0 is the **first slice** (HTTP). Lift parity requires expanding the contract (v1+) to cover non-HTTP triggers
  and streaming/WebSockets, but those additions must ship with fixtures (fail closed) rather than as informal behavior.
- Non-portable “power features” that cannot be made equivalent across languages.

## Artifacts (source of truth)

- Contract spec (human-readable): `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`
- Fixtures (machine-readable): `contract-tests/` (to be created)
- Runners (language-specific): `contract-tests/runners/{go,ts,py}` (to be created)

## Current status (AppTheory `v0.2.0-rc.1`)

- Contract fixtures exist and are validated in CI across Go/TS/Py for:
  - P0 / P1 / P2 core tiers (`contract-tests/fixtures/p0|p1|p2`)
  - Lift parity extensions (`contract-tests/fixtures/m1|m2|m3|m12`)
- M12 fixtures cover:
  - global middleware pipeline + `ctx.Set/Get` (`contract-tests/fixtures/m12/middleware-ctx-bag.json`)
  - naming helpers (`contract-tests/fixtures/m12/naming-helpers.json`)
  - SSE event-by-event streaming framing (`contract-tests/fixtures/m12/sse-event-stream-three-events.json`)

## Contract versioning rules (fail-closed)

- Contract changes must be additive unless explicitly marked breaking.
- Every contract change must include fixture updates.
- Contract fixture changes must include at least one implementation update in the same PR (or be marked `BLOCKED` with a
  tracked issue).
- If fixture expectations change, all three languages must either:
  - pass the updated fixtures, or
  - declare a scoped, documented incompatibility (temporary exception with expiry).

## Milestones

### C0 — Freeze contract scope + tiers (P0/P1/P2)

**Acceptance criteria**
- P0/P1/P2 definitions are written and referenced by the parity matrix.
- “Allowed to diverge” boundaries are explicit (and rare).

**Deliverables**
- Update: `docs/development/planning/apptheory/supporting/apptheory-parity-matrix.md`

---

### C1 — Define canonical request/response/error model (Contract v0)

**Acceptance criteria**
- Canonical request model includes method/path/query/headers/body bytes + base64 indicator.
- Canonical response model includes status/headers/cookies/body bytes + base64 indicator.
- Error taxonomy exists with stable error codes (string IDs) + HTTP status mapping.
- Middleware ordering rules are explicitly stated.

**Deliverables**
- `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`

---

### C2 — Build P0 fixtures (minimum runtime core)

**Acceptance criteria**
- Fixtures cover:
  - routing (exact vs parameter segments; 404/405 rules)
  - JSON parsing (invalid JSON; content-type behavior; empty body)
  - header normalization (case-insensitive lookups; multi-value semantics decision)
  - cookies (if supported)
  - response encoding (base64 rules for binary; content-length rules if enforced)
  - error mapping (validation/auth/not-found/internal)
- Fixtures are deterministic and compare on exact output (including headers/cookies ordering rules where applicable).

---

### C3 — Runner protocol + harness (Go/TS/Py)

**Acceptance criteria**
- Each language runner can:
  - load the same fixtures (YAML/JSON)
  - execute fixtures against the language runtime implementation
  - emit deterministic diffs on failure (human-debuggable)
- A single “run contract tests” command exists per language runner.

---

### C4 — Expand to P1 fixtures (context + middleware)

**Acceptance criteria**
- Fixtures cover:
  - request-id creation/propagation rules
  - tenant extraction rules and tagging
  - auth hook invocation ordering
  - CORS rules
  - request/response size guardrails (if part of contract)
  - timeout/remaining-time behavior (if part of contract)

---

### C5 — Expand to P2 fixtures (portable prod features)

**Acceptance criteria**
- Fixtures cover the portable subset of:
  - structured logging fields (minimum schema)
  - metrics naming/tagging rules (if provided)
  - tracing span naming (if provided)
  - rate limit / load shedding behavior (if portable)
- Any non-portable feature is explicitly excluded and documented.

---

### C6 — CI gates and change policy

**Acceptance criteria**
- Contract tests run in CI for all three languages (or fail closed as `BLOCKED` if tooling is missing).
- Contract changes require updating:
  - the contract spec doc
  - fixtures
  - at least one implementation
- A “contract change checklist” exists in contributing docs (or a PR template).

---

### C7 — Lift parity extensions (contract v1+)

**Acceptance criteria**
- New contract specs + fixtures exist for Lift-parity runtime surfaces beyond HTTP:
  - SQS / EventBridge / DynamoDB Streams routing and semantics
  - WebSocket trigger routing + portable WebSocket context shape
  - API Gateway REST API v1 normalization and SSE streaming helpers
- All three languages pass the new fixtures (no “Go first” exceptions for portable surfaces).

Tracking sub-roadmaps:

- `docs/development/planning/apptheory/subroadmaps/SR-EVENTSOURCES.md`
- `docs/development/planning/apptheory/subroadmaps/SR-WEBSOCKETS.md`
- `docs/development/planning/apptheory/subroadmaps/SR-SSE.md`

## Risks and mitigation

- **Event source complexity creep:** keep contract v0 narrowly scoped to HTTP events; add new event sources only when
  fixtures exist.
- **Fixture ambiguity:** avoid “fuzzy” expectations; prefer exact expected outputs.
- **Language mismatch pressure:** if a semantics choice is hard in one language, redesign contract to be portable or
  explicitly mark as Go-only.
