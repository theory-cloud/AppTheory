# SR-SSE — Lift Parity for API Gateway REST API v1 + SSE (Response Streaming)

Goal: AppTheory MUST match Lift’s support for:

- API Gateway **REST API v1** request/response events (Lambda proxy integration)
- Server-Sent Events (SSE) helpers:
  - `SSEEvent` model (id/event/data framing)
  - `SSEResponse` helper that emits properly framed SSE output
- Response streaming (where supported by AWS for REST API v1) to support long-lived SSE connections.

This is required for Lift parity (see `docs/development/planning/apptheory/apptheory-gap-analysis-lesser.md`).

## Scope

- REST API v1 adapter(s) in Go/TS/Py:
  - canonical request normalization
  - canonical response serialization
- Streaming response support for SSE in Go/TS/Py:
  - stable framing rules
  - deterministic behavior for keepalives and termination
- Contract fixtures for:
  - REST v1 normalization
  - SSE framing and headers
- CDK support for REST API v1 + method-level streaming enablement (Lift `LiftRestAPI` parity)

Non-goals:

- Replacing API Gateway v2 HTTP APIs; both v1 and v2 must be supported (Lift parity requires both).

## Design requirements (Lift parity constraints)

- REST v1 adapter MUST be supported alongside existing HTTP adapters (Lambda URL, APIGW v2).
- SSE helper MUST produce compliant framing:
  - `id: ...`
  - `event: ...`
  - `data: ...` (multi-line rules must be specified)
  - blank-line terminator between events
- SSE response MUST set required headers (at minimum):
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive` (where applicable)

## Current status (AppTheory `v0.2.0-rc.1`)

- REST API v1 adapter exists.
- SSE framing helpers exist.
- REST API v1 **streaming response type** support exists for `text/event-stream`.
- Missing for full Lift parity: an event-by-event “true streaming” SSE API (Lift uses `SSEResponse(ctx, <-chan SSEEvent)`
  and streams via a pipe/reader rather than buffering the entire body).

## Milestones

### S0 — REST v1 adapter parity (non-streaming)

**Acceptance criteria**
- Go/TS/Py can accept REST API v1 events and normalize them into the canonical request model.
- Go/TS/Py can serialize canonical responses back to REST API v1 response shapes deterministically.
- Contract fixtures cover REST v1 normalization edge cases (headers/cookies/query/base64).

---

### S1 — SSE framing contract + helpers

**Acceptance criteria**
- A portable SSE event framing spec exists and is fixture-tested.
- Go/TS/Py expose an SSE helper API that:
  - accepts events
  - streams them with correct framing and headers
  - can be tested without AWS

---

### S2 — Response streaming integration (Lambda → APIGW REST v1)

**Acceptance criteria**
- Go/TS/Py implementations can stream SSE responses using AWS-supported response streaming for REST API v1.
- CDK constructs/examples enable streaming at the API/method level (Lift `LiftRestAPI` parity).
- A deployable example demonstrates an SSE endpoint end-to-end.

---

### S3 — Event-by-event SSE streaming API (Lift parity)

**Acceptance criteria**
- Go/TS/Py expose an API that can stream multiple SSE events over time without buffering the full response in memory.
- Fixture coverage exists for framing/headers; example coverage exists for long-lived streaming behavior.
