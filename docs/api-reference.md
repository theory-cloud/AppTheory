# AppTheory API Reference

This is the human-readable API overview. The authoritative “no drift” source of truth is the generated snapshots in `api-snapshots/`.

## Source of truth (drift gates)

✅ CORRECT: Treat these as the canonical public surface for review and migrations:
- Go: `api-snapshots/go.txt` (exports from `runtime/`, `pkg/`, and `testkit/`)
- TypeScript: `api-snapshots/ts.txt` (exports from `ts/dist/index.d.ts`)
- Python: `api-snapshots/py.txt` (exports from `py/src/apptheory/__init__.py`)

## Core primitives (shared concepts)

### App container
Problem: you need a single place to register routes/middleware and then serve AWS events.

Solution: use the `App` container in your language runtime:
- Go: `apptheory.New(...)`
- TypeScript: `createApp(...)`
- Python: `create_app(...)`

### Request/Response types
All runtimes use the same conceptual model:
- `Request`: method/path/headers/query/body
- `Response`: status/headers/cookies/body (+ streaming in supported adapters)
- `Context`: per-request helper surface (request id, tenant id, storage via `set/get`, clock, id generator)

### Routing methods
Each runtime exposes method helpers (examples): `get`, `post`, `put`, `delete`, `patch`, `options`, and a lower-level `handle`.

### Middleware
Use middleware to wrap handlers and attach request-scoped values:
- Go: `app.Use(mw)` (where `mw` is `apptheory.Middleware`)
- TypeScript: `app.use(mw)` (async)
- Python: `app.use(mw)` (sync)

### AWS adapters and event sources
AppTheory includes adapters/helpers for:
- HTTP (API Gateway v2, Lambda Function URL, ALB)
- Common event sources (SQS/SNS/Kinesis/EventBridge/DynamoDB Streams)
- WebSockets (event shapes + management client abstraction)

See language-specific docs for the full list and examples.

