# Contract test fixtures

Fixtures are shared, machine-readable test vectors used to prevent cross-language runtime drift.

File layout is organized by behavior domain. The historical tier/milestone label remains inside each fixture's
`tier` metadata and fixture `id`; directory names are not the contract identifier.

- `contract-tests/fixtures/http-core/` — P0 runtime core: routing, normalization, errors, source provenance, Lambda URL/ALB adapters
- `contract-tests/fixtures/middleware-guardrails/` — P1 request-id, tenant, auth, CORS, guardrails, and legacy flat-error behavior
- `contract-tests/fixtures/appsync-observability-policies/` — P2 AppSync, observability, logging profiles, rate-limit, and load-shed behavior
- `contract-tests/fixtures/event-sources/` — M1 SQS, EventBridge, DynamoDB Streams, Kinesis, SNS, and non-HTTP middleware behavior
- `contract-tests/fixtures/websockets/` — M2 API Gateway WebSockets and management client fakes
- `contract-tests/fixtures/api-gateway-rest-sse/` — M3 API Gateway REST v1, Remote MCP path normalization, and SSE
- `contract-tests/fixtures/middleware-timeout-sse/` — M12 middleware ctx bag, timeout, naming, and SSE streaming extensions
- `contract-tests/fixtures/edge-streaming-html/` — M14 streaming, catch-all routing, HTML/cache/CloudFront helpers, and Step Functions helpers
- `contract-tests/fixtures/microvm-foundation/` — M15 Lambda MicroVM validation-only lifecycle/controller/session vocabulary
- `contract-tests/fixtures/microvm-operations/` — M16 real Lambda MicroVM operation, route, provider-state, tenant, and token-safety contracts
- `contract-tests/fixtures/openapi/` — P0 descriptive OpenAPI generation with byte-pinned canonical JSON output

Each fixture is a single JSON object.

## Schema gate

`fixture.schema.json` is the internal meta-contract for fixture files. The gate validates every checked-in fixture
with `./scripts/verify-fixture-schema.sh`, then runs an in-memory negative self-test to prove a malformed fixture
(missing required envelope fields) is rejected. The schema is strict for the shared fixture envelope and section keys,
while provider/runtime payload objects remain open so behavior-specific contracts can stay in their fixtures.


## Common shape

- `id` (string): stable identifier (use `p0.*`, `p1.*`, `p2.*`, `m1.*`, `m2.*`, `m3.*`, `m12.*`, `m14.*`, `m15.*`, or `m16.*` prefixes).
- `tier` (string): `p0` / `p1` / `p2` / `m1` / `m2` / `m3` / `m12` / `m14` / `m15` / `m16`.
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
  - OpenAPI fixtures use a string value containing the exact canonical JSON bytes emitted by the generator.
  - For AppSync fixtures, portable AppTheory/AppError payloads retain their intended messages, while non-portable
    exceptions must surface the generic `internal error` message.
- `expect.error` (object, optional): expected thrown error (for example: fail-closed `m1` routing).
  - `message` (string): error message to match.
- `expect.logs` (array, optional): expected structured log records (P2 portable envelope).
- `expect.profile_logs` (array, optional): expected structured JSON log objects emitted by a configured
  AppTheory logging profile.
- `expect.profile_validation_errors` (array, optional): expected fail-closed validation errors for an invalid
  AppTheory logging profile config.
- `expect.logging_profile_catalog` (object, optional): expected built-in logging profile catalog.
- `expect.metrics` (array, optional): expected metric emissions (portable subset).
- `expect.spans` (array, optional): expected trace span emissions (portable subset).


## HTTP source provenance fixtures

HTTP source provenance fixtures pin the portable, provider-derived source metadata exposed to handlers and middleware
in every HTTP tier, including P0. The structured public API name is `SourceProvenance` and the convenience accessor
name is `SourceIP` (both with language-idiomatic casing); `RequestSource` is not used for this capability. The
runner-only handler `source_provenance` returns both the convenience source IP accessor and the structured provenance
object:

```json
{
  "source_ip": "198.51.100.77",
  "source_provenance": {
    "source_ip": "198.51.100.77",
    "provider": "apigw-v2",
    "source": "provider_request_context",
    "valid": true
  }
}
```

The contract is provider-derived only. Runtimes must not parse, trust, or expose `Forwarded`, `X-Forwarded-For`,
or any other forwarded-chain header through this provenance API. Those headers remain ordinary request headers for
product-local policy code.

Valid provider sources are:

- API Gateway HTTP API v2: `requestContext.http.sourceIp`, with `provider = "apigw-v2"`.
- Lambda Function URL: `requestContext.http.sourceIp`, with `provider = "lambda-url"`.
- API Gateway REST API v1: `requestContext.identity.sourceIp`, with `provider = "apigw-v1"`.

A valid provider source uses `source = "provider_request_context"` and `valid = true`. Direct/synthetic requests and
missing or malformed provider source values return an empty source IP with `provider = "unknown"`, `source = "unknown"`,
and `valid = false`; request normalization must continue rather than failing the request. ALB source provenance is
intentionally out of scope for this contract pass.


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


## M1 scheduled workload fixtures

Scheduled workload fixtures are EventBridge fixtures with `source = "aws.events"` and `detail-type = "Scheduled Event"`. The built-in runner handler `eventbridge_scheduled_summary` pins the portable result summary shape used by later runtime helpers:

- `kind`: always `scheduled`.
- `run_id`: `detail.run_id`, then EventBridge `id`, then Lambda `awsRequestId`.
- `idempotency_key`: `detail.idempotency_key`, then `eventbridge:<event.id>`, then `lambda:<awsRequestId>`.
- `correlation_id` / `correlation_source`: the EventBridge workload precedence above.
- `remaining_ms`: the portable remaining invocation time from `input.context.remaining_ms`.
- `deadline_unix_ms`: fixed runner clock (`1970-01-01T00:00:00Z`) plus `remaining_ms`, or `0` when no remaining time is available.
- `result`: a structured object with `status`, `processed`, and `failed`; missing counts default to `0`, and missing status defaults to `ok`.


## M1 DynamoDB Streams normalization fixtures

DynamoDB stream normalization fixtures keep the runtime contract on the partial-batch response path while pinning the safe record summary a handler must be able to derive. The runner-only handlers `ddb_require_normalized_summary` and `ddb_require_normalized_summary_fail_on_remove` validate these portable fields for each record before returning the normal DynamoDB `batchItemFailures` response:

- `table_name`: parsed from `eventSourceARN`.
- `event_id`: `eventID`.
- `event_name`: `eventName`.
- `sequence_number`: `dynamodb.SequenceNumber`.
- `size_bytes`: `dynamodb.SizeBytes`.
- `stream_view_type`: `dynamodb.StreamViewType`.
- `safe_log`: a summary composed only from table/event/sequence metadata; raw `Keys`, `NewImage`, and `OldImage` values are not included.

The partial-failure fixture intentionally fails only the `REMOVE` record after summary validation, proving the existing per-record retry behavior remains intact while the normalized summary contract grows.


## M1 Kinesis CloudWatch Logs subscription fixtures

Kinesis CloudWatch Logs subscription fixtures keep the runtime contract on the existing Kinesis partial-batch response
path while pinning the portable decoder contract that later runtime work must expose. The runner-only handler
`kinesis_require_cloudwatch_logs_subscription` represents the future runtime helper and records expectations under
`expect.cloudwatch_logs_subscription.records`:

- Valid records contain gzip-compressed CloudWatch Logs subscription JSON in `kinesis.data` and must decode to
  `message_type`, `owner`, `log_group`, `log_stream`, `subscription_filters`, and ordered `log_events`.
- Malformed records use `decode_error = true`; decoding them must fail closed for that record without broadening the
  failure to neighboring valid records.
- `safe_summary` pins the safe metadata a handler may log: record/log identity and counts only. Values listed in
  `forbidden_safe_log_substrings` are raw log event messages and must not appear in the safe summary.

The runner handler is intentionally narrow: it should call the runtime decoder and compare the result to the fixture
expectations. It must not grow a runner-local alternate decoder that bypasses the runtime contract.
The runners also validate expectation hygiene before invoking the runtime path: every Kinesis input record must have
exactly one `record_id` expectation, malformed records must be explicit `decode_error` expectations, and extra expected
records fail the fixture instead of being ignored.


## M1 non-HTTP observability and safe error fixtures

Non-HTTP observability fixtures use the existing `expect.logs`, `expect.metrics`, and `expect.spans` fixture fields for event workloads. Event log records keep the HTTP fields present but empty/zero and add event dimensions for the non-HTTP trigger:

- EventBridge effects include `trigger = "eventbridge"`, `correlation_id`, `source`, and `detail_type`.
- DynamoDB Streams effects include `trigger = "dynamodb_stream"`, `correlation_id` (the stream `eventID`), `table_name`, `event_id`, and `event_name`.
- Metrics use the portable name `apptheory.event` with tags for `trigger`, correlation identity, outcome, and error code.
- Spans use trigger-specific names and attributes; raw event details, DynamoDB keys, and image values are not emitted.

The safe-panic fixture pins the posture for non-HTTP handler panics/errors: observability records carry `error_code = "app.internal"`, while the surfaced error is the safe message `apptheory: event workload failed`.

## P2 logging profile fixtures

Logging profile fixtures pin the additive `apptheory.logging/v1` contract. They do not introduce a second
observability path: profile-backed logging is the configured encoder/logger behavior for the existing P2
observability surface.

The contract-owned pieces are:

- Profile schema version: `apptheory.logging/v1`.
- Built-in profile names, sorted canonically: `cloudwatch-json`, `legacy`, `local-dev`, `paytheory-alert-v1`.
- Encoding defaults and validation for JSON output.
- Strict profile config decoding: unsupported top-level or nested profile options fail closed.
- Required and recommended field validation.
- Field mapping from canonical AppTheory log event fields to profile output fields.
- Static/env enrichment and request/job context enrichment.
- Error type, error code, optional stack trace, and deterministic stack hash capture.
- Sanitization-preserving behavior: profile fixtures may include safe structured fields, but raw payload fields must
  not appear in `expect.profile_logs`. Caller-provided fields must not overwrite profile-owned fields such as
  timestamp, level, message, or static enrichment values.

`setup.logging_profile` carries the profile config under test. `setup.environment` supplies deterministic values for
`${ENV_VAR}` placeholders used by profile enrichment. `input.logging_event` is a synthetic canonical log event used by
contract runners to exercise profile encoding without depending on a real provider backend.

`expect.profile_logs` contains the exact structured JSON objects the profile must emit. For `paytheory-alert-v1`,
the fixture requires enough context for alert-decisioner and Keeper lookup: partner, stage, account family, AWS region,
service, function, request ID, trace ID, error type/code, stack hash, and normalized message.

Validation-only fixtures use `expect.profile_validation_errors` and may omit `input.request`; runtimes must fail
closed with deterministic validation messages for unsupported schema versions, profile names, encodings, config options,
field names, context sources, or stack hash algorithms.

## M15 Lambda MicroVM contract-foundation fixtures

M15 fixtures pin the additive `apptheory.lambda_microvm` / `m15.microvm/v1` contract vocabulary before runtime or CDK
implementation work. They are validation-only fixtures: passing them proves the lifecycle/controller/session vocabulary is
parseable and fail-closed, not that a deployable MicroVM surface exists.

The lifecycle fixture requires the hooks `prepare_image`, `start`, `readiness`, `stop`, `teardown`, and `failure`; the
portable states include image-preparation, start, readiness, stop, teardown, `terminated`, and `failed` states. The
controller/session fixture requires `create`, `start`, `stop`, `status`, and `session` command envelopes with `command`,
`request_id`, `tenant_id`, and `auth_context` fields, plus TableTheory-patterned durable session-record guidance.

Denial fixtures intentionally describe invalid contracts and expect the runners to reject them with deterministic error
codes for raw AWS SDK escape hatches, raw lifecycle hook bypasses, and unauthenticated controller defaults. Later MicroVM
runtime and CDK milestones must grow from these fixtures; they must not introduce raw AWS SDK escape hatches or private
lifecycle-hook bypasses.

## M16 real Lambda MicroVM operation fixtures

M16 fixtures replace the evidence-only M15 controller vocabulary with the real `apptheory.lambda_microvm` /
`m16.microvm/v1` operation contract. They are still contract fixtures, not a live AWS provider adapter: they pin the
truth later provider/controller milestones must implement.

The operation fixture requires the canonical operation names `run`, `get`, `list`, `suspend`, `resume`, `terminate`,
`auth-token`, and `shell-token`. Each operation has one authenticated, default-deny, tenant-bound HTTP route. The `list`
route also carries tenant-bound recovery semantics; fixtures reject any rule that allows one tenant/namespace to list,
recover, or fetch another binding's session.

The lifecycle fixture uses real provider-oriented hooks (`validate`, `run`, `ready`, `suspend`, `resume`, `terminate`,
and `failure`) and real states such as `running`, `suspending`, `suspended`, `resuming`, and `terminating`. Synthetic
M15 `start`/`stop` lifecycle hooks are not valid in the M16 real lifecycle contract. Provider-state mappings pin the
minimum AWS adapter vocabulary needed by later milestones.

Token fixtures allow `auth-token` and `shell-token` only as sanitized issuance metadata: `token_id`, `token_type`,
`expires_at`, and `scope`. Plaintext bearer/session token fields, raw AWS credentials, raw SDK clients, provider
secrets, lifecycle payloads, and generated secrets must never appear as records, metadata, errors, logs, or response
fields. Denial fixtures keep raw SDK escape hatches, lifecycle bypasses, unauthenticated routes, cross-tenant recovery,
and token leak fields fail-closed.



## Bytes in JSON

Because JSON cannot carry raw bytes, fixtures encode request/response bodies as:

- `body.encoding`: `utf8` or `base64`
- `body.value`: the encoded value

For convenience, expected responses may specify `body_json` (object). When present, runners compare JSON semantics
(ignoring key order) and do not require a specific JSON byte formatting.
