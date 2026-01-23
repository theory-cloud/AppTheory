# Contract test fixtures

Fixtures are shared, machine-readable test vectors used to prevent cross-language runtime drift.

File layout:

- `contract-tests/fixtures/p0/` — runtime core
- `contract-tests/fixtures/p1/` — context + middleware
- `contract-tests/fixtures/p2/` — portable production features
- `contract-tests/fixtures/m1/` — non-HTTP event sources (SQS/EventBridge/DynamoDB Streams)
- `contract-tests/fixtures/m2/` — API Gateway WebSockets (+ management client fakes)
- `contract-tests/fixtures/m3/` — API Gateway REST v1 (+ SSE)
- `contract-tests/fixtures/m12/` — Lift parity completion extensions (middleware/ctx bag/naming/SSE streaming)
- `contract-tests/fixtures/m14/` — FaceTheory enablement (streaming contract, catch-all routing, SSR helpers)

Each fixture is a single JSON object.

## Common shape

- `id` (string): stable identifier (use `p0.*`, `p1.*`, `p2.*`, `m1.*`, `m2.*`, `m3.*`, `m12.*` prefixes).
- `tier` (string): `p0` / `p1` / `p2` / `m1` / `m2` / `m3` / `m12`.
- `name` (string): short human-friendly name.
- `setup.routes` (array): route table for the fixture runner.
  - `method` (string): HTTP method (e.g. `GET`).
  - `path` (string): route pattern (supports `{param}` segments).
  - `handler` (string): built-in handler name provided by each language runner.
- `setup.middlewares` (array, optional): built-in middleware chain names applied in registration order.
- `setup.limits` (object, optional): guardrails configuration.
  - `max_request_bytes` (number): reject requests over this size with `app.too_large`.
  - `max_response_bytes` (number): reject responses over this size with `app.too_large`.
- `input.request` (object): request presented to the runtime under test.
- `input.context` (object, optional): synthetic invocation context (portable subset).
- `setup.routes[].auth_required` (boolean, optional): whether the route requires auth.
- `expect.response` (object): expected canonical response.
  - `chunks` (array, optional): expected streamed response chunks (when using the streaming test harness).
  - `stream_error_code` (string, optional): expected error code when an error occurs after streaming begins.
- `expect.output_json` (any, optional): expected output value for non-HTTP fixtures (for example: `m1`).
- `expect.error` (object, optional): expected thrown error (for example: fail-closed `m1` routing).
  - `message` (string): error message to match.
- `expect.logs` (array, optional): expected structured log records (P2 portable envelope).
- `expect.metrics` (array, optional): expected metric emissions (portable subset).
- `expect.spans` (array, optional): expected trace span emissions (portable subset).

## Bytes in JSON

Because JSON cannot carry raw bytes, fixtures encode request/response bodies as:

- `body.encoding`: `utf8` or `base64`
- `body.value`: the encoded value

For convenience, expected responses may specify `body_json` (object). When present, runners compare JSON semantics
(ignoring key order) and do not require a specific JSON byte formatting.
