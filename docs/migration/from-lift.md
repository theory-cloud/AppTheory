# Lift → AppTheory Migration Guide

Goal: provide a predictable migration path from `pay-theory/lift` to AppTheory.

Posture: “easy migration”, not drop-in identical. Pay Theory’s requirement is that **100% of Lift’s current
functionality remains available for Go users** (portable subset + documented Go-only extensions).

## Start Here

- Baseline inventory (Pay Theory): `docs/development/planning/apptheory/supporting/apptheory-lift-usage-inventory.md`
- Mapping reference (seed): `docs/development/planning/apptheory/supporting/apptheory-lift-to-apptheory-mapping.md`
- Workstream roadmap: `docs/development/planning/apptheory/subroadmaps/SR-MIGRATION.md`
- Lift deprecation posture: `docs/migration/lift-deprecation.md`
- Representative migration notes: `docs/migration/g4-representative-migration.md`

## Quick Start (Go Service)

1. Replace `limited` imports (safe, diff-based):
   - Dry-run: `./scripts/migrate-from-lift-go.sh -root path/to/service`
   - Apply: `./scripts/migrate-from-lift-go.sh -root path/to/service -apply`
2. Replace Lift runtime wiring with `apptheory.New()` + route registration.
3. Configure AWS entrypoint(s):
   - If you used Lift as a single Lambda router across trigger types, prefer `app.HandleLambda`.
   - API Gateway v2 (HTTP API): `app.ServeAPIGatewayV2`
   - Lambda Function URL: `app.ServeLambdaFunctionURL`
4. Run your service tests + `make rubric` in AppTheory for contract parity expectations.

## Step-By-Step Migration (Go)

### 1) Update imports and dependencies

Core import root:

- Lift: `github.com/pay-theory/lift/...`
- AppTheory: `github.com/theory-cloud/apptheory`

Rate limiting:

- Lift historically: `github.com/pay-theory/limited`
- AppTheory: `github.com/theory-cloud/apptheory/pkg/limited` (+ `pkg/limited/middleware`)

Data (DynamoDB):

- Lift historically: DynamORM
- AppTheory: **TableTheory** (`github.com/theory-cloud/tabletheory`) is the companion data framework and replaces
  DynamORM for AppTheory work.

### 2) Replace app/router/handler surfaces

App container:

- Lift: `lift.New(...)`
- AppTheory: `apptheory.New(...)`

Tier selection:

- Default is `TierP2` (prod features: observability hooks, policy hook, rate limiting semantics).
- You can explicitly set: `apptheory.WithTier(apptheory.TierP0 | TierP1 | TierP2)`.

Routes:

- Lift-style routing maps directly:
  - `app.Get("/path", handler)`
  - `app.Post("/path", handler)`
  - `app.Handle(method, "/path", handler)`

Handler signature (Go):

- Lift: varies across packages and middleware; may be Go-specific.
- AppTheory: `func(*apptheory.Context) (*apptheory.Response, error)`

Response helpers:

- `apptheory.Text(status, "text")`
- `apptheory.JSON(status, value)` (returns `(*Response, error)`)
- `apptheory.Binary(status, bytes, contentType)`

### 3) Middleware, ordering, and limits

AppTheory P1/P2 has a **contract-defined** ordering (fixture-backed):

- request-id → recovery → logging → CORS → auth → handler

Size limits:

- Configure with `apptheory.WithLimits(apptheory.Limits{ MaxRequestBytes: ..., MaxResponseBytes: ... })`

Custom middleware (Lift parity):

- Register global middleware with `app.Use(mw)` (applied in registration order: `m1 -> m2 -> handler`).
- Share request-scoped state across middleware + handlers with `ctx.Set(key, value)` / `ctx.Get(key)`.
- Contract-defined built-ins still run in their fixed order; user middleware wraps the final handler stage so it doesn’t
  reorder request-id/auth/CORS invariants.

### 4) Auth and protected routes

Configure the auth hook:

- `apptheory.WithAuthHook(func(ctx *apptheory.Context) (string, error) { ... })`

Require auth per-route:

- `app.Get("/path", handler, apptheory.RequireAuth())`

Semantics:

- If auth is required and identity cannot be established, AppTheory returns `app.unauthorized` (401).

### 5) Request ID and tenant behavior

Request ID:

- Header: `x-request-id`
- If provided, it is propagated; otherwise generated.
- Available to handlers: `ctx.RequestID`

Tenant:

- `x-tenant-id` header, then `tenant` query parameter.
- Available to handlers: `ctx.TenantID`

### 6) Rate limiting (Lift `limited` replacement)

AppTheory ports the `limited` feature set in-repo:

- Package: `github.com/theory-cloud/apptheory/pkg/limited`
- net/http middleware: `github.com/theory-cloud/apptheory/pkg/limited/middleware`

Backing store:

- DynamoDB via **TableTheory** (not DynamORM).

Reference example:

- `examples/migration/rate-limited-http/README.md`

### 6b) EventBus (Lift `pkg/services`) (Autheory)

AppTheory ports the Lift EventBus surface needed by Autheory:

- Lift: `github.com/pay-theory/lift/pkg/services`
- AppTheory: `github.com/theory-cloud/apptheory/pkg/services`

Key mapping:

- `services.NewEvent(...)` → `services.NewEvent(...)`
- `services.NewMemoryEventBus()` → `services.NewMemoryEventBus()` (tests/local)
- `services.NewDynamoDBEventBus(...)` → `services.NewDynamoDBEventBus(...)` (production; TableTheory-backed)

Notes:

- DynamoDB backing uses **TableTheory** (no raw AWS SDK DynamoDB calls).
- Table name can be set via `EventBusConfig.TableName` or env `APPTHEORY_EVENTBUS_TABLE_NAME` (migration-friendly fallbacks
  exist for Autheory deployments).
- Cursor pagination uses `EventQuery.LastEvaluatedKey["cursor"]` and returns `EventQuery.NextKey["cursor"]`.
- `DynamoDBEventBus.Query(...)` requires `TenantID`; `MemoryEventBus.Query(...)` also supports event-type-only queries
  (useful for adapter tests).

### 7) Observability (logs/metrics/traces)

AppTheory’s portable observability surface is hook-based:

- `apptheory.WithObservability(apptheory.ObservabilityHooks{ Log: ..., Metric: ..., Span: ... })`

Portable schema is fixture-backed (see parity matrix and contract tests).

### 8) AWS entrypoints (HTTP)

Contract v0 covers AWS HTTP events:

- Lambda Function URL
- API Gateway v2 (HTTP API)

Go entrypoints:

- `app.ServeLambdaFunctionURL(ctx, events.LambdaFunctionURLRequest)`
- `app.ServeAPIGatewayV2(ctx, events.APIGatewayV2HTTPRequest)`

For local tests:

- Go testkit: `apptheory/testkit` (build synthetic events; invoke adapters).

### 9) AWS entrypoints (REST API v1 + SSE)

REST API v1 (Lambda proxy integration) is supported for Lift parity and SSE endpoints.

Go entrypoint:

- `app.ServeAPIGatewayProxy(ctx, events.APIGatewayProxyRequest)`

SSE responses:

- Use `apptheory.SSEResponse(status, ...events)` (or `apptheory.MustSSEResponse`) to build a properly framed SSE response.
- For API Gateway REST API v1 SSE, enable method-level streaming in infra (see CDK section below).

Event-by-event SSE streaming (no full-body buffering):

- Go: `apptheory.SSEStreamResponse(ctx, status, <-chan apptheory.SSEEvent)`
- TS: `sseEventStream(AsyncIterable<SSEEvent>)` yields framed chunks
- Py: `sse_event_stream(Iterable[SSEEvent])` yields framed chunks

### 10) AWS entrypoints (WebSockets)

Register WebSocket route handlers:

- `app.WebSocket("$connect", handler)`
- `app.WebSocket("$disconnect", handler)`
- `app.WebSocket("$default", handler)`

In handlers, access the WebSocket context:

- `ws := ctx.AsWebSocket()`
- `ws.SendMessage(...)` / `ws.SendJSONMessage(...)`

Go entrypoint:

- `app.ServeWebSocket(ctx, events.APIGatewayWebsocketProxyRequest)`

For local tests:

- Go testkit builder: `testkit.WebSocketEvent(...)`
- Go fake management client: `testkit.NewFakeStreamerClient(endpoint)` + `apptheory.WithWebSocketClientFactory(...)`

### 11) AWS entrypoints (SQS / EventBridge / DynamoDB Streams)

Lift’s “single Lambda router” pattern across non-HTTP triggers maps to explicit registration in AppTheory.

SQS:

- Register: `app.SQS(queueName, handler)`
- Entrypoint: `app.ServeSQS(ctx, events.SQSEvent)`

EventBridge:

- Register by rule: `app.EventBridge(apptheory.EventBridgeRule(ruleName), handler)`
- Or by pattern: `app.EventBridge(apptheory.EventBridgePattern(source, detailType), handler)`
- Entrypoint: `app.ServeEventBridge(ctx, events.EventBridgeEvent)`

DynamoDB Streams:

- Register: `app.DynamoDB(tableName, handler)`
- Entrypoint: `app.ServeDynamoDBStream(ctx, events.DynamoDBEvent)`

For local tests:

- Go testkit builders: `testkit.SQSEvent(...)`, `testkit.EventBridgeEvent(...)`, `testkit.DynamoDBStreamEvent(...)`

### 12) One-entrypoint router (Lift-style)

If your Lift app handled multiple AWS trigger types in a single Lambda, AppTheory provides the same posture via a single
entrypoint:

- Go: `app.HandleLambda(ctx, json.RawMessage)`

This entrypoint routes:

- Lambda URL, API Gateway v2, API Gateway REST v1
- WebSockets (APIGW v2 WebSocket API)
- SQS, EventBridge, DynamoDB Streams

### 13) CDK migration notes (Lift constructs → AppTheory constructs)

AppTheory ships TS-first `jsii` CDK constructs, consumable from Go/TS/Python.

Common Lift construct mappings used by Lesser:

- Lift REST API v1: `LiftRestAPI` → `AppTheoryRestApi` (supports per-method streaming toggles for SSE endpoints)
- Lift schedules: EventBridge rule + Lambda target → `AppTheoryEventBridgeHandler`
- Lift stream mappings: DynamoDB stream event source mapping → `AppTheoryDynamoDBStreamMapping`
- Lift function defaults wrapper: `LiftFunction` → `AppTheoryFunction`
- Lift EventBus table: `EventBusTable` → `AppTheoryEventBusTable` (DynamoDB schema for `pkg/services` EventBus)

## Practical Mapping Table (High-Leverage)

This table is a migration-focused subset. For the broader mapping seed, see:
`docs/development/planning/apptheory/supporting/apptheory-lift-to-apptheory-mapping.md`.

| Lift symbol/pattern | AppTheory equivalent | Notes |
| --- | --- | --- |
| `lift.New()` | `apptheory.New()` | new app/router surface rooted at AppTheory |
| `app.Get("/path", handler)` | `app.Get("/path", handler)` | handler signature changes to portable `*Context` |
| Lift handler funcs | `apptheory.Handler` | `func(*apptheory.Context) (*apptheory.Response, error)` |
| Lift JSON helpers | `ctx.JSONValue()` + `json.Unmarshal` | portable JSON parsing semantics are contract-defined |
| `lift.SSEResponse` / `lift.SSEEvent` | `apptheory.SSEResponse` / `apptheory.SSEEvent` | REST API v1 + SSE helpers |
| Lift `app.Use(...)` + `ctx.Set/Get` | `app.Use(...)` + `ctx.Set/Get` | global middleware pipeline + context value bag |
| Lift `pkg/naming` | `pkg/naming` | deterministic naming helpers (stage/name builders) |
| `app.WebSocket("$connect", handler)` | `app.WebSocket("$connect", handler)` | `ctx.AsWebSocket()` returns `*WebSocketContext` |
| `wsCtx.SendJSONMessage(...)` | `ws.SendJSONMessage(...)` | uses API Gateway Management API via `pkg/streamer` |
| `app.SQS(queue, handler)` | `app.SQS(queue, handler)` | SQS routing by queue name |
| `app.EventBridge(...)` | `app.EventBridge(...)` | match by rule name or by source/detail-type |
| `app.DynamoDB(table, handler)` | `app.DynamoDB(table, handler)` | DynamoDB Streams routing by table name |
| `github.com/pay-theory/limited` | `apptheory/pkg/limited` | replicated feature set; TableTheory-backed |
| Lift `pkg/services` (EventBus) | `apptheory/pkg/services` (EventBus) | Lift-compatible API; DynamoDB implementation uses TableTheory |
| Lift `EventBusTable` (CDK) | `AppTheoryEventBusTable` (CDK) | provisions EventBus DynamoDB table schema + GSIs |
| DynamORM usage | TableTheory | companion data framework for AppTheory |

## Known Differences (Intentional)

- AppTheory is **multi-language contract-first**; behavior is fixture-backed and versioned.
- Some Lift APIs may change for portability and determinism; the guide calls out migration steps rather than promising
  drop-in compatibility.
- TableTheory replaces DynamORM for DynamoDB access in AppTheory work.
- Observability is expressed via portable hooks (provider wiring may remain Go-only initially).

## Automation Helpers

Available now:

- `./scripts/migrate-from-lift-go.sh`:
  - Scope: rewrites `github.com/pay-theory/limited` → `github.com/theory-cloud/apptheory/pkg/limited` (and subpackages)
  - Safe by default: dry-run prints unified diffs
- `cmd/lift-migrate`:
  - Programmatic import rewriting tool (used by the script above)

Planned:

- Additional import rewrites for common Lift package paths (opt-in, diff-based).
- Optional helpers for DynamORM → TableTheory migration where safe.

## Validation Checklist

- Service builds and passes its unit/integration tests.
- End-to-end HTTP behavior matches expected client contracts (error codes/envelopes, CORS/auth behavior).
- Rate limiting behavior matches `limited` semantics where used.
- Deploy templates updated (CDK/examples as needed).

## Representative Migration (G4)

- Example: `examples/migration/rate-limited-http/README.md`
- Lessons learned: `docs/migration/g4-representative-migration.md`
