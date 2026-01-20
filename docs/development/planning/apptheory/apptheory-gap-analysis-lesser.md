# AppTheory Lift-Parity Gap Analysis (Lesser: `equaltoai/lesser`)

This document is the **Lift parity** gap analysis derived from the real Lift usage in the Lesser application repo
(`github.com/equaltoai/lesser`). If any capability below is missing from AppTheory, AppTheory is **not a Lift
replacement** for Lesser.

Status snapshot:

- AppTheory repo: `AppTheory/`
  - `make rubric`: PASS (as of `v0.1.0`)
- Lesser repo (local workspace): `lesser/`
  - Lift dependency: `github.com/pay-theory/lift v1.0.82` (`lesser/go.mod`)

How this inventory was generated:

- Local code search in `lesser/` for:
  - `github.com/pay-theory/lift/pkg/...` imports
  - Lift runtime surface usage (`app.SQS`, `app.EventBridge`, `app.DynamoDB`, `app.WebSocket`, `lift.SSEResponse`, etc)
  - Lift CDK constructs usage in `lesser/infra/cdk/...`

## Lift surfaces Lesser uses (required AppTheory capabilities)

### Runtime (Go)

Lesser uses Lift as a **single Lambda entrypoint router** across multiple trigger types:

- **HTTP**
  - API Gateway v2 (HTTP API)
  - (also uses Lambda URL patterns in other apps; AppTheory already supports this)
- **API Gateway REST API v1**
  - SSE endpoints (Server-Sent Events) implemented via Lift’s `lift.SSEResponse` and `lift.SSEEvent`
- **WebSockets (API Gateway v2 WebSocket API)**
  - `lift.WithWebSocketSupport()`
  - `app.WebSocket("$connect" | "$disconnect" | "$default", handler)`
  - `ctx.AsWebSocket()` → `*lift.WebSocketContext`
  - `wsCtx.SendJSONMessage(...)`
- **Event sources**
  - `app.SQS(...)` (SQS-triggered Lambdas)
  - `app.EventBridge(...)` (scheduled rules + EventBridge events)
  - `app.DynamoDB(...)` (DynamoDB Streams-triggered Lambdas)

### Supporting Lift packages

Lesser imports these Lift packages directly:

- Runtime + adapters: `github.com/pay-theory/lift/pkg/lift`, `github.com/pay-theory/lift/pkg/lift/adapters`
- Middleware: `github.com/pay-theory/lift/pkg/middleware` (RequestID, Recover, Logger, TimeoutMiddleware, LimitedRateLimit)
- WebSocket management client: `github.com/pay-theory/lift/pkg/streamer` (`NewClient`, `Client.PostToConnection`, etc)
- Testing: `github.com/pay-theory/lift/pkg/testing`
- Naming helper: `github.com/pay-theory/lift/pkg/naming` (via Lesser’s `pkg/deploy/naming`)
- CDK constructs: `github.com/pay-theory/lift/pkg/cdk/constructs`

### CDK / infrastructure

Lesser uses Lift’s **Go CDK constructs** for:

- **API Gateway REST API v1 construct**: `LiftRestAPI` (including method-level streaming toggles for SSE endpoints)
- **EventBridge handler construct**: scheduled rules targeting Lambda
- **Event source mapping construct**: DynamoDB stream event source mappings
- **LiftFunction** defaults wrapper (Lambda defaults/roles/logs/etc)
- Additional infra wiring around:
  - API Gateway v2 WebSocket APIs (built directly via CDK v2 constructs)
  - queues (SQS + DLQ) and consumers

## AppTheory current coverage vs Lesser requirements

### Already covered (no action needed)

- HTTP runtime core (P0/P1/P2) across Go/TS/Py:
  - APIGW v2 (HTTP API) adapter
  - Lambda URL adapter
  - router, middleware tiers, error envelope, contract fixtures
- Release posture and rubric gating:
  - GitHub Releases-only distribution
  - `make rubric` verifies version alignment, Go lint, TS/Py packaging, CDK packaging/synth, and contract tests

### Gaps (must be implemented to “pass Lift parity”)

| Gap | What’s missing in AppTheory today | Required for parity | Complex enough for sub-roadmap |
| --- | --- | --- | --- |
| G1 | API Gateway REST API v1 adapter (non-streaming + streaming) | Lesser SSE and any Lift REST API v1 usage | ✅ `SR-SSE` |
| G2 | SSE primitives (event type + streaming response helper) | Lesser SSE Lambda (`lift.SSEEvent`, `lift.SSEResponse`) | ✅ `SR-SSE` |
| G3 | WebSocket trigger support + WebSocketContext | Lesser streaming + GraphQL WS Lambdas | ✅ `SR-WEBSOCKETS` |
| G4 | WebSocket management client (Lift `pkg/streamer` equivalent) + strict fakes | Lesser message delivery (`PostToConnection`) and tests (`GetConnection`) | ✅ `SR-WEBSOCKETS` + `SR-MOCKS` |
| G5 | Non-HTTP event sources routing (SQS, EventBridge, DynamoDB Streams) | Multiple Lesser processors | ✅ `SR-EVENTSOURCES` |
| G6 | Cross-language parity + fixtures for G1–G5 | First-class TS/Py requirement | ✅ extend `SR-CONTRACT` + each sub-roadmap |
| G7 | CDK constructs parity for Lesser-used constructs | Lift-quality deploy story for REST v1 + WS + event sources | ✅ extend `SR-CDK` |
| G8 | Migration playbook sections for SSE/WS/event-sources + CDK | “Easy migration” constraint | ✅ extend `SR-MIGRATION` |
| G9 | Lint/config parity with TableTheory (TS/Py) | Release-quality posture matching TableTheory | ✅ `SR-LINT` |

## Remediation roadmap (required implementation plan)

This roadmap is sequenced to keep AppTheory continuously shippable while closing Lift parity gaps.

### M1 — Event source router parity (SQS / EventBridge / DynamoDB Streams)

Sub-roadmap: `docs/development/planning/apptheory/subroadmaps/SR-EVENTSOURCES.md`

**Acceptance criteria**
- Go runtime supports registering handlers for SQS, EventBridge, and DynamoDB Streams and routes events deterministically.
- TS runtime supports the same trigger types with equivalent semantics.
- Py runtime supports the same trigger types with equivalent semantics.
- Contract fixtures exist for each trigger type, and all three languages pass.
- Testkits ship event builders for each trigger type (Go/TS/Py).
- CDK example(s) demonstrate wiring SQS, EventBridge schedule, and DynamoDB Streams into Lambdas in all three languages.

---

### M2 — WebSocket runtime parity + management client

Sub-roadmap: `docs/development/planning/apptheory/subroadmaps/SR-WEBSOCKETS.md`

**Acceptance criteria**
- Go runtime supports WebSocket trigger routing (`$connect`, `$disconnect`, `$default`) with a WebSocket-specific context.
- Go provides a `streamer`-equivalent client for API Gateway Management API with strict fakes for tests.
- TS and Py provide equivalent runtime support and management client interfaces (or a clearly-defined portable boundary).
- Contract fixtures cover:
  - trigger routing
  - extracting `connectionId`, `routeKey`, `managementEndpoint`, etc
  - deterministic error envelope behavior
  - message send behavior (via mocks/fakes)
- CDK example deploys a WebSocket API and demonstrates send/broadcast paths.

---

### M3 — API Gateway REST API v1 + SSE parity (including streaming)

Sub-roadmap: `docs/development/planning/apptheory/subroadmaps/SR-SSE.md`

**Acceptance criteria**
- Go runtime supports API Gateway REST API v1 request/response normalization.
- Go runtime supports streaming responses required for SSE (where supported by AWS).
- TS and Py provide equivalent REST v1 adapter support and SSE response helpers.
- Contract fixtures cover REST v1 normalization and SSE response framing.
- CDK constructs and examples support deploying REST v1 + enabling streaming per-method (SSE endpoints).

---

### M4 — CDK parity for Lesser-used Lift constructs

Sub-roadmap: extend `docs/development/planning/apptheory/subroadmaps/SR-CDK.md`

**Acceptance criteria**
- AppTheory CDK library (jsii) provides equivalents for the Lift constructs Lesser uses:
  - REST API v1 (with streaming toggles)
  - event source mappings (streams)
  - EventBridge schedule → Lambda wiring
  - sane Lambda defaults wrapper
- CDK assets are distributed via GitHub Releases and consumable in Go/TS/Py.
- Snapshot tests and `cdk synth` drift gates cover these constructs.

---

### M5 — Mocks/testkit parity for new AWS touchpoints

Sub-roadmap: extend `docs/development/planning/apptheory/subroadmaps/SR-MOCKS.md`

**Acceptance criteria**
- For every AWS client AppTheory wraps to match Lift parity (notably API Gateway Management API), strict fakes exist in:
  - Go testkit
  - TS testkit
  - Py testkit
- Examples/tests for WS/SSE/event-sources run in CI without AWS credentials.

---

### M6 — Migration playbook completeness (Lesser patterns)

Sub-roadmap: extend `docs/development/planning/apptheory/subroadmaps/SR-MIGRATION.md`

**Acceptance criteria**
- `docs/migration/from-lift.md` includes dedicated sections for:
  - SQS / EventBridge / DynamoDB Streams triggers
  - WebSockets + `streamer` usage
  - API Gateway REST v1 + SSE streaming
  - CDK migration notes (Lift constructs → AppTheory constructs)
- A representative Lesser subsystem migration is documented (even if not drop-in identical).

---

### M7 — Lint parity with TableTheory (plan-only in this pass)

Sub-roadmap: `docs/development/planning/apptheory/subroadmaps/SR-LINT.md`

**Acceptance criteria**
- AppTheory uses TableTheory-aligned lint configs and scripts for:
  - Go (already present)
  - TypeScript (ESLint + formatting rules)
  - Python (ruff + formatting rules)
- `make rubric` fails closed on lint issues in all three languages.

