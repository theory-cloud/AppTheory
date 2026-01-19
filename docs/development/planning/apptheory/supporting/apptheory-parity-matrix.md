# AppTheory Multi-language Parity Matrix (Template)

This matrix tracks which features are implemented in Go/TypeScript/Python and which are fixture-backed by the runtime
contract tests.

Status: structure frozen for milestone `M0` (implementation statuses will evolve).

## Tier definitions (portable surface area)

Tier definitions are the *portable* surface area. If it is in P0/P1/P2, it MUST be:

- specified in the runtime contract, and
- fixture-tested in `contract-tests/`, and
- implemented equivalently in Go/TypeScript/Python.

P0 / P1 / P2 tier definitions (frozen in `M0`, summarized here for quick reference):

- **P0 (Runtime core):** HTTP event adapters + routing + request/response normalization + error envelope + validation
  rules.
- **P1 (Context + middleware):** request-id, auth hooks, tenant extraction, CORS, size/time guardrails, middleware
  ordering.
- **P2 (Prod features):** observability (logs/metrics/traces), rate limiting / load shedding semantics, policy hooks,
  “safe by default” controls.

Source: `docs/development/planning/apptheory/apptheory-multilang-roadmap.md`

## Allowed divergence (rare, explicit)

Portable semantics are the goal; “allowed to diverge” is intentionally narrow:

- **API shape may be idiomatic per language**, but MUST provide equivalent capabilities and MUST match the contract
  fixtures.
- **Implementation details may diverge** (libraries, concurrency primitives, etc.) as long as externally observable
  behavior matches fixtures.
- **Non-portable features MUST NOT hide in P0/P1/P2**. If a feature cannot be made portable, it MUST be listed in the
  Go-only section below with a clear boundary and doc link.

Legend:

- ✅ implemented + passing fixtures
- 🟨 implemented but missing fixtures / partial
- ⬜ not implemented
- 🚫 intentionally non-portable / Go-only (must be documented)

## P0 — Runtime core

| Feature | Fixtures | Go | TS | Py | Notes |
| --- | --- | --- | --- | --- | --- |
| HTTP adapter: Lambda URL | P0 | ⬜ | ⬜ | ⬜ | |
| HTTP adapter: APIGW v2 | P0 | ⬜ | ⬜ | ⬜ | |
| Router: path + method dispatch | P0 | ⬜ | ⬜ | ⬜ | |
| JSON parsing + content-type rules | P0 | ⬜ | ⬜ | ⬜ | |
| Headers normalization | P0 | ⬜ | ⬜ | ⬜ | case-insensitive lookups |
| Cookies normalization | P0 | ⬜ | ⬜ | ⬜ | |
| Error envelope + taxonomy | P0 | ⬜ | ⬜ | ⬜ | stable error codes |

## P1 — Context + middleware

| Feature | Fixtures | Go | TS | Py | Notes |
| --- | --- | --- | --- | --- | --- |
| Request ID middleware | P1 | ⬜ | ⬜ | ⬜ | |
| Auth hook interface | P1 | ⬜ | ⬜ | ⬜ | |
| Tenant extraction | P1 | ⬜ | ⬜ | ⬜ | |
| CORS middleware | P1 | ⬜ | ⬜ | ⬜ | |
| Size/time guardrails | P1 | ⬜ | ⬜ | ⬜ | |

## P2 — Prod features (portable subset only)

| Feature | Fixtures | Go | TS | Py | Notes |
| --- | --- | --- | --- | --- | --- |
| Structured logging minimum schema | P2 | ⬜ | ⬜ | ⬜ | |
| Metrics hooks (portable) | P2 | ⬜ | ⬜ | ⬜ | optional |
| Tracing hooks (portable) | P2 | ⬜ | ⬜ | ⬜ | optional |
| Rate limiting semantics (portable) | P2 | ⬜ | ⬜ | ⬜ | target: match `limited` feature set (strategies, fail-open, stats) |
| Load shedding semantics (portable) | P2 | ⬜ | ⬜ | ⬜ | |

## Go-only (must be explicit)

| Feature | Go | Notes |
| --- | --- | --- |
| (none yet) |  | |
