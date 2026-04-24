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
  - Timeout fixtures may use cooperative handlers that must observe middleware cancellation before committing
    post-timeout side effects.
- `setup.cors` (object, optional): portable CORS configuration. When `allow_credentials` is `true`, fixtures require explicit `allowed_origins`; omitted allowlists must not reflect origins or emit credentialed CORS headers.
- `setup.limits` (object, optional): guardrails configuration.
  - `max_request_bytes` (number): reject requests over this size with `app.too_large`. When `input.request.is_base64`
    is `true`, this limit applies to the decoded request body bytes.
  - `max_response_bytes` (number): reject responses over this size with `app.too_large`. For streamed responses
    (`expect.response.chunks`), the already-committed status/headers remain intact and the stream terminates with
    `expect.response.stream_error_code = "app.too_large"` once the next streamed chunk would exceed the limit.
- `input.request` (object): request presented to the runtime under test.
  - `headers` keys are canonicalized to lowercase but otherwise treated as ordinary header names, including
    prototype-like keys such as `constructor` and `__proto__`.
- `input.context` (object, optional): synthetic invocation context (portable subset).
- `setup.routes[].auth_required` (boolean, optional): whether the route requires auth.
- `expect.response` (object): expected canonical response.
  - `chunks` (array, optional): expected streamed response chunks (when using the streaming test harness).
  - `stream_error_code` (string, optional): expected error code when an error occurs after streaming begins.
- `expect.output_json` (any, optional): expected output value for non-HTTP fixtures (for example: `m1`).
  - For AppSync fixtures, portable AppTheory/AppError payloads retain their intended messages, while non-portable
    exceptions must surface the generic `internal error` message.
- `expect.error` (object, optional): expected thrown error (for example: fail-closed `m1` routing).
  - `message` (string): error message to match.
- `expect.logs` (array, optional): expected structured log records (P2 portable envelope).
- `expect.metrics` (array, optional): expected metric emissions (portable subset).
- `expect.spans` (array, optional): expected trace span emissions (portable subset).


## M1 EventBridge workload envelope fixtures

EventBridge workload fixtures pin the portable non-HTTP envelope before runtime helpers are exported. Runners must preserve the existing AppTheory dispatch path: an unmatched EventBridge event returns JSON `null`, not an alternate error path. Matching workload fixtures use these built-in runner handlers only to express the contract:

- `eventbridge_workload_envelope`: returns a normalized, safe envelope summary containing `event_id`, `source`, `detail_type`, `account`, `region`, `time`, `resources`, `request_id`, `correlation_id`, and `correlation_source`.
- `eventbridge_require_workload_envelope`: returns the same summary only when the workload envelope is valid; missing required envelope identity fails closed with `apptheory: eventbridge workload envelope invalid`.

The canonical correlation precedence is:

1. `event.metadata.correlation_id`
2. `event.headers["x-correlation-id"]` (case-insensitive header name; scalar or first non-empty list value)
3. `event.detail.correlation_id`
4. EventBridge `event.id`
5. Lambda context `awsRequestId` / fixture `input.context.aws_request_id`

`input.context.aws_request_id` is the portable fixture spelling for a Lambda invocation request ID. It may be paired with `input.context.remaining_ms` when a non-HTTP fixture needs deterministic remaining-time behavior.

## Bytes in JSON

Because JSON cannot carry raw bytes, fixtures encode request/response bodies as:

- `body.encoding`: `utf8` or `base64`
- `body.value`: the encoded value

For convenience, expected responses may specify `body_json` (object). When present, runners compare JSON semantics
(ignoring key order) and do not require a specific JSON byte formatting.
