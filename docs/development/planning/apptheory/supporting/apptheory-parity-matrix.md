# AppTheory Multi-language Parity Matrix (Template)

This matrix tracks which features are implemented in Go/TypeScript/Python and which are fixture-backed by the runtime
contract tests.

Status: structure frozen for milestone `M0` (implementation statuses will evolve).

Tier definitions live in:

- `docs/development/planning/apptheory/apptheory-multilang-roadmap.md`

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
