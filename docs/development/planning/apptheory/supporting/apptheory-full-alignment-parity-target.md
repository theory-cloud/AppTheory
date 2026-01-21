# Full Alignment: M0 Parity Target (Surface Inventory + Canonical Superset)

This document is the deliverable for **M0** in:

- `docs/development/planning/apptheory/apptheory-full-alignment-roadmap.md`

Goal: make the “union-of-capabilities” parity target precise enough that subsequent milestones (parity gate, fixtures,
testkits, ports) are implementable without “lowest rung” compromises.

Decisions (frozen):

- TypeScript uses **real AWS SDK dependencies** (v3) for AWS clients + credential/provider behavior.
- Parity means **identical behavior** with **idiomatic naming** per language.

## Public surface inventory (today)

This is the inventory of public surfaces used to define the parity target and to later build a drift gate.

### Go (repo root)

Portable runtime (contract-backed):

- `runtime/` (`github.com/theory-cloud/apptheory/runtime`)
  - App container + routing + middleware pipeline
  - HTTP adapters (Lambda URL, APIGW v2, APIGW v1 proxy, ALB)
  - non-HTTP event routing (SQS/Kinesis/SNS/EventBridge/DynamoDB streams)
  - WebSocket trigger routing + WebSocket context
  - SSE helpers (REST v1 streaming)
  - streaming primitives (`BodyStream`, `CaptureBodyStream`, `HTMLStream`)
- `testkit/` (`github.com/theory-cloud/apptheory/testkit`)
  - deterministic `Env` (clock + IDs)
  - event builders + invokers for all supported triggers
  - streamed-response capture for tests

Go application packages (not part of the runtime contract; parity targets under full alignment):

- `pkg/services` (`github.com/theory-cloud/apptheory/pkg/services`) — EventBus (memory + DynamoDB, currently Go-only)
- `pkg/limited` (`github.com/theory-cloud/apptheory/pkg/limited`) — DynamoDB-backed rate limiter (currently Go-only)
- `pkg/limited/middleware` — net/http middleware adapter (migration-only; not portable)
- `pkg/streamer` (`github.com/theory-cloud/apptheory/pkg/streamer`) — API Gateway WebSocket Management API client
- `pkg/observability`, `pkg/observability/zap` — Go-only logger implementations layered on portable hooks
- `pkg/naming`, `pkg/sanitization` — helper packages (already portable in runtime contract/fixtures)

### TypeScript (`ts/`)

Public surface (single published package):

- `ts/dist/index.d.ts` — canonical TS API surface for parity gates.

Core runtime and testkit (contract-backed) exports include:

- `App`, `Context`, `EventContext`, `WebSocketContext`
- middleware, routing, and AWS trigger serving entrypoints
- deterministic `TestEnv` and trigger builders
- Lambda Function URL **streaming handler entrypoint**: `createLambdaFunctionURLStreamingHandler(app)`
- WebSocket management client:
  - `WebSocketManagementClient` (production)
  - `FakeWebSocketManagementClient` (tests)

Known gaps (not exported today; parity targets under full alignment):

- EventBus (memory + DynamoDB)
- DynamoDB-backed rate limiter (`limited`)

### Python (`py/`)

Public surface (single published package):

- `py/src/apptheory/__init__.py` and its `__all__` — canonical Py API surface for parity gates.

Core runtime and testkit (contract-backed) exports include:

- `App`, `Context`, `EventContext`, `WebSocketContext`
- middleware, routing, and AWS trigger serving entrypoints
- deterministic `TestEnv` and trigger builders
- WebSocket management client:
  - `apptheory.streamer.Client` (production, boto3-backed)
  - `FakeWebSocketManagementClient` / `FakeWebSocketClientFactory` (tests)

Known gaps (not exported today; parity targets under full alignment):

- EventBus (memory + DynamoDB)
- DynamoDB-backed rate limiter (`limited`)
- Lambda Function URL **response streaming entrypoint** (true streaming)

## Canonical superset (the parity target)

The canonical superset is the “highest rung” behavior per area. Each subsection below defines:

- the behavior that must match across Go/TS/Py, and
- the expected public surface in each language (idiomatic naming allowed).

### 1) EventBus parity (services)

Source of truth today: Go implementation in `pkg/services/`.

#### Required behavior (portable)

- Event publishing
  - `Publish` is idempotent by primary key; condition-failed on create is treated as success.
  - Event IDs are stable (caller-provided ID preserved; helper generates time-sortable IDs).
- Querying
  - tenant-wide queries and tenant+event-type queries
  - time range filtering
  - tag filtering (logical AND; each tag requires `CONTAINS`)
  - ordering: newest-first (descending)
  - pagination via Lift-compatible cursor shape:
    - `query.last_evaluated_key["cursor"]` as input
    - `query.next_key["cursor"]` as output (opaque string)
- Get/Delete
  - `GetEvent` retrieves by event ID (not by tenant/type)
  - `DeleteEvent` removes an event by ID
- Table naming
  - table name resolution matches Go env var behavior:
    - `APPTHEORY_EVENTBUS_TABLE_NAME`
    - fallbacks: `EVENTBUS_TABLE_NAME`, `AUTHEORY_EVENTBUS_TABLE_NAME`, `AUTHEORY_TABLE_NAME` (suffix `-events`)
- Metrics hooks (portable behavior)
  - enable/disable behavior is consistent
  - metric names + tags are stable (cross-language fixtures target this)

#### DynamoDB schema compatibility (required)

The DynamoDB table schema must be compatible across languages to support migrations and debugging:

- primary key: `PartitionKey` + `SortKey`
  - `PartitionKey = "{tenant_id}#{event_type}"`
  - `SortKey = "{published_at_unix_nanos}#{event_id}"`
- GSI: `tenant-timestamp-index` (`TenantID` pk, `PublishedAt` sk)
- GSI: `event-id-index` (`ID` pk)
- `Tags` stored as a DynamoDB string set (or equivalent) to support `CONTAINS`
- TTL attribute: `ttl` (unix seconds)

Cursor encoding targets:

- Memory EventBus cursor: base64url **raw** encoding of a decimal offset string (matches Go `MemoryEventBus`).
- DynamoDB EventBus cursor: TableTheory cursor format:
  - base64url encoding (with padding) of JSON:
    - `{"lastKey":{...},"index":"...","sort":"DESC|ASC"}`
  - DynamoDB attribute values encoded as single-key objects (`{"S":"..."}`, `{"N":"..."}`, `{"B":"..."}`, etc)
  - canonical reference: `TableTheory/pkg/query/cursor.go`

#### Expected public surface (idiomatic)

- Go: `pkg/services`
  - `EventBus`, `Event`, `EventQuery`, `EventBusConfig`, `MetricRecord`
  - `NewMemoryEventBus()`, `NewDynamoDBEventBus(db, config)`, `DefaultEventBusConfig()`
  - `NewEvent(...)` + fluent helpers (`WithTTL`, `WithMetadata`, `WithTags`, `WithCorrelationID`)
- TypeScript: exported from `ts/dist/index.d.ts` (module layout is flexible)
  - `EventBus` interface + `MemoryEventBus` + `DynamoDBEventBus` (or factory equivalents)
  - `Event`, `EventQuery`, config + metric hook types
  - uses AWS SDK v3 for DynamoDB
- Python: exported from `apptheory` (module layout is flexible)
  - `EventBus` protocol/ABC + `MemoryEventBus` + `DynamoDBEventBus`
  - `Event`, `EventQuery`, config + metric hook types
  - uses `boto3` for DynamoDB

### 2) `limited` parity (DynamoDB-backed rate limiter)

Source of truth today: Go implementation in `pkg/limited/`.

#### Required behavior (portable)

- Strategies
  - fixed window
  - sliding window (granularity-defined subwindows)
  - multi-window (e.g., N/min AND M/hour) and its “earliest reset” semantics
- DynamoDB keying + TTL semantics compatible with Go:
  - `PK = "{identifier}#{window_start_unix_seconds}"`
  - `SK = "{resource}#{operation}"`
  - `TTL = window_end_unix_seconds + ttl_buffer_seconds` (configurable in Go via `TTLHours`)
- Atomic check-and-increment semantics
  - single-window uses conditional update (`Count < limit`) where supported
  - multi-window uses transactional updates where supported; otherwise a documented fallback is used
- Fail-open behavior (configurable)
  - on DynamoDB errors, allow request when `fail_open=true`
  - “fail-open” outcomes are observable and testable (headers/decision shape)
- Deterministic time
  - each language can run the same decision tests with a deterministic clock

#### Expected public surface (idiomatic)

- Go: `pkg/limited` (core), plus net/http adapter in `pkg/limited/middleware`
- TypeScript: exported from `ts/dist/index.d.ts`
  - `RateLimiter` / `AtomicRateLimiter`, strategies, config, and a DynamoDB-backed implementation
  - an AppTheory runtime `Middleware` factory for rate limiting (idiomatic TS integration)
  - uses AWS SDK v3 for DynamoDB
- Python: exported from `apptheory`
  - `RateLimiter` protocol, strategies, config, DynamoDB-backed implementation
  - an AppTheory runtime middleware equivalent (idiomatic Py integration)
  - uses `boto3` for DynamoDB

### 3) Lambda Function URL response streaming parity

Parity target: TypeScript Lambda URL streaming entrypoint (already shipped).

#### Required behavior (portable)

- Header/cookie finalization: headers and cookies are considered final **before the first chunk is emitted**.
- Chunk emission: chunks are emitted in-order; empty chunks are allowed and preserved.
- Late errors: an error after streaming begins produces deterministic behavior and a deterministic “stream error code”
  in tests (AWS runtime behavior is constrained; tests validate the portable contract).
- Content types: support SSR HTML and SSE:
  - `text/html; charset=utf-8`
  - `text/event-stream; charset=utf-8`

#### Expected public surface (idiomatic)

- TypeScript: `createLambdaFunctionURLStreamingHandler(app)` (already shipped)
- Go: a Lambda URL streaming handler based on `aws-lambda-go` streaming support:
  - AWS type: `events.LambdaFunctionURLStreamingResponse`
  - reference: `aws-lambda-go/lambdaurl.Wrap` (requires Function URL `InvokeMode: RESPONSE_STREAM`)
- Python: a Lambda URL streaming handler for Python’s response streaming runtime support (or a documented custom-runtime
  approach if managed runtime constraints require it)

### 4) WebSocket management client credential/provider parity (AWS SDK quality)

Goal: align TS behavior to the same quality bar as Go (`aws-sdk-go-v2`) and Python (`boto3`).

#### Required behavior (portable)

- Endpoint normalization
  - accept `ws://`, `wss://`, `http://`, `https://`, and bare domain; normalize to `http(s)://...`
- Region resolution
  - explicit region option overrides everything
  - otherwise resolve from standard AWS region sources (env/config)
  - if missing, optionally infer from `*.execute-api.{region}.amazonaws.com` when possible (documented)
- Credentials/provider chain
  - use the standard provider chain (not env-only) in production
  - allow explicit credential override for tests and special environments
- Deterministic failure semantics (fixture-backed in full alignment)
  - missing endpoint
  - missing region (when not inferable)
  - missing credentials

#### Expected public surface (idiomatic)

- Go: `pkg/streamer.NewClient(...)` (already uses `awsconfig.LoadDefaultConfig`)
- TypeScript: `WebSocketManagementClient` backed by AWS SDK v3 (replacing env-only + custom SigV4)
- Python: `apptheory.streamer.Client` (already boto3-backed)

