# AppTheory: Full Alignment Roadmap (Union-of-Capabilities Parity)

This roadmap closes the remaining *cross-language parity gaps* by standardizing on the **union of capabilities** (the
“highest rung” per area) and making **Go/TypeScript/Python** all **ship + test + support** that same *behavioral*
surface.

Baseline: the multi-language runtime contract + fixtures are already in place and enforced via `make rubric`. This
document focuses on the gaps that remain after the “runtime core parity” work.

## Decisions (frozen)

- **TypeScript avoids runtime AWS SDK dependencies**; AWS calls use SigV4-signed `fetch` for deterministic portability.
- **Parity means identical behavior with idiomatic naming per language.**
  - Names/modules can differ where it improves idiomatic DX.
  - Capabilities and externally observable behavior must match and be fixture-backed.

## Definition of “full alignment”

Full alignment is achieved when:

- The **canonical superset** of capabilities is documented (API + behavior).
- Go/TS/Py each implement that capability set (no “Go-only” for the items listed below).
- Contract fixtures (and higher-level behavior fixtures where needed) pass in all three languages.
- CI fails on both **behavior drift** (fixtures) and **API drift** (snapshots/manifests).

## Canonical superset (the current gap areas)

These are the specific “highest rung” capabilities we are aligning to:

1) **`pkg/services` EventBus (Go) → TS/Py parity**
- Memory implementation for tests/local (`Publish`, `Query`, `Subscribe`, `GetEvent`, `DeleteEvent`).
- DynamoDB implementation for production:
  - idempotent `Publish` (`IfNotExists`/condition-failed treated as success)
  - tenant-wide and event-type queries
  - tag filtering (`CONTAINS`)
  - time range filtering
  - cursor pagination via `LastEvaluatedKey["cursor"]` / `NextKey["cursor"]` (opaque string)
  - environment-variable table-name compatibility (`APPTHEORY_EVENTBUS_TABLE_NAME` + migration-friendly fallbacks)
  - portable metrics hook behavior (names/tags, enable/disable)

2) **`pkg/limited` (Go) → TS/Py parity** (core limiter ✅; middleware parity ⬜)
- DynamoDB-backed rate limiter with the same core semantics/config:
  - fixed-window, sliding-window, and multi-window strategies
  - atomic check-and-increment behavior where supported
  - fail-open behavior (configurable)
  - TTL behavior and key schema compatibility
  - deterministic clock hooks for tests
- Middleware integration parity:
  - Go: existing `pkg/limited/middleware` stays (net/http).
  - TS/Py: provide idiomatic middleware that enforces the same decision logic and produces equivalent headers and retry
    semantics (within each runtime’s handler model).

3) **Lambda Function URL response streaming parity**
- TypeScript’s Lambda URL streaming entrypoint becomes the parity target.
- Go and Python gain an equivalent Lambda URL streaming entrypoint (true streaming, not “buffer then return”) if the AWS
  runtime supports it; otherwise, we must explicitly decide on a portable fallback boundary and document it as a
  non-portable constraint (this roadmap assumes true streaming is achievable).
- Streaming contract details are locked:
  - “headers/cookies finalize” boundary (before first chunk)
  - deterministic late-error behavior after streaming begins
  - consistent chunk concatenation and encoding rules

4) **WebSocket management client credential/provider parity**
- Go uses `aws-sdk-go-v2` default config/provider chain; Python uses `boto3`; TypeScript must match that quality bar.
- Replace TS “env-only credentials + custom SigV4” with AWS SDK provider chain behavior (env, shared config, web identity,
  metadata, etc), plus explicit override hooks where needed.
- Error semantics become fixture-backed and consistent (e.g., missing endpoint/region/credentials failures).

## Milestones

Time estimates assume one dedicated engineer per language plus a shared contract/fixtures owner. If staffing differs,
re-sequence but keep the parity gate early.

### M0 — Lock the parity target (1–2 days)

**Goal:** define the canonical superset precisely enough that implementation work is unambiguous and testable.

**Deliverables**
- A written inventory of the **public surfaces** that participate in parity:
  - Go: `runtime/`, `pkg/`, `testkit/`
  - TS: `ts/dist/index.d.ts` (public types) + documented runtime entrypoints
  - Py: `py/src/apptheory/__init__.py` (public exports) + documented runtime entrypoints
- A capability manifest for the gap areas above (EventBus, limited, Lambda URL streaming, WS management client creds):
  - feature list
  - expected behavior and invariants
  - cross-language mapping notes (idiomatic naming allowed)
- M0 parity target document:
  - `docs/development/planning/apptheory/supporting/apptheory-full-alignment-parity-target.md`

**Acceptance criteria**
- Every “gap area” has:
  - a stable capability description
  - a stable list of externally observable behaviors (success + failure)
  - explicit cross-language naming expectations (what must exist, what may differ)
- Any intentional non-portable boundary (if required) is explicitly listed with rationale and a follow-up plan.

---

### M1 — Add a parity gate (≈1 week)

**Goal:** make parity drift fail closed in CI.

**Deliverables**
- **API drift detection**
  - Language-specific API snapshots (or extracted manifests) for:
    - Go exported surfaces (runtime/pkg/testkit)
    - TS public `.d.ts` surface
    - Py public exports (module surface)
  - A CI job that fails when:
    - an API snapshot changes without an intentional, reviewed update, or
    - a capability required by the manifest disappears.
- **Behavior drift detection**
  - Contract fixtures expanded as needed for new parity’d features (see M5).
  - All runners required to pass on PRs (not tag-only).

**Acceptance criteria**
- A PR that:
  - changes public API surface, or
  - changes fixture-observable behavior
  fails CI unless the corresponding snapshot/fixtures are updated intentionally.
- Snapshots/manifests are versioned and reviewed like code.

---

### M2 — Testkit parity (1–2 weeks)

**Goal:** make local/deterministic testing equally powerful in Go/TS/Py for every trigger shape and for streaming/WS.

**Deliverables**
- Each language exposes a deterministic TestEnv equivalent (clock + IDs) and:
  - builders for: HTTP v2, Lambda URL, ALB, APIGW v1 proxy, WebSockets, SQS, Kinesis, SNS, EventBridge, DynamoDB streams
  - invokers for each trigger
  - streaming capture utilities that preserve the “headers finalize before first chunk” invariant
  - WebSocket management client fakes with recorded call logs

**Acceptance criteria**
- The same test scenario (same event shape + same handler logic) can be expressed in all three languages and yields the
  same observable outputs.
- Streaming tests can assert:
  - chunk sequence,
  - concatenated body,
  - finalized headers/cookies,
  - late-error code mapping (when errors occur after streaming starts).

---

### M3 — “App code” package parity (2–4 weeks)

**Goal:** port Go-only application modules to TS/Py (no “Go-only” for these features once M3 lands).

#### M3a — EventBus parity (memory + DynamoDB) + metrics hooks

**Deliverables**
- TypeScript and Python EventBus packages with:
  - memory implementation (tests/local)
  - DynamoDB implementation (production)
  - the same core models and query semantics (cursor, time range, tag filtering)
  - metrics hook parity (names/tags/config)
- Strict fakes/mocks for DynamoDB clients and deterministic unit tests (no network).

**Acceptance criteria**
- A shared fixture family validates EventBus behavior across Go/TS/Py:
  - publish idempotency semantics
  - query filtering + ordering + pagination cursor behavior
  - get/delete behavior and error mapping
  - metrics emission behavior (when enabled)

#### M3b — DynamoDB-backed rate limiter parity + middleware

**Deliverables**
- TypeScript and Python implementations equivalent to `pkg/limited`:
  - strategy behavior matches Go
  - DynamoDB schema/key/TTL behavior matches Go
  - atomic check-and-increment behavior where supported (or explicitly documented fallback)
- Idiomatic middleware surfaces in TS/Py that match Go decision/headers behavior (within each runtime model).
- Strict fakes/mocks + deterministic unit tests.

**Acceptance criteria**
- A shared fixture family validates limiter behavior across Go/TS/Py:
  - fixed/sliding/multi-window decisions
  - fail-open vs fail-closed behavior
  - retry-after/reset semantics
  - header behavior for “allowed” and “rate limited” outcomes (as applicable per language)

---

### M4 — Runtime/AWS integration parity (2–3 weeks)

**Goal:** unify real AWS integration semantics where the current implementation quality differs across languages.

#### M4a — WebSocket management client (credential/provider parity)

**Deliverables**
- TypeScript management client reworked to use AWS SDK provider chain behavior (and AWS SDK signing), not env-only creds.
- A single documented credential sourcing expectation across Go/TS/Py:
  - supported provider sources
  - required env vars (if any)
  - behavior when region/endpoint/creds are missing

**Acceptance criteria**
- Go/TS/Py behave equivalently for:
  - missing endpoint
  - missing region resolution
  - missing/invalid credentials
  - request signing failures (where observable)
- Contract fixtures cover these failure modes in a deterministic way (no real AWS calls).

#### M4b — Lambda Function URL response streaming (entrypoint parity)

**Deliverables**
- Go and Python Lambda URL streaming handler entrypoints with equivalent behavior to TS:
  - status/headers/cookies finalize before first chunk
  - streamed chunks emitted in-order
  - deterministic late-error behavior and error code mapping
- Testkit support to invoke these entrypoints and capture results deterministically.

**Acceptance criteria**
- A shared fixture family validates streaming entrypoint behavior across Go/TS/Py, including:
  - header finalization invariants
  - chunk concatenation
  - error-after-first-chunk semantics
  - content-type expectations for HTML and SSE use cases

---

### M5 — Expand contract coverage (ongoing alongside M2–M4)

**Goal:** require all three language runners to pass new fixture families for each newly parity’d feature.

**Deliverables**
- New fixture families (and runners) for:
  - EventBus (publish/query/pagination/metrics)
  - rate limiter (strategies + middleware-visible semantics)
  - WebSocket client credential behavior (deterministic failure cases)
  - Lambda URL streaming entrypoint (finalize + late-error semantics)
- CI gating that requires:
  - Go runner pass
  - TS runner pass
  - Py runner pass

**Acceptance criteria**
- The parity gate (M1) prevents:
  - behavior drift (fixtures)
  - public surface drift (snapshots/manifests)
  for the features covered by this roadmap.

## Notes on implementation strategy (recommended)

- **TypeScript AWS SDK:** use the AWS SDK v3 clients (`@aws-sdk/*`) plus the default credential/provider chain for Node.
- **DynamoDB fakes:** prefer strict, in-memory fakes over local DynamoDB unless a behavior cannot be modeled otherwise.
- **Error semantics:** standardize on stable *error codes* (portable) and allow language-specific error types/messages
  (idiomatic), but fixture-test the observable contract (codes, status mapping, retry hints).

## Risks

- **Streaming runtime support:** if a managed AWS runtime cannot support true response streaming for Go or Python, we must
  explicitly document the boundary and choose between:
  - using a custom runtime (e.g., `provided.al2023`) to enable streaming, or
  - accepting a documented non-portable constraint (not “silent buffering”).
- **AWS SDK footprint (TS):** adding AWS SDK clients increases package size; mitigate with modular imports and avoid
  pulling in unused clients.
- **DynamoDB consistency edge cases:** atomic/multi-window rate limiting semantics must be tested carefully to avoid
  cross-language drift in race conditions.
