# SR-STREAMING — Response Streaming (Lambda URL + testkit + contract)

This sub-roadmap tracks the work required for **portable response streaming** in AppTheory, with an initial focus on
**Lambda Function URL** streaming for SSR (FaceTheory) while keeping compatibility with existing buffered handlers and SSE.

Primary dependency: FaceTheory wishlist item “Streaming responses (Lambda Function URL)” in `FaceTheory/docs/WISHLIST.md`.

## Goals

- Define a portable, fixture-testable **streaming response contract**.
- Make streaming a first-class capability in **Go/TypeScript/Python** runtimes (Lambda URL).
- Provide a **streaming-aware testkit** for deterministic chunk assertions across Go/TS/Py.
- Lock down **header/cookie finalize** behavior to avoid drift and footguns.

## Non-goals (initially)

- Timing-based performance assertions in contract tests (TTFB, flush latency).
- Streaming support for every AWS adapter on day 1 (API Gateway v2 / ALB / Lambda URL may differ in constraints).

## Work items

### S1 — Contract extension: streaming bodies + finalize rules

Acceptance:
- Contract specifies:
  - body as bytes OR body as stream-of-bytes
  - chunk encoding rules (binary vs UTF-8 expectations are explicit per helper)
  - when headers/cookies are considered “final”
  - behavior when an error occurs after first chunk
- Fixtures validate:
  - concatenation semantics
  - header immutability after first chunk
  - cookie behavior (`set-cookie`) is deterministic

### S2 — TypeScript: Lambda URL streaming integration

Acceptance:
- TS runtime exposes a supported streaming handler path for Lambda Function URL.
- Streaming supports `text/html` and `text/event-stream`.
- Errors after streaming starts are handled deterministically (contract-backed).

### S2b — Go: Lambda URL streaming integration

Acceptance:
- Go runtime exposes a supported Lambda Function URL streaming entrypoint (true streaming, not buffered-only).
- Streaming supports `text/html` and `text/event-stream`.
- Errors after streaming starts are handled deterministically (contract-backed).

### S2c — Python: Lambda URL streaming integration

Acceptance:
- Python runtime exposes a supported Lambda Function URL streaming entrypoint (true streaming, not buffered-only).
- Streaming supports `text/html` and `text/event-stream`.
- Errors after streaming starts are handled deterministically (contract-backed).

### S3 — Testkit: streamed response capture (Go/TS/Py)

Acceptance:
- Testkits can execute a streaming-capable handler and return:
  - `chunks: Uint8Array[]` (or equivalent)
  - `body: Uint8Array` (concatenated)
  - finalized status/headers/cookies
- Tests can assert “headers finalized before first chunk” as a structural invariant.

### S4 — Cross-language surface: helpers + fallbacks

Acceptance:
- Each language exposes:
  - `htmlStream(...)` (or equivalent) that produces a stream body
  - a consistent type for “stream body” (iterable/generator/channel abstraction)
- Go/Py may initially implement “stream body” by buffering to a single chunk to satisfy contract fixtures, but “full
  alignment” requires true Lambda URL streaming integration in Go/Py (see S2b/S2c).

### S5 — Adapter compatibility matrix

Acceptance:
- A short doc section (in this file or the main FaceTheory enablement roadmap) records per-adapter constraints:
  - API Gateway v2: buffered only today (or limited)
  - Lambda URL: streaming supported
  - ALB: TBD
  - REST v1 + SSE: already supported (ensure no regressions)

Current notes (AppTheory `m14`):

- **Lambda Function URL**
  - TypeScript supports true streaming via `createLambdaFunctionURLStreamingHandler(...)`.
  - Go/Py do not currently ship an AWS adapter that emits streamed chunks; streamed responses are treated as buffered
    when targeting Lambda URL from those runtimes (this is a known parity gap targeted by full alignment work).
- **API Gateway v2 (HTTP API)**: buffered only (no streaming body support today).
- **API Gateway REST v1 (Proxy)**
  - buffered request/response supported
  - SSE streaming supported for `text/event-stream` (do not regress)
- **ALB**: TBD (tracked under FT-A8).
