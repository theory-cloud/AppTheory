# AppTheory Lift-Parity Gap Analysis (Lesser: `equaltoai/lesser`)

This document is the **Lift parity** gap analysis derived from the real Lift usage in the Lesser application repo
(`github.com/equaltoai/lesser`). If any capability below is missing from AppTheory, AppTheory is **not a Lift
replacement** for Lesser.

Status snapshot:

- AppTheory repo: `AppTheory/`
  - `make rubric`: PASS (as of `v0.2.0-rc.1`)
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
- Lift parity runtime extensions (Go/TS/Py):
  - API Gateway REST API v1 adapter (Lambda proxy)
  - SSE framing helpers
  - WebSockets routing + WebSocketContext
  - WebSocket management client + strict fakes
  - Non-HTTP trigger routing (SQS, EventBridge, DynamoDB Streams)
- CDK parity for Lift parity extensions:
  - REST API v1 (with method-level streaming toggle)
  - EventBridge handler wiring
  - DynamoDB Streams event source mappings
  - SQS queue processor wiring
- Release posture and rubric gating:
  - GitHub Releases-only distribution
  - `make rubric` verifies version alignment, Go lint, TS/Py packaging, CDK packaging/synth, and contract tests

### Remaining gaps (still required for Lesser Lift parity)

| Gap | What’s missing in AppTheory today | Required for parity | Complex enough for sub-roadmap |
| --- | --- | --- | --- |
| L1 | Lift-style middleware pipeline (`app.Use`) | Lesser uses Lift middleware (RequestID/Recover/Logger/Timeout) and “global middleware” patterns | ✅ new `SR-MIDDLEWARE` |
| L2 | Lift-style context value bag (`ctx.Set`/`ctx.Get`) | required for common middleware patterns and test harnesses | ✅ new `SR-MIDDLEWARE` |
| L3 | Lift naming helpers (`lift/pkg/naming`) | Lesser imports naming utilities for deterministic infra naming | ✅ new `SR-NAMING` |
| L4 | Lift testing helpers (`lift/pkg/testing`) | Lesser uses Lift test harness patterns (`NewTestApp`, `CreateTestContext`) | ✅ extend `SR-MOCKS` |
| L5 | “True streaming” SSE API (channel/stream) | Lift’s `SSEResponse(ctx, <-chan SSEEvent)` supports event-by-event streaming | ✅ extend `SR-SSE` |
| L6 | Migration guide sections for L1–L5 | “Easy migration” constraint (not drop-in, but predictable) | ✅ extend `SR-MIGRATION` |
| L7 | Lint parity with TableTheory (TS/Py) | First-class contributor DX and release posture | ✅ `SR-LINT` (plan-only) |

## Remediation roadmap (required implementation plan)

This roadmap is sequenced to keep AppTheory continuously shippable while closing the remaining Lesser-required Lift
parity gaps.

### L0 — Fix planning doc drift (small)

**Acceptance criteria**
- This doc reflects current AppTheory behavior (no longer listing implemented Lift parity features as gaps).
- `docs/development/planning/apptheory/supporting/apptheory-parity-matrix.md` matches implemented status.

---

### L1 — Middleware pipeline + context value bag (`SR-MIDDLEWARE`) (largest blocker)

**Acceptance criteria**
- Go/TS/Py middleware exists and can replace the Lift middleware usage patterns Lesser relies on.
- `ctx.Set/ctx.Get` exists (portable) so middleware and tests can share request-scoped state.

---

### L2 — “True streaming” SSE API (`SR-SSE`)

**Acceptance criteria**
- AppTheory can stream SSE events incrementally (Lift parity: channel/stream-driven SSE), not just return a buffered body.

---

### L3 — Naming helpers (`SR-NAMING`)

**Acceptance criteria**
- Deterministic naming helpers exist (Go/TS/Py) and can replace Lesser’s `lift/pkg/naming` usage.

---

### L4 — Lift-style testing helpers (`SR-MOCKS`)

**Acceptance criteria**
- AppTheory provides an ergonomic unit-test harness for handlers and middleware (Go/TS/Py), comparable to Lift’s
  `pkg/testing` patterns.

---

### L5 — Migration playbook sections (extend `SR-MIGRATION`)

**Acceptance criteria**
- `docs/migration/from-lift.md` includes Lesser-focused guidance for:
  - middleware migration patterns
  - naming helper mapping
  - SSE streaming migration (including infra knobs)

---

### L6 — Lint parity with TableTheory (plan-only in this pass) (`SR-LINT`)

**Acceptance criteria**
- TS/Py lint posture matches TableTheory once TS moves to a source-based workflow (eslint on source, not only `dist/`).
