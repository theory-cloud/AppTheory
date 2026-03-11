# AppTheory Multi-language Parity Matrix

This matrix tracks which features are implemented in Go/TypeScript/Python and which are fixture-backed by the runtime
contract tests.

Status: structure frozen for milestone `M0` (implementation statuses evolve as milestones land).

## Portable boundaries (P1/P2)

These are the P1/P2 capabilities that MUST remain portable across Go/TypeScript/Python (fixture-backed).

- **P1 portable core**
  - request-id creation/propagation and response header (`x-request-id`)
  - tenant extraction (`x-tenant-id` header, then `tenant` query param)
  - auth as a hook/interface (no hard-coded provider)
  - CORS origin echo + preflight handling
  - middleware ordering invariants (deterministic)
  - size/timeout guardrails (when configured)
  - `remaining_ms` surfaced to handlers (portable subset)
- **P2 portable core**
  - observability envelope via hooks (minimum log schema + stable metric/span naming rules where provided)
  - rate limiting semantics (portable subset; must map to `app.rate_limited` + deterministic `Retry-After` when known)
  - load shedding semantics (portable subset; must map to `app.overloaded` + deterministic `Retry-After` when known)

## Go-only boundaries (explicit)

These capabilities are explicitly allowed to be Go-only until they have a cross-language design + fixtures:

- provider-specific observability integrations (exporters, SDK wiring, OpenTelemetry SDK configuration)
- additional storage-backed rate limiting backends beyond DynamoDB (`limited`) (Redis/etc) and their provider wiring

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

Default behavior:

- Default tier is **P2** across Go/TypeScript/Python. Use an explicit `p0` / `p1` tier when you want the minimal surface
  area.

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
| HTTP adapter: Lambda URL | P0 | ✅ | ✅ | ✅ | fixture-backed (contract tests) |
| HTTP adapter: APIGW v2 | P0 | ✅ | ✅ | ✅ | fixture-backed (contract tests) |
| Router: path + method dispatch | P0 | ✅ | ✅ | ✅ | |
| JSON parsing + content-type rules | P0 | ✅ | ✅ | ✅ | |
| Headers normalization | P0 | ✅ | ✅ | ✅ | case-insensitive lookups |
| Cookies normalization | P0 | ✅ | ✅ | ✅ | |
| Error envelope + taxonomy | P0 | ✅ | ✅ | ✅ | stable error codes; optional fields: status_code/details/request_id/trace_id/timestamp/stack_trace |

## P0+ — Lift parity extensions (required)

These are required for Lift parity (e.g. Lesser usage) and must become fixture-backed contract work (contract v1+).

| Feature | Fixtures | Go | TS | Py | Notes |
| --- | --- | --- | --- | --- | --- |
| HTTP adapter: APIGW v1 (REST API) | m3 | ✅ | ✅ | ✅ | REST API v1 (Lambda proxy) adapter |
| SSE helpers + streaming responses | m3 | ✅ | ✅ | ✅ | `SSEEvent` + `SSEResponse` parity |
| SSE event-by-event streaming API | m12 | ✅ | ✅ | ✅ | fixture-backed (contract tests) |
| Naming helpers (`SR-NAMING`) | m12 | ✅ | ✅ | ✅ | fixture-backed (contract tests) |
| Trigger routing: SQS | m1 | ✅ | ✅ | ✅ | `app.SQS(...)` parity |
| Trigger routing: EventBridge | m1 | ✅ | ✅ | ✅ | `app.EventBridge(...)` parity |
| Trigger routing: DynamoDB Streams | m1 | ✅ | ✅ | ✅ | `app.DynamoDB(...)` parity |
| Trigger routing: AppSync resolvers | SR-APPSYNC | ✅ | ✅ | ✅ | shared `p2` fixtures + typed context + public migration/docs support |
| Trigger routing: WebSockets | m2 | ✅ | ✅ | ✅ | `$connect/$disconnect/$default` routing |
| WebSocket management client (`streamer`) | m2 | ✅ | ✅ | ✅ | `PostToConnection/GetConnection/DeleteConnection` parity |

## P1 — Context + middleware

| Feature | Fixtures | Go | TS | Py | Notes |
| --- | --- | --- | --- | --- | --- |
| Global middleware pipeline (`app.Use`) | m12 | ✅ | ✅ | ✅ | fixture-backed (contract tests) |
| Context value bag (`ctx.Set/Get`) | m12 | ✅ | ✅ | ✅ | fixture-backed (contract tests) |
| Request ID middleware | P1 | ✅ | ✅ | ✅ | |
| Auth hook interface | P1 | ✅ | ✅ | ✅ | |
| Tenant extraction | P1 | ✅ | ✅ | ✅ | |
| CORS middleware | P1 | ✅ | ✅ | ✅ | |
| Size/time guardrails | P1 | ✅ | ✅ | ✅ | |

## P2 — Prod features (portable subset only)

| Feature | Fixtures | Go | TS | Py | Notes |
| --- | --- | --- | --- | --- | --- |
| Structured logging minimum schema | P2 | ✅ | ✅ | ✅ | |
| Metrics hooks (portable) | P2 | ✅ | ✅ | ✅ | optional |
| Tracing hooks (portable) | P2 | ✅ | ✅ | ✅ | optional |
| Rate limiting semantics (portable) | P2 | ✅ | ✅ | ✅ | target: match `limited` feature set (strategies, fail-open, stats) |
| Load shedding semantics (portable) | P2 | ✅ | ✅ | ✅ | |

## P2+ — App packages (full alignment targets)

These are not part of the core runtime tiers, but they are required for “union-of-capabilities” alignment across
Go/TypeScript/Python. The `FA-M*` fixture markers refer to milestones in
`docs/development/planning/apptheory/apptheory-full-alignment-roadmap.md`.

| Feature | Fixtures | Go | TS | Py | Notes |
| --- | --- | --- | --- | --- | --- |
| Services: EventBus (memory) | FA-M3 | ✅ | ⬜ | ⬜ | Go: `pkg/services`; TS/Py parity required |
| Services: EventBus (DynamoDB) | FA-M3 | ✅ | ⬜ | ⬜ | TS uses AWS SDK; Py uses boto3; behavior fixture-backed |
| Services: EventBus metrics hooks | FA-M3 | ✅ | ⬜ | ⬜ | stable metric names/tags/config across languages |
| Limited: DynamoDB rate limiter | FA-M3 | ✅ | ✅ | ✅ | Go: `pkg/limited`; TS: SigV4+fetch; Py: boto3 |
| Limited: middleware integration | FA-M3 | ✅ | ⬜ | ⬜ | idiomatic per language; equivalent decisions/headers |
| Runtime: Lambda URL response streaming entrypoint | FA-M4 | 🟨 | ✅ | 🟨 | TS has true streaming; Go/Py currently buffered adapter |
| AWS: WebSocket management credential/provider chain | FA-M4 | ✅ | 🟨 | ✅ | TS currently env-only; align to Go/boto3 behavior |

## Go-only (must be explicit)

| Feature | Go | Notes |
| --- | --- | --- |
| (none yet) |  | |
