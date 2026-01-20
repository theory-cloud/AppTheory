# SR-WEBSOCKETS — Lift Parity for API Gateway WebSockets (+ `streamer`)

Goal: AppTheory MUST match Lift’s WebSocket runtime support in **Go/TypeScript/Python**, including:

- `lift.WithWebSocketSupport()` equivalent (enable WebSocket trigger handling)
- `app.WebSocket("$connect" | "$disconnect" | "$default", handler)` equivalents
- `ctx.AsWebSocket()` → WebSocket-specific context for:
  - connection metadata
  - message body parsing
  - sending messages back to the client
- Lift `pkg/streamer` equivalent:
  - `NewClient(...)`
  - `Client.PostToConnection(...)`
  - `Client.GetConnection(...)`
  - `Client.DeleteConnection(...)`

This is required for Lift parity (see `docs/development/planning/apptheory/apptheory-gap-analysis-lesser.md`).

## Scope

- Runtime WebSocket trigger detection + routing
- WebSocket context model (portable shape) and deterministic error behavior
- `streamer` client API and behavior (portable interface; language-specific AWS SDK implementations)
- Strict fakes/mocks for the management client in Go/TS/Py testkits
- Contract fixtures covering trigger parsing + message send behavior
- CDK constructs + examples for deploying WebSocket APIs

Non-goals:

- Higher-level pub/sub helpers from applications (those are app-space; AppTheory provides the runtime + primitives).

## Design requirements (Lift parity constraints)

- Must support the core APIGW WebSocket routes:
  - `$connect`
  - `$disconnect`
  - `$default`
- Must expose (at minimum) the metadata Lift exposes/depends on:
  - `connectionId`
  - `routeKey`
  - `managementEndpoint` (for management API calls)
  - region (when available)
- Must support JSON message send helpers with deterministic behavior on failure.

## Current status (AppTheory `v0.2.0-rc.1`)

- Runtime support exists in Go/TS/Py (route registration, trigger routing, portable WebSocket context, management client).
- Contract fixtures exist and are validated in CI (routing + message send via fakes): `contract-tests/fixtures/m2/`.
- CDK support exists via `cdk/lib/websocket-api.ts` and is exercised in `examples/cdk/multilang`.

## Milestones

### W0 — WebSocket contract + portable context definition

**Acceptance criteria**
- A portable context shape is defined (and added to the parity matrix) including:
  - connection metadata
  - body bytes/text access
  - per-invocation request-id behavior (where applicable)
  - a portable “send message” surface (hookable so tests don’t require AWS)
- Contract fixtures exist for:
  - `$connect` routing
  - `$disconnect` routing
  - `$default` routing

---

### W1 — Go WebSocket runtime + management client

**Acceptance criteria**
- Go runtime routes WebSocket events and provides a WebSocket context.
- Go ships a `streamer`-equivalent client (API Gateway Management API wrapper) with:
  - strict unit tests
  - strict fake for `PostToConnection` / `GetConnection` / `DeleteConnection`

---

### W2 — TypeScript WebSocket runtime + management client

**Acceptance criteria**
- TS runtime routes WebSocket events and provides the same portable context surface.
- TS ships an equivalent management client with strict fakes (no network calls in unit tests).
- TS passes the shared WebSocket contract fixtures.

---

### W3 — Python WebSocket runtime + management client

**Acceptance criteria**
- Py runtime routes WebSocket events and provides the same portable context surface.
- Py ships an equivalent management client with strict fakes (no network calls in unit tests).
- Py passes the shared WebSocket contract fixtures.

---

### W4 — CDK constructs + deployable example

**Acceptance criteria**
- CDK constructs or example templates support deploying a WebSocket API plus:
  - Lambda integrations for `$connect` / `$disconnect` / `$default`
  - required IAM permissions for management API sends
- A multi-language example demonstrates message send behavior end-to-end.
