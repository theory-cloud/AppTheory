---
title: API Reference
---

# AppTheory API Reference

This page is the canonical human-readable map of the AppTheory surface. Treat the generated snapshots as the
release-gated source of truth, and use this document to understand which surface to reach for.

## Source of truth

Use these files when reviewing or documenting external interfaces:

- Go: `api-snapshots/go.txt` (exports from `runtime/`, `pkg/`, and `testkit/`)
- TypeScript: `api-snapshots/ts.txt` (exports from `ts/dist/index.d.ts`)
- Python: `api-snapshots/py.txt` (exports from `py/src/apptheory/__init__.py` and `py/src/apptheory/limited/__init__.py`)
- CDK: `cdk/.jsii`, `cdk/lib/index.ts`, and `cdk/lib/*.d.ts`

Known CLI surface:

- `cmd/lift-migrate` exists as a Go migration helper with `-root` and `-apply` flags
- `./scripts/migrate-from-lift-go.sh` is the repo wrapper for `go run ./cmd/lift-migrate`
- `UNKNOWN:` no broader stable public CLI contract is documented for `cmd/`

Verification command surface:

- `make test-unit`
- `./scripts/verify-ts-tests.sh`
- `./scripts/verify-python-tests.sh`
- `./scripts/verify-contract-tests.sh`
- `./scripts/update-api-snapshots.sh`
- `./scripts/verify-api-snapshots.sh`
- `./scripts/verify-docs-standard.sh`
- `make rubric`

Security migration note:

- For new closed-default HTTP, AppSync, and WebSocket applications, see
  [SecureApp Closed-Default Routing](./features/secure-app.md).
- For consolidated v1.0 fail-closed migration guidance across the surfaces documented here, see
  `docs/migration/v1-security.md`.

## Core runtime entrypoints

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| Secure app container | `apptheory.NewSecure(SecureOptions{...})` | `new SecureApp({...})` | `SecureApp(...)` |
| Legacy app container | `apptheory.New(...)` | `createApp()` | `create_app()` |
| Deterministic test env | `testkit.New()` | `createTestEnv()` | `create_test_env()` |
| Universal Lambda dispatcher | `app.HandleLambda(ctx, event)` | `app.handleLambda(event, ctx)` | `app.handle_lambda(event, ctx)` |
| AppSync resolver entrypoint | `app.ServeAppSync(ctx, event)` | `app.serveAppSync(event, ctx)` | `app.serve_appsync(event, ctx)` |
| Strict route registration | `app.GetStrict(...)`, `app.HandleStrict(...)` | `app.handleStrict(...)` | `app.handle_strict(...)` |
| HTTP entrypoints | `ServeAPIGatewayV2`, `ServeLambdaFunctionURL`, `ServeAPIGatewayProxy` | `serveAPIGatewayV2`, `serveLambdaFunctionURL`, `serveAPIGatewayProxy` | `serve_apigw_v2`, `serve_lambda_function_url`, `serve_apigw_proxy` |
| Streaming helpers | `SSEResponse`, `SSEStreamResponse` | `htmlStream`, `sseEventStream`, `createLambdaFunctionURLStreamingHandler` | `html_stream`, `sse_event_stream` |

Shared request model:

- `Request`: method, path, headers, query, body, and normalized source provenance
- `Response`: status, headers, cookies, body, and streaming fields where supported
- `Context`: request-scoped accessors for headers, params, request ID, tenant, source provenance, clock, IDs, and
  middleware state

Common helper exports:

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| App creation | `apptheory.New(...)` | `createApp()` | `create_app()` |
| Deterministic HTTP builders | `testkit.APIGatewayV2Request`, `testkit.LambdaFunctionURLRequest` | `buildAPIGatewayV2Request`, `buildLambdaFunctionURLRequest` | `build_apigw_v2_request`, `build_lambda_function_url_request` |
| Deterministic AppSync builders | `testkit.AppSyncEvent` | `buildAppSyncEvent` | `build_appsync_event` |
| Basic response helpers | `Text`, `JSON`, `Binary` | `text`, `json`, `html`, `binary`, `sse` | `text`, `json`, `html`, `binary`, `sse` |

### SecureApp semantic API map

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| Closed options | `SecureOptions` | `SecureOptions` | explicit `SecureApp(...)` keywords |
| Postures | `Public`, `Optional`, `Authenticated`, `AuthenticatedAnyOf`, `InternalOnly` | `Public`, `Optional`, `Authenticated`, `AuthenticatedAnyOf`, `InternalOnly` | `public`, `optional`, `authenticated`, `authenticated_any_of`, `internal_only` |
| Principal | `SecurePrincipal`, `PrincipalKind` | `SecurePrincipal`, `PrincipalKind` | `SecurePrincipal`, `PrincipalKind` |
| Resolver | `SecurePrincipalResolver` | `SecurePrincipalResolver` | `SecurePrincipalResolver` |
| Context accessor | `ctx.SecurePrincipal()` | `ctx.securePrincipal()` | `ctx.secure_principal()` |
| AppSync registration | `app.AppSyncField(...)` | `app.appSyncField(...)` | `app.appsync_field(...)` |
| WebSocket registration | `app.WebSocket(...)` | `app.webSocket(...)` | `app.websocket(...)` |
| Route inventory | `app.Routes()` | `app.routes()` | `app.routes()` |
| Secure OpenAPI | `app.GenerateOpenAPI(...)` | `app.generateOpenAPI(...)` | `app.generate_openapi(...)` |

All secure HTTP, AppSync, and WebSocket registrations require one posture. The fixed gate runs before user middleware;
unknown principal kinds fail with 401. `Authenticated` scopes are all-of; `AuthenticatedAnyOf` scopes are any-of and
encode each scope alias as an OpenAPI security alternative. For example, Mastodon-compatible `read:statuses` OR
`read` authorization belongs in `AuthenticatedAnyOf("read:statuses", "read")`, not in a route-local guard. The
secure OpenAPI method exact-joins only HTTP route records and emits the `secure-v1` contract marker. Legacy free
OpenAPI functions cannot read secure posture and are unsupported for `SecureApp` adopters.

HTTP error compatibility:

- Default HTTP error bodies remain nested under `error`.
- In the default nested envelope, any error whose code string is `EMPTY_BODY` or `INVALID_JSON` is remapped to
  canonical `app.bad_request` fields; the opt-in flat legacy format preserves those Lift-era codes/messages.
- Lift-compatible flat HTTP error bodies are opt-in:
  - Go: `apptheory.WithHTTPErrorFormat(apptheory.HTTPErrorFormatFlatLegacy)` or `apptheory.WithLegacyHTTPErrorShape()`
  - TypeScript: `createApp({ httpErrorFormat: HTTP_ERROR_FORMAT_FLAT_LEGACY })`
  - Python: `create_app(http_error_format=HTTP_ERROR_FORMAT_FLAT_LEGACY)`
- This setting applies to HTTP serialization only. AppSync and WebSocket error payloads keep their existing shapes.

## HTTP source provenance

`SourceProvenance` is the portable, structured source-IP contract for HTTP requests. It is available in every HTTP
tier, including P0, and is derived only from AWS provider request context fields.

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| Structured type | `SourceProvenance` | `SourceProvenance` | `SourceProvenance` |
| Request field | `Request.SourceProvenance` | `Request.sourceProvenance` | `Request.source_provenance` |
| Context accessor | `ctx.SourceProvenance()` | `ctx.sourceProvenance()` | `ctx.source_provenance()` |
| Convenience IP accessor | `ctx.SourceIP()` | `ctx.sourceIP()` | `ctx.source_ip()` |
| API Gateway v2 test builder option | `HTTPEventOptions.SourceIP` | `sourceIp` | `source_ip` |
| Lambda Function URL test builder option | `HTTPEventOptions.SourceIP` | `sourceIp` | `source_ip` |

The structured value has four fields:

- `source_ip`: canonical parsed source IP string, or `""` when invalid/unknown
- `provider`: `apigw-v2`, `lambda-url`, `apigw-v1`, or `unknown`
- `source`: `provider_request_context` or `unknown`
- `valid`: `true` only when the provider supplied a parseable source IP

Provider mapping:

- API Gateway v2 HTTP API: `requestContext.http.sourceIp` -> `provider = "apigw-v2"`
- Lambda Function URL: `requestContext.http.sourceIp` -> `provider = "lambda-url"`
- API Gateway v1 REST proxy: `requestContext.identity.sourceIp` -> `provider = "apigw-v1"`
- Missing, malformed, unsupported, or ALB source values -> `provider = "unknown"`, `source = "unknown"`,
  `valid = false`

Valid IPs are parsed and re-emitted in canonical form before they become public response or handler strings. For
example, `2001:DB8::1` becomes `2001:db8::1` in all three runtimes.

AppTheory does not parse or trust `Forwarded`, `X-Forwarded-For`, or similar client-controlled forwarding headers for
this contract. Those headers remain ordinary request headers if AWS forwards them, but they do not influence
`SourceProvenance` or `SourceIP`.

## Universal Lambda entrypoint

When one Lambda must accept multiple AWS trigger types, keep the handler thin and delegate dispatch to the runtime.

```go
func handler(ctx context.Context, event json.RawMessage) (any, error) {
	return app.HandleLambda(ctx, event)
}
```

```ts
export const handler = async (event: unknown, ctx: unknown) =>
  app.handleLambda(event, ctx);
```

```py
def handler(event, ctx):
    return app.handle_lambda(event, ctx)
```

### Event shape to entrypoint mapping

| Event shape | Detection heuristic | Entry point called |
| --- | --- | --- |
| SQS | `Records[0].eventSource == "aws:sqs"` | `ServeSQS` / `serveSQSEvent` / `serve_sqs` |
| DynamoDB Streams | `Records[0].eventSource == "aws:dynamodb"` | `ServeDynamoDBStream` / `serveDynamoDBStream` / `serve_dynamodb_stream` |
| Kinesis | `Records[0].eventSource == "aws:kinesis"` | `ServeKinesis` / `serveKinesisEvent` / `serve_kinesis` |
| SNS | `Records[0].Sns` or `EventSource == "aws:sns"` | `ServeSNS` / `serveSNSEvent` / `serve_sns` |
| EventBridge | `detail-type` or `detailType` | `ServeEventBridge` / `serveEventBridge` / `serve_eventbridge` |
| AppSync resolver | `info.fieldName` + `info.parentTypeName` + `arguments` | `ServeAppSync` / `serveAppSync` / `serve_appsync` |
| WebSocket (APIGW v2) | `requestContext.connectionId` | `ServeWebSocket` / `serveWebSocket` / `serve_websocket` |
| API Gateway v2 (HTTP API) | `requestContext.http` + `routeKey` | `ServeAPIGatewayV2` / `serveAPIGatewayV2` / `serve_apigw_v2` |
| Lambda Function URL | `requestContext.http` + no `routeKey` | `ServeLambdaFunctionURL` / `serveLambdaFunctionURL` / `serve_lambda_function_url` |
| ALB Target Group | `requestContext.elb.targetGroupArn` | `ServeALB` / `serveALB` / `serve_alb` |
| API Gateway v1 (REST proxy) | `httpMethod` | `ServeAPIGatewayProxy` / `serveAPIGatewayProxy` / `serve_apigw_proxy` |

Notes:

- Unknown shapes fail closed
- Exact field casing varies by AWS integration; prefer deterministic event builders from the test envs
- Package-local runtime docs may add language-specific examples, but the canonical cross-language dispatch guidance lives here

Event workload contract notes:

- EventBridge workload fixtures pin portable envelope/correlation behavior for future helpers.
- `metadata.correlation_id` and top-level `headers["x-correlation-id"]` are AppTheory portable envelope conventions, not AWS-native EventBridge fields.
- Scheduled workloads use EventBridge scheduled events and derive run IDs, idempotency keys, remaining-time/deadline fields, and structured result summaries.
- DynamoDB Streams workloads keep the Lambda partial-batch response contract and derive only safe record summaries.
- Kinesis workloads keep the Lambda partial-batch response contract, route by stream name, and fail closed for
  unregistered streams by returning every record ID as a failure.

### Kinesis runtime and helpers

Kinesis uses the universal Lambda dispatcher. Register one stream handler through the AppTheory app and keep the Lambda
handler on `HandleLambda`, `handleLambda`, or `handle_lambda`.

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| Register stream handler | `app.Kinesis(streamName, handler)` | `app.kinesis(streamName, handler)` | `app.kinesis(stream_name, handler)` |
| Direct Kinesis entrypoint | `app.ServeKinesis(ctx, event)` | `app.serveKinesisEvent(event, ctx)` | `app.serve_kinesis(event, ctx)` |
| CloudWatch Logs decoder | `DecodeCloudWatchLogsSubscription(record)` | `decodeCloudWatchLogsSubscription(record)` | `decode_cloudwatch_logs_subscription(record)` |
| JSON producer record helper | `NewKinesisJSONRecord(opts)` | `createKinesisJsonRecord(opts)` | `create_kinesis_json_record(...)` |
| PutRecords failure reporter | `ReportKinesisPutRecordsFailures(records, results)` | `reportKinesisPutRecordsFailures(records, results)` | `report_kinesis_put_records_failures(records, results)` |

Kinesis handler failures are returned as Lambda partial-batch failures by record `eventID`; successful records are
omitted. `DecodeCloudWatchLogsSubscription` and its TypeScript/Python equivalents decode the gzip CloudWatch Logs
subscription envelope carried in Kinesis data and return a `safe_summary` that excludes raw log messages. The producer
helpers create deterministic JSON record bytes and safe failure summaries without introducing a second per-service
record or failure shape.

Testkit helpers:

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| Build Kinesis event | `KinesisEvent` | `buildKinesisEvent` | `build_kinesis_event` |
| Build CloudWatch Logs subscription record | `KinesisCloudWatchLogsSubscriptionRecord` | `kinesisCloudWatchLogsSubscriptionRecord` | `kinesis_cloudwatch_logs_subscription_record` |
| Build CloudWatch Logs subscription data | `CloudWatchLogsSubscriptionData` | `cloudWatchLogsSubscriptionData` | `cloudwatch_logs_subscription_data` |

Guide: [Event Workload Contracts](./features/event-workloads.md)
Canonical CDK example: `examples/cdk/kinesis-cloudwatch-logs`

### AppSync resolvers

AppTheory supports the standard AWS direct Lambda resolver event shape in all three runtimes.

- Event models:
  - Go: `AppSyncResolverEvent`, `AppSyncResolverInfo`, `AppSyncResolverRequest`
  - TypeScript: `AppSyncResolverEvent`, `AppSyncResolverInfo`, `AppSyncResolverRequest`
  - Python: `AppSyncResolverEvent`, `AppSyncResolverInfo`, `AppSyncResolverRequest`
- Core event fields:
  - `arguments`: top-level resolver arguments; adapted into the JSON request body
  - `info.fieldName` + `info.parentTypeName`: determine the AppTheory route and method
  - `info.variables`: preserved on the typed context and raw event
  - `info.selectionSetList` + `info.selectionSetGraphQL`: preserved on the exported event types and available on the raw event for selection-set-aware handlers
  - `request.headers`: forwarded to the synthesized request
  - `identity`, `source`, `prev`, and `stash`: preserved on the typed context and portable metadata keys
- Typed context:
  - Go: `ctx.AsAppSync()`
  - TypeScript: `ctx.asAppSync()`
  - Python: `ctx.as_appsync()`
- Portable context metadata keys:

| Key | Meaning |
| --- | --- |
| `apptheory.trigger_type` | Constant `"appsync"` |
| `apptheory.appsync.field_name` | GraphQL field name |
| `apptheory.appsync.parent_type_name` | GraphQL parent type |
| `apptheory.appsync.arguments` | Top-level resolver arguments |
| `apptheory.appsync.identity` | Resolver identity payload |
| `apptheory.appsync.source` | Parent/source object |
| `apptheory.appsync.variables` | GraphQL variables |
| `apptheory.appsync.prev` | Previous resolver result |
| `apptheory.appsync.stash` | Resolver stash map |
| `apptheory.appsync.request_headers` | Forwarded AppSync request headers |
| `apptheory.appsync.raw_event` | Full resolver event |
- Request adaptation:
  - `Mutation -> POST /fieldName`
  - `Query -> GET /fieldName`
  - `Subscription -> GET /fieldName`
  - top-level `arguments` become the JSON request body
  - `request.headers` are forwarded and `content-type: application/json` is synthesized when absent
- Response behavior:
  - JSON bodies project back to native resolver payloads
  - empty bodies project to `null`
  - any other non-empty body projects to a UTF-8 string
  - binary and streaming bodies fail closed with deterministic AppSync system errors
- Error behavior:
  - handler failures return Lift-compatible AppSync error objects with `pay_theory_error`, `error_message`,
    `error_type`, `error_data`, and `error_info`
  - portable AppTheory/AppError payloads include `error_data.status_code` and may include `request_id`, `trace_id`,
    `timestamp`, plus `error_info.code`, `trigger_type`, `method`, `path`, and optional `details`
  - non-portable exceptions now mask to `error_message: "internal error"` instead of echoing raw exception text

Recipe:

- [AppSync Lambda Resolvers](./migration/appsync-lambda-resolvers.md)
- [CDK AppSync Lambda Resolvers](./cdk/appsync-lambda-resolvers.md)

Infrastructure note:

- use `aws-cdk-lib/aws-appsync` for the GraphQL API, schema, auth, and Lambda data source wiring
- AppTheory does not currently export an AppSync-specific CDK construct

## Route registration

Invalid route patterns, duplicate method/pattern pairs, and nil/undefined/None handlers fail closed during registration
across runtimes. Use the normal fluent registration path for new code:

- Go: `app.Get("/users/{id}", h)` or `app.Handle("GET", "/users/{id}", h)`
- TypeScript: `app.get("/users/{id}", h)` or `app.handle("GET", "/users/{id}", h)`
- Python: `app.get("/users/{id}", h)` or `app.handle("GET", "/users/{id}", h)`

Strict helpers remain as deprecated compatibility wrappers for code that already depends on their error-returning or
throwing shape. Python strict helpers now raise `AppTheoryError` rather than `ValueError`, and Go strict helpers return
canonical `AppTheoryError` messaging where applicable. See `UPGRADING.md` for per-line deprecation notes.

## Cross-language feature surfaces

These feature areas extend the core runtime and have dedicated guides when you need deeper operational detail.

### Rate limiting

The `limited` feature set provides DynamoDB-backed cross-instance rate limiting.

- Go: `pkg/limited`
- TypeScript: exports in `api-snapshots/ts.txt` including `DynamoRateLimiter`, `FixedWindowStrategy`, `SlidingWindowStrategy`, and `MultiWindowStrategy`
- Python: exports in `api-snapshots/py.txt` under `apptheory.limited`

Go runtime note:

- `runtime.RateLimitMiddleware(...)` fingerprints default credential-derived identifiers before they reach limiter
  backends:
  - `x-api-key` → `api_key:hmac-sha256:<hex>`
  - `Authorization: Bearer ...` → `bearer:hmac-sha256:<hex>`
- `AuthIdentity`, `TenantID`, and explicit `ExtractIdentifier` overrides are unchanged.
- This avoids storing raw credentials in rate-limit tables, but it also changes observed key values and resets any
  existing credential-backed buckets on first deploy.
- For operator migration guidance, see `docs/migration/v1-security.md`.

### Sanitization

Safe logging helpers are exported in all three runtimes:

- Go: `pkg/sanitization`
- TypeScript: `sanitizeLogString`, `sanitizeFieldValue`, `sanitizeJSON`, `sanitizeJSONValue`, `sanitizeXML`
- Python: `sanitize_log_string`, `sanitize_field_value`, `sanitize_json`, `sanitize_json_value`, `sanitize_xml`

Guide: [Sanitization](./features/sanitization.md)

Operational note:

- Sanitization heuristics once again redact token-like unknown keys by default, including `authorization_id`. See
  `docs/migration/v1-security.md` if you have log-processing workflows that depended on those values remaining visible.

### Jobs ledger

TableTheory-backed job ledger primitives exist for long-running workflows that need job state, record state,
idempotency, and leases.

- Go: `pkg/jobs`
- TypeScript: exports in `api-snapshots/ts.txt` including `DynamoJobLedger`, `CreateJobInput`, `JobMeta`, and related status types
- Python: exports in `api-snapshots/py.txt` including `DynamoJobLedger`, `JobsConfig`, and related helpers

Guide: [Jobs Ledger](./features/jobs-ledger.md)
Reference stack: `examples/cdk/import-pipeline/`

### Object store helper

AppTheory includes a narrow bounded object-store helper for framework-owned byte payload storage. It is not a general
storage SDK and does not expose list, presign, multipart, or raw-client escape hatches.

- Go: `pkg/objectstore`
- TypeScript: `ObjectStore`, `ObjectRef`, `createS3ObjectStore`, and `FakeObjectStore`
- Python: `ObjectStore`, `ObjectRef`, `create_s3_object_store`, and `FakeObjectStore`
- Testkit/fakes: `testkit/objectstore` in Go plus package-local fake stores in TypeScript and Python
- Object refs: strict `s3://bucket/key` parsing into bucket/key/version fields with no default bucket/key and no query
  or fragment support.
- Store contract: `Put`, bounded `Get` with required `MaxBytes`, and `Delete` only.
- S3 implementations: each runtime keeps the cloud client seam inside the framework surface and exposes only bounded
  `put`/`get`/`delete` operations. TypeScript intentionally carries `@aws-sdk/client-s3` as a hard package dependency
  because the S3 implementation imports it at module load; Python intentionally keeps `boto3` optional/lazy and fails
  closed from `create_s3_object_store` if the dependency or required S3 methods are unavailable.
- Encryption: bucket-default, S3-managed, and KMS modes fail closed on contradictory or missing KMS configuration.

Guide: [Object Store Helper](./features/object-store.md)

### AWS runtime hardening helpers (Go)

The Go-only `runtime/aws` package centralizes two platform-Lambda invariants without changing the portable runtime
contract. `AssumeFirst` uses `AssumeRoleAPI` plus `CallerIdentityFactory` to establish assumed authority, delegates the
identity proof to `AssertAccount` through `CallerIdentityAPI`, and returns `AssumeFirstResult.Credentials` only for an
`AccountAssertionVerified` result. `AccountAssertion`, `AccountAssertionState`, and `AssumeRoleRequest` preserve the
explicit not-configured, assume-failed, unavailable, mismatch, and verified outcomes.

`VerifyVersionedArtifact` accepts AppTheory's existing `objectstore.Store` and a fully pinned
`VersionedArtifactRequest`. It requires a non-`null` S3 `VersionID`, verifies `GetOutput.Ref.VersionID`, and derives the
aggregate digest from a bounded regular-file tar whose member paths reject ambiguous or unsafe forms.
`VersionedArtifact`, `ArtifactEntry`, and `ArtifactVerificationState` carry explicit evidence; verified bytes are exposed
only through defensive-copy accessors. `MaxVersionedArtifactBytes` and `MaxVersionedArtifactEntries` are fixed ceilings.
Stable errors distinguish invalid requests, missing versions, unavailable objects, version mismatches, invalid archives,
and digest mismatches.

Guide: [AWS Runtime Hardening Helpers](./features/aws-runtime-hardening.md)

### Semantic vector helpers

AppTheory includes a narrow semantic-recall helper surface for S3 Vectors and Bedrock Titan embeddings. It is a
retrieval plane, not canonical persistence: store durable records and ledgers in TableTheory-backed or app-owned stores,
then publish keyed embeddings and retrieval metadata through the AppTheory vectorstore contract.

- Go: `pkg/vectorstore` exposes `VectorRecord`, `PutInput`, `GetInput`, `DeleteInput`, `QueryInput`, `QueryHit`,
  `Store`, `Embedder`, `SemanticRecord`, and `SemanticIndex`.
- Fake/test helpers: `NewFakeStore`, `FakeStore`, `NewFakeEmbedder`, and `FakeEmbedder`.
- S3 Vectors adapter: `NewS3VectorStore`, `S3VectorStore`, and `S3VectorsAPI`.
- Bedrock Titan adapter: `NewTitanEmbedder`, `TitanEmbedder`, `BedrockRuntimeAPI`, `DefaultTitanEmbedTextModelID`,
  `DefaultEmbeddingDimensions`, `EnvEmbeddingProvider`, `EnvEmbeddingModelID`, `EnvEmbeddingDimensions`, and
  `EnvEmbeddingNormalize`.
- S3 Vectors environment/config: `EnvVectorBucketName`, `EnvVectorIndexName`, `EnvVectorIndexARN`,
  `EnvVectorDimension`, `DefaultQueryTopK`, `MaxQueryTopK`, and `MaxPutDeleteBatchSize`.
- Validation helpers: `ValidateDimension`, `ValidateVector`, `ValidateKey`, `ValidateRequiredMetadata`,
  `NormalizeTopK`, `CloneVector`, `CloneMetadata`, and `EmbeddingErrorCode`.
- Fail-closed errors: `ErrorCodeInvalidConfig`, `ErrorCodeInvalidInput`, `ErrorCodeInvalidVector`,
  `ErrorCodeDimensionMismatch`, `ErrorCodeEmbeddingFailed`, `ErrorCodeNotFound`, `ErrorCodeUnsupportedOperation`,
  `ErrInvalidConfig`, `ErrInvalidInput`, `ErrInvalidVector`, `ErrDimensionMismatch`, `ErrEmbeddingFailed`,
  `ErrNotFound`, and `ErrUnsupportedOperation`.

Guides: [S3 Vectors and Bedrock Embeddings](./features/s3-vectors.md) and
[S3 Vector Index](./cdk/vector-index.md)

### AWS Lambda MicroVM support

The corrective M16 MicroVM surface is fixture-backed across Go, TypeScript, and Python. It is a constrained AppTheory
primitive, not a raw AWS SDK escape hatch. The `v1.14.0` / M15 foundation should not be cited as complete live MicroVM
support; the canonical real operation vocabulary is `run`, `get`, `list`, `suspend`, `resume`, `terminate`,
`invoke`, `auth-token`, and `shell-auth-token`.

- Go: `runtime/microvm` exports lifecycle adapters, real controller routes, constrained provider adapters, safe session
  records, token-hidden workload invocation, TableTheory session registry helpers, and test fakes. Runtime logging is
  represented by `ProviderLogging` / `ProviderCloudWatchLogging`, configured with `WithControllerLogging`, and read
  from `EnvLogging` by deployed real controllers.
- TypeScript: `MicroVMLifecycleAdapter`, `MicroVMRealController`, `TableTheoryMicroVMSessionRegistry`,
  `createAWSLambdaMicroVMProvider`, `createRealMicroVMController`, and related validators.
- Python: `MicroVMLifecycleAdapter`, `MicroVMRealController`, `TableTheoryMicroVMSessionRegistry`,
  `create_aws_lambda_microvm_provider`, `create_real_microvm_controller`, and related validators.
- CDK: `AppTheoryMicrovmNetworkConnector`, `AppTheoryMicrovmImage`, and `AppTheoryMicrovmController` wire typed
  connector references, endpoint-dispatched no-hook images, protected routes, IAM grants, token-hidden workload invoke,
  and the durable session table.
- Conformance: `examples/microvm-conformance` is the AppTheory-owned harness for a consumer-provided EqualToAI/Host lab.

The golden path requires sanitized lifecycle events, protected controller routes, sanitized token metadata, token-hidden
workload invocation through `/microvms/{session_id}/invoke`, and the TableTheory/DynamoDB-style session registry with
`pk`, `sk`, and `ttl`. It does not provide EqualToAI/Host application proof, customer workload readiness, generalized
account vending, unauthenticated controllers, raw SDK access, provider auth-token exposure, or raw lifecycle hook
bypasses.

Guide: [AWS Lambda MicroVM Golden Path](./features/lambda-microvm-contract-foundation.md)
CDK guide: [Lambda MicroVM CDK Constructs](./cdk/lambda-microvm.md)

## Migration and configuration notes

Confirmed migration surface:

- Dry run: `go run ./cmd/lift-migrate -root ./path/to/service`
- Apply rewrite: `go run ./cmd/lift-migrate -root ./path/to/service -apply`
- Repo wrapper: `./scripts/migrate-from-lift-go.sh -root ./path/to/service [-apply]`

Known configuration keys surfaced by canonical docs:

- `APPTHEORY_EVENTBUS_TABLE_NAME`
- `ERROR_NOTIFICATION_SNS_TOPIC_ARN`
- `APPTHEORY_JOBS_TABLE_NAME`
- `UNKNOWN:` a complete stable env-var/config-key catalog is not yet centralized in one canonical index

### MCP and OAuth

AppTheory includes fixture-backed MCP and OAuth support across the runtime family, with the Go package paths listed
here for operators who need implementation-level details:

- `runtime/mcp`: Streamable HTTP `POST/GET/DELETE /mcp`, protocol negotiation, origin validation, sessions, resumable
  SSE, and the MCP request surface (`initialize`, `ping`, `tools/*`, `resources/*`, `prompts/*`, plus accepted
  `notifications/initialized` / `notifications/cancelled`)
- Protocol-shape detection has both byte/request and already-parsed-message entrypoints:
  `DetectProtocolVersion` / `DetectProtocolVersionForMessage`,
  `detectMcpProtocolVersion` / `detectMcpProtocolVersionForMessage`, and
  `detect_mcp_protocol_version` / `detect_mcp_protocol_version_for_message`.
- `testkit/mcp`: deterministic in-process MCP client helpers (`NewClient`, `Initialize`, `ListTools`, `CallTool`,
  `ListResources`, `ReadResource`, `ListPrompts`, `GetPrompt`, `RawStream`, `ResumeStream`, `Stream.Response`,
  `Stream.Cancel`, `Stream.Next`, `Stream.ReadAll`) plus JSON-RPC request builders and assertions
- `runtime/oauth`: protected-resource metadata, challenges, DCR, PKCE, token-store helpers, and the namespace MCP
  bundle. `MCPServerConfig`, `RegisterMCPServer`, and `NewMCPProtectedResourceDiscoveryHandler` keep the MCP route
  authenticated while registering request-host-derived RFC 9728 discovery with public SecureApp posture. Canonical
  paths are exported as `MCPPath`, `OAuthProtectedResourcePath`, `OAuthProtectedResourceMCPPath`, and
  `OAuthAuthorizationServerMCPPath`. `NormalizeRequestOrigin` is the shared fail-closed request-origin normalizer.
- `runtime/mcproutes`: the additive `m17.mcp-route-algebra/v1` contract. `EndpointPath`, `ParseMCPPath`, the
  `SupportedEndpointTemplates`, `SupportedOAuthFacadeTemplates`, and `SupportedOAuthDiscoveryTemplates` enumerations,
  and pure protected-resource/authorization-server derivations define the namespace, partner-namespace, agent, and
  partner-agent golden path without rewiring the existing OAuth or CDK construct surfaces. `ParamClientNamespace`,
  `ParamPartnerID`, and `ParamAgentID` pin the canonical router parameter names used by those templates.
- `runtime/mcpfacade`: the Go composition helper over that contract. `RegisterMCPFacade` accepts `FacadeConfig`,
  registers the four MCP method families and both OAuth metadata documents, and returns a versioned `RouteInventory`.
  The `URLMode` values `URLModePublicBaseURL` and `URLModeRequestHost` select fixed front-door/CDN origins or derive
  each origin from the incoming request. `DefaultCapabilities` supplies the fixed defaults, while `Capabilities`,
  per-kind scope sets, and paired application-owned `HandlerFactory` authorize/token plug points remain explicit
  config. Optional `RootDiscoveryConfig` installs the static upstream authorization-server root document. Each
  installed `Route` records its methods and derived paths.
- `testkit/oauth`: Claude-like end-to-end OAuth flow helpers for remote MCP tests (`NewClaudePublicClient`,
  `AuthorizeOptions`, `Authorize`)
- TypeScript and Python expose matching MCP registries, server/test harnesses, in-memory/Dynamo stores, bearer-token
  validation, protected-resource metadata, DCR, and PKCE helpers through their package API snapshots.

Remote MCP auth hardening notes:

- `oauth.RequireBearerTokenMiddleware(...)` is fail-closed in Go: you must provide a `Validator`, and metadata
  discovery for the `WWW-Authenticate` challenge comes from `ResourceMetadataURL` or `MCP_ENDPOINT`, not request
  headers.
- Invalid-audience bearer tokens are intentionally fixture-pinned as authorization failures: AppTheory returns
  `403 app.forbidden` without a `WWW-Authenticate` challenge, matching insufficient-scope denial so a token bound to
  another resource is not treated as a rediscovery prompt. Missing or expired bearers remain `401` challenge cases.
- Namespace deployments use `AppTheoryMcpServer` with `oauth.RegisterMCPServer`. Protected resource hosts are derived
  from each request; neither CDK nor `MCPServerConfig` accepts a protected-resource origin.

Related canonical integration guides:

- [Integration Guides](./integrations/README.md)
- [Bedrock AgentCore MCP](./integrations/agentcore-mcp.md)
- [Remote MCP](./integrations/remote-mcp.md)
- [Remote MCP + Autheory](./integrations/remote-mcp-autheory.md)
- [MCP Method Surface](./integrations/mcp.md)
- [MCP Route Algebra](./features/mcp-route-algebra.md)
- [Go MCP Facade Helper](./features/mcp-facade-helper.md)

## CDK construct overview

Canonical CDK guidance lives under [docs/cdk](./cdk/README.md). The construct inventory exported by `cdk/lib/index.ts`
includes:

- `AppTheoryHttpApi`
- `AppTheoryRestApi`
- `AppTheoryRestApiRouter`
- `AppTheoryMcpServer`
- `AppTheoryMcpPaths`
- `AppTheoryRemoteMcpServer`
- `AppTheoryMcpProtectedResource` (deprecated URL-valued static-document props)
- `AppTheoryInstallParameters`
- `AppTheoryJobsTable`
- `AppTheoryS3Ingest`
- `AppTheoryS3VersionedIngress`
- `AppTheoryVectorIndex`
- `AppTheoryCodeBuildJobRunner`
- `AppTheoryKinesisStream`
- `AppTheoryKinesisStreamMapping`
- `AppTheoryCloudWatchLogsDestination`
- `AppTheoryMicrovmNetworkConnector`
- `AppTheoryMicrovmImage`
- `AppTheoryMicrovmController`

Start with:

- [CDK Getting Started](./cdk/getting-started.md)
- [CDK API Reference](./cdk/api-reference.md)
- [MCP Server Umbrella Construct](./features/mcp-server-construct.md)
- [Namespace Install Parameters](./features/install-parameters.md)
- [S3 Versioned Artifact Ingress](./features/s3-versioned-ingress.md)
- [Kinesis + CloudWatch Logs](./cdk/kinesis-cloudwatch-logs.md)
- [CDK Import Pipeline Guides](./cdk/import-pipeline.md)
- [S3 Vector Index](./cdk/vector-index.md)
- [Lambda MicroVM CDK Constructs](./cdk/lambda-microvm.md)

Package-local docs remain available under `ts/docs/`, `py/docs/`, and `cdk/docs/` for language-specific examples, but
they should not be treated as the canonical external root.

<!-- apptheory-api-docs:go:start -->
## Go snapshot coverage index

This index is maintained with `scripts/verify-api-docs.sh` so handwritten docs cannot drift from `api-snapshots/go.txt`.

<details>
<summary>1046 exported top-level symbols</summary>

```text
AcquireLeaseInput, AcquireSemaphoreSlotInput, ALBTargetGroupRequest, AllowedFields, AllowOrigins, APIGatewayV2Request
App, AppError, AppSyncContext, AppSyncEvent, AppSyncEventOptions, AppSyncResolverEvent, AppSyncResolverInfo
AppSyncResolverRequest, AppTheoryError, AppTheoryErrorFromAppError, AsAppTheoryError, AssertError, AssertHasTools
AssertToolResult, AtomicRateLimiter, AuthContext, Authenticated, AuthenticatedAnyOf, AuthHook, AuthorizationCodeRecord
AuthorizationCodeStore, AuthorizationServerMetadata, AuthorizationServerMetadataHandler, AuthorizeOptions, AuthPosture
AuthPostureAuthenticated, AuthPostureAuthenticatedAnyOf, AuthPostureInternalOnly, AuthPostureKind, AuthPostureOptional, AuthPosturePublic
AuthPrincipal, AWSLambdaMicroVMProvider, AWSLambdaMicroVMProviderID, AWSLambdaMicroVMProviderOption, BaseName
BearerTokenClaims, BearerTokenClaimsFromContext, BearerTokenClaimsValidator, BearerTokenFromHeaders, BearerTokenRecord
BearerTokenValidationOptions, BearerTokenValidator, BedrockRuntimeAPI, Binary, BindConfig, BodyStream
BuiltInLoggingProfileNames, CacheableResultConfig, CacheControlISR, CacheControlSSG, CacheControlSSR, CacheHint
CacheScope, CacheScopePrivate, CacheScopePublic, Call, CallToolRequest, CanonicalizeIssuerURL, CanonicalResourceURL
CapabilityConfig, CaptureBodyStream, ClaudeDynamicClientRegistrationPolicy, ClaudePublicClient, Client, ClientIP
Clock, CloneMetadata, CloneVector, CloudWatchLogsSubscription, CloudWatchLogsSubscriptionData
CloudWatchLogsSubscriptionLogEvent, CloudWatchLogsSubscriptionOptions, CloudWatchLogsSubscriptionSummary
CodeHeaderMismatch, CodeInternalError, CodeInvalidParams, CodeInvalidRequest, CodeMethodNotFound
CodeMissingRequiredClientCapability, CodeParseError, CodeServerError, CodeUnsupportedProtocolVersion, Command
CommandAuthToken, CommandCreate, CommandGet, CommandInvoke, CommandLegacyShellToken, CommandList, CommandResume
CommandRun, CommandSession, CommandShellAuthToken, CommandShellToken, CommandStart, CommandStatus, CommandStop
CommandSuspend, CommandTerminate, CompleteIdempotencyRecordInput, Completion, CompletionArgument, CompletionContext
CompletionHook, CompletionRef, CompletionRequest, CompletionResult, Config, Connection, ContentBlock, Context
ContextKeyBearerClaims, ContextKeyBearerToken, ContractKind, ContractName, ContractVersion, ContractVersionM16
Controller, ControllerAuthContract, ControllerAuthDefaultDeny, ControllerCommandContract, ControllerContract
ControllerDeploymentDefaults, ControllerEnvelopeContract, ControllerInvokeRequest, ControllerOption, ControllerRequest
ControllerResponse, CORSConfig, CreatedJSON, CreateIdempotencyRecordInput, CreateJobInput, CreateSessionInput
CreateTaskResult, DCRResult, DecodeCloudWatchLogsSubscription, DecodeLoggingProfileJSON, DecodeLoggingProfileYAML
DefaultCapabilityConfig, DefaultConfig, DefaultControllerContract, DefaultEmbeddingDimensions
DefaultEnvironmentErrorNotifications, DefaultEventBusConfig, DefaultLifecycleContract, DefaultLoggingProfile
DefaultOperationContract, DefaultProviderStateMappings, DefaultQueryTopK, DefaultRealLifecycleContract
DefaultSessionProviderID, DefaultSessionRegistryContract, DefaultSessionRegistryTableName
DefaultTitanEmbedTextModelID, DeleteInput, DetectProtocolVersion, DetectProtocolVersionForMessage, DiscoverResult
Discovery, DynamicClientRegistrationPolicy, DynamicClientRegistrationRequest, DynamicClientRegistrationResponse
DynamoDBEventBus, DynamoDBStreamEvent, DynamoDBStreamEventOptions, DynamoDBStreamHandler, DynamoDBStreamRecordOptions
DynamoDBStreamRecordSummary, DynamoJobLedger, DynamoRateLimiter, DynamoSessionStore, DynamoStreamStore
DynamoTaskStore, Embedder, EmbeddingErrorCode, EMFMetricSink, EMFMetricSinkOption, EncodeLoggingProfileEvent
EncodeLoggingProfileEventWithSanitizer, Env, EnvEgressNetworkConnectorRefs, EnvEmbeddingDimensions
EnvEmbeddingModelID, EnvEmbeddingNormalize, EnvEmbeddingProvider, EnvExecutionRoleArn, EnvImageRef
EnvIngressNetworkConnectorRefs, EnvironmentErrorNotificationsOptions, EnvJobsTableName, EnvLogging
EnvNetworkConnectorRefs, EnvSessionRegistryTableName, EnvVectorBucketName, EnvVectorDimension, EnvVectorIndexARN
EnvVectorIndexName, ErrAuthorizationCodeExpired, ErrAuthorizationCodeNotFound, ErrBearerTokenExpired
ErrBearerTokenInsufficientScope, ErrBearerTokenInvalidAudience, ErrDimensionMismatch, ErrEmbeddingFailed
ErrEventNotFound, ErrInvalidAuthorizationHeader, ErrInvalidBearerToken, ErrInvalidConfig, ErrInvalidEncryptionConfig
ErrInvalidGetLimit, ErrInvalidInput, ErrInvalidObjectRef, ErrInvalidStoreConfig, ErrInvalidURL, ErrInvalidVector
ErrMissingBearerToken, ErrNotFound, ErrObjectNotFound, ErrObjectTooLarge, Error, ErrorCodeControllerCommandFailed
ErrorCodeControllerIncomplete, ErrorCodeDimensionMismatch, ErrorCodeEmbeddingFailed, ErrorCodeForbiddenField
ErrorCodeInvalidConfig, ErrorCodeInvalidContract, ErrorCodeInvalidControllerRequest, ErrorCodeInvalidInput
ErrorCodeInvalidLifecycleEvent, ErrorCodeInvalidVector, ErrorCodeLifecycleBypass, ErrorCodeLifecycleHookFailed
ErrorCodeLifecycleIncomplete, ErrorCodeNotFound, ErrorCodeOperationContractIncomplete
ErrorCodeProviderOperationFailed, ErrorCodeProviderOperationUnsupported, ErrorCodeProviderRequestInvalid
ErrorCodeProviderStateMappingIncomplete, ErrorCodeRawSDKEscapeHatch, ErrorCodeRealLifecycleIncomplete
ErrorCodeRouteContractIncomplete, ErrorCodeSessionRegistryIncomplete, ErrorCodeTenantBindingViolation
ErrorCodeTokenSafetyViolation, ErrorCodeUnauthenticatedController, ErrorCodeUnsupportedOperation, ErrorEnvelope
ErrorEnvelopeFromError, ErrorNotifier, ErrorType, ErrorTypeConflict, ErrorTypeInternal, ErrorTypeInvalidInput
ErrorTypeNotFound, ErrorTypeRateLimit, ErrRefreshTokenExpired, ErrRefreshTokenNotFound, ErrSessionNotFound
ErrStreamEventTooLarge, ErrStreamNotFound, ErrTaskNotFound, ErrTaskTerminal, ErrUnsupportedOperation, EscapeHatches
ETag, Event, EventBridgeEvent, EventBridgeEventOptions, EventBridgeHandler, EventBridgePattern, EventBridgeRule
EventBridgeScheduledWorkloadResultSummary, EventBridgeScheduledWorkloadSummary, EventBridgeSelector
EventBridgeWorkloadEnvelope, EventBus, EventBusConfig, EventContext, EventHandler, EventMiddleware, EventQuery
Factory, FakeClient, FakeEmbedder, FakeProvider, FakeSNSClient, FakeStore, FakeStreamerClient, FixedWindowStrategy
FullyRedact, GenerateOpenAPI, GenerateOpenAPIJSON, GetDayWindow, GetFixedWindow, GetHourWindow, GetInput
GetMinuteWindow, GetOutput, GetPromptRequest, Handler, HookFailure, HookPrepareImage, HookReadiness, HookReady
HookResume, HookRun, HooksFromEMFMetricSink, HooksFromLogger, HooksFromLoggerAndEMFMetricSink, HooksFromProfileLogger
HookStart, HookStop, HookSuspend, HookTeardown, HookTerminate, HookValidate, HTML, HTMLStream, HTTPErrorFormat
HTTPErrorFormatFlatLegacy, HTTPErrorFormatNested, HTTPEventOptions, Icon, IdempotencyCreateOutcome
IdempotencyOutcomeAlreadyCompleted, IdempotencyOutcomeAlreadyInProgress, IdempotencyOutcomeCreated, IdempotencyStatus
IdempotencyStatusCompleted, IdempotencyStatusInProgress, IdentifierKey, IdGenerator, IDGenerator, InitializeRequest
InitialSessionListenerBudgetOptions, InputRequest, InputRequiredResult, InspectSemaphoreInput, InternalOnly, IsLambda
IsTerminalState, JobLedger, JobLock, JobLockSortKey, JobMeta, JobMetaSortKey, JobPartitionKey, JobRecord
JobRecordSortKey, JobRequest, JobRequestSortKey, JobStatus, JobStatusCanceled, JobStatusFailed, JobStatusPending
JobStatusRunning, JobStatusSucceeded, JSON, KindControllerSession, KindLifecycle
KinesisCloudWatchLogsSubscriptionRecord, KinesisCloudWatchLogsSubscriptionRecordOptions, KinesisEvent
KinesisEventOptions, KinesisHandler, KinesisJSONRecord, KinesisJSONRecordOptions, KinesisJSONRecordSummary
KinesisPutRecordsFailure, KinesisPutRecordsFailureReport, KinesisPutRecordsFailureReportSummary
KinesisPutRecordsResultRecord, KinesisRecordOptions, LambdaFunctionURLRequest, LifecycleAdapter, LifecycleContract
LifecycleEvent, LifecycleHandler, LifecycleHook, LifecycleHookSpec, LifecycleOption, LifecycleResult, LifecycleState
LifecycleTransition, Limit, LimitDecision, Limits, ListPromptsRequest, ListResourcesRequest, ListToolsRequest
LogEntry, Logger, LoggerConfig, LoggerFactory, LoggerStats, LoggingLevel, LoggingLevelAlert, LoggingLevelCritical
LoggingLevelDebug, LoggingLevelEmergency, LoggingLevelError, LoggingLevelHook, LoggingLevelInfo, LoggingLevelNotice
LoggingLevelRequest, LoggingLevelWarning, LoggingProfileAlertingHints, LoggingProfileCatalog
LoggingProfileCloudWatchJSON, LoggingProfileConfig, LoggingProfileEncoding, LoggingProfileEnrichment
LoggingProfileError, LoggingProfileErrorCapture, LoggingProfileEvent, LoggingProfileJobContext, LoggingProfileLegacy
LoggingProfileLocalDev, LoggingProfilePayTheoryAlertV1, LoggingProfileRequestContext, LoggingProfileSanitization
LoggingProfileSchemaVersion, LoggingProfileValidationError, LoggingProfileValidationErrors, LogRecord, ManualClock
ManualIDGenerator, MapProviderState, MarshalResponse, MaskCardNumber, MaskCompletelyFunc, MaskFirstLast
MaskFirstLast4, MaskTokenLastFour, MatchesIfNoneMatch, MaxPutDeleteBatchSize, MaxQueryTopK
MemoryAuthorizationCodeStore, MemoryEventBus, MemoryRefreshTokenStore, MemorySessionRegistry, MemorySessionStore
MemorySessionStoreOption, MemoryStreamStore, MemoryStreamStoreOption, MemoryTaskStore, MetricRecord, Middleware
MultiWindowStrategy, MustJSON, MustSSEResponse, New, NewAppTheoryError, NewAuthorizationServerMetadata
NewAWSLambdaMicroVMProvider, NewClaudePublicClient, NewClient, NewController, NewDynamoDBEventBus, NewDynamoJobLedger
NewDynamoRateLimiter, NewDynamoSessionStore, NewDynamoStreamStore, NewDynamoTaskStore, NewEMFMetricSink, NewError
NewErrorEnvelope, NewErrorResponse, NewEvent, NewFakeClient, NewFakeClientWithTime, NewFakeEmbedder, NewFakeProvider
NewFakeProviderWithTime, NewFakeSNSClient, NewFakeStore, NewFakeStreamerClient, NewFixedWindowStrategy, NewJobLock
NewJobMeta, NewJobRecord, NewJobRequest, NewKinesisJSONRecord, NewLifecycleAdapter, NewManualClock
NewManualIDGenerator, NewMemoryAuthorizationCodeStore, NewMemoryBearerTokenValidator, NewMemoryEventBus
NewMemoryRefreshTokenStore, NewMemorySessionRegistry, NewMemorySessionStore, NewMemoryStreamStore, NewMemoryTaskStore
NewMultiWindowStrategy, NewNoOpLogger, NewOpaqueToken, NewPKCECodeVerifier, NewPolicySanitizer, NewProfileLogger
NewPromptRegistry, NewProtectedResourceMetadata, NewRealController, NewReconstructingSessionRegistry
NewRegistryClient, NewResourceRegistry, NewResultResponse, NewS3Store, NewS3VectorStore, NewSecure, NewSemaphoreLease
NewServer, NewSlidingWindowStrategy, NewSNSNotifier, NewStore, NewTableTheorySessionRegistry, NewTestLogger
NewTitanEmbedder, NewToolRegistry, NewWithTime, NewZapLogger, NewZapLoggerFactory, NoContent
NormalizeDynamoDBStreamRecord, NormalizeEventBridgeScheduledWorkload, NormalizeEventBridgeWorkloadEnvelope
NormalizeStage, NormalizeTopK, ObjectRef, ObservabilityHooks, OpenAPIAuthSchemes, OpenAPIFieldSpec, OpenAPIRequestSpec
OpenAPIResponseSpec, OpenAPIRouteSpec, OpenAPISpec, OpenAPIValidationRule, Operation, OperationAuthToken
OperationContract, OperationDelete, OperationGet, OperationHTTPRouteContract, OperationInvoke
OperationLegacyShellToken, OperationList, OperationPut, OperationResume, OperationRun, OperationShellAuthToken
OperationShellToken, OperationSuspend, OperationTerminate, Option, Optional, OptionalAuth, Options, OriginalHost
OriginalURI, OriginURL, OriginValidator, ParseBatchRequest, ParseObjectRef, ParseRequest, ParseResponse, PartialMask
PaymentXMLPatterns, PKCEChallengeS256, PKCEVerifyS256, Policy, PolicyAction, PolicyAllow, PolicyDecision
PolicyFromEnv, PolicyFromText, PolicyFullyRedact, PolicyHook, PolicyPartialMask, PolicyRule, PrincipalAuthHook
PrincipalExternal, PrincipalInternal, PrincipalKind, ProfileLogger, ProfileLoggerOption, PromptArgument, PromptDef
PromptHandler, PromptMessage, PromptRegistry, PromptResult, ProtectedResourceMetadata
ProtectedResourceMetadataHandler, ProtectedResourceMetadataURLForRequest, ProtectedResourceWWWAuthenticate
ProtocolShape, ProtocolShape20251125, ProtocolShape20260728, ProtocolShapeUnknown, ProtocolVersion20260728, Provider
ProviderCall, ProviderCloudWatchLogging, ProviderIdlePolicy, ProviderInvokeInput, ProviderInvokeOutput
ProviderListInput, ProviderListOutput, ProviderLogging, ProviderPortScope, ProviderRunInput, ProviderSession
ProviderSessionBinding, ProviderSessionInput, ProviderStateMapping, ProviderToken, ProviderTokenInput, Public
PutInput, QueryHit, QueryInput, RandomIDGenerator, RandomIdGenerator, RapidConnectXMLPatterns, RateLimitConfig
RateLimitDecisionKey, RateLimitEntry, RateLimiter, RateLimitKey, RateLimitMiddleware, RateLimitStrategy
RateLimitWindow, RawJSON, ReadResourceRequest, ReadSSEMessage, RealClock, ReconstructingSessionRegistry
ReconstructSessionRecord, RecordStatus, RecordStatusFailed, RecordStatusPending, RecordStatusProcessing
RecordStatusSkipped, RecordStatusSucceeded, RefreshLeaseInput, RefreshSemaphoreSlotInput, RefreshTokenRecord
RefreshTokenStore, RegisterControllerRoutes, RegisterMicroVMControllerRoutes, RegistryClient, RegistryClientOption
RelatedTaskMetadata, ReleaseLeaseInput, ReleaseSemaphoreSlotInput, ReportKinesisPutRecordsFailures, Request
RequireAnyScope, RequireAuth, RequireBearerTokenMiddleware, RequireBearerTokenOptions
RequiredForbiddenOperationFields, RequiredOperations, RequireEventBridgeWorkloadEnvelope, RequireScope
ResourceContent, ResourceDef, ResourceHandler, ResourceMetadataURLFromMcpEndpoint, ResourceName, ResourceRegistry
ResourceSubscription, ResourceSubscriptionHook, ResourceTemplateDef, Response, ResultType, ResultTypeComplete
ResultTypeInputRequired, RFC9728ResourceMetadataURL, RouteOption, RPCError, S3EncryptionBucketDefault
S3EncryptionConfig, S3EncryptionKMS, S3EncryptionMode, S3EncryptionS3Managed, S3StoreConfig, S3VectorsAPI
S3VectorStore, SafeError, SafeJSONForHTML, SanitizationType, SanitizeFields, SanitizeFieldValue, SanitizeJSON
SanitizeJSONValue, SanitizeLogString, SanitizerFunc, SanitizeXML, ScrubFreeText, SecureApp, SecureOpenAPISpec
SecureOptions, SecurePrincipal, SecurePrincipalResolver, SecureRoute, SecureRouteAppSync, SecureRouteHTTP
SecureRouteSurface, SecureRouteWebSocket, SemanticIndex, SemanticRecord, SemaphoreInspection, SemaphoreLease
SemaphorePartitionKey, SemaphoreSlotSortKey, SensitiveFields, Server, ServerIdentity, ServerOption, Session
SessionCommandInput, SessionKey, SessionListInput, SessionQueryInput, SessionReconstructionHook
SessionReconstructionOption, SessionReconstructionRequest, SessionRecord, SessionRecordFromRegistryRecord
SessionRecordToRegistryRecord, SessionRegistry, SessionRegistryContract, SessionRegistryLister
SessionRegistryPartitionKey, SessionRegistryRecord, SessionRegistrySortKey, SessionRegistryTableName, SessionSpec
SessionStatus, SessionStore, SessionTokenMetadata, SessionTokenMetadataFromProviderToken, SetLogger
SlidingWindowStrategy, SNSEvent, SNSEventOptions, SNSHandler, SNSNotifierOptions, SNSPublishCall, SNSRecordOptions
SourceProvenance, SpanRecord, SQSEvent, SQSEventOptions, SQSHandler, SQSMessageOptions, SSEEvent, SSEMessage
SSEResponse, SSEStreamResponse, StateFailed, StateImagePrepared, StateImagePreparing, StateReadinessProbing
StateReady, StateRequested, StateResuming, StateRunning, StateStarted, StateStarting, StateStopped, StateStopping
StateSuspended, StateSuspending, StateTearingDown, StateTerminated, StateTerminating, StateValidated, StateValidating
StepFunctionsTaskToken, StepFunctionsTaskTokenEvent, StepFunctionsTaskTokenEventOptions, Store, Stream, StreamBytes
StreamChunk, StreamerCall, StreamError, StreamEvent, StreamingToolHandler, StreamResult, StreamStore, StructuredLogger
TableTheorySessionRegistry, Task, TaskListRequest, TaskListResult, TaskLookup, TaskMetadata, TaskRecord
TaskRuntimeOptions, TaskStatus, TaskStatusCanceled, TaskStatusCompleted, TaskStatusFailed, TaskStatusInputRequired
TaskStatusWorking, TaskStore, TaskSupport, TaskSupportForbidden, TaskSupportOptional, TaskSupportRequired
TenantBindingRule, TestLogger, Text, Tier, TierP0, TierP1, TierP2, TimeoutConfig, TimeoutMiddleware, TimeWindow
TitanEmbedder, TokenIssuanceContract, TokenResponse, ToolAnnotations, ToolDef, ToolExecution, ToolHandler, ToolInput
ToolInputFromContext, ToolLifecycleFinish, ToolLifecycleOptions, ToolLifecycleOutcome
ToolLifecycleOutcomeContextCanceled, ToolLifecycleOutcomeHandledError, ToolLifecycleOutcomeInvalidParams
ToolLifecycleOutcomePanic, ToolLifecycleOutcomeSuccess, ToolLifecycleOutcomeTimeout
ToolLifecycleOutcomeUnhandledError, ToolLifecycleStart, ToolLifecycleTelemetry, ToolRegistry, ToolResult
TransitionJobStatusInput, UpsertRecordStatusInput, UsageStats, UsageWindow, ValidateControllerContract
ValidateDimension, ValidateDynamicClientRegistrationRequest, ValidateEscapeHatches, ValidateKey
ValidateLifecycleContract, ValidateLoggingProfile, ValidateOperationContract, ValidatePKCECodeVerifier
ValidateProviderInvokeInput, ValidateProviderListInput, ValidateProviderRunInput, ValidateProviderSession
ValidateProviderSessionInput, ValidateProviderToken, ValidateProviderTokenInput, ValidateRealLifecycleContract
ValidateRequiredMetadata, ValidateSessionRecord, ValidateSessionRegistryContract, ValidateSessionRegistryRecord
ValidateSessionStatus, ValidateSessionTokenMetadata, ValidateVector, ValidationFieldError, ValidationRuleEnum
ValidationRuleMax, ValidationRuleMaxLength, ValidationRuleMin, ValidationRuleMinLength, ValidationRulePattern
ValidationRuleRequired, Vary, VectorRecord, WebSocketClientFactory, WebSocketContext, WebSocketEvent
WebSocketEventOptions, WebSocketHandler, WindowConfig, WindowLimit, WithAPI, WithAuthHook, WithAuthPrincipalHook
WithAWSConfig, WithAWSLambdaMicroVMClock, WithAWSLambdaMicroVMRegion, WithCacheableResultConfig, WithCapabilityConfig
WithClock, WithCompletionHooks, WithControllerClock, WithControllerDeploymentDefaults, WithControllerExecutionRoleArn
WithControllerID, WithControllerIDGenerator, WithControllerLogging, WithControllerProviderID, WithControllerSessionTTL
WithCORS, WithEMFClock, WithEMFNamespace, WithEMFService, WithEMFWriter, WithEnvironmentErrorNotifications
WithErrorNotifier, WithExtensionCapabilities, WithHTTPErrorFormat, WithIdentifier, WithIDGenerator
WithInitialSessionListenerBudget, WithLegacyHTTPErrorShape, WithLifecycleContract, WithLifecycleHandler, WithLimits
WithLogger, WithLoggingLevelHook, WithObservability, WithOriginValidator, WithPolicyHook, WithProfileClock
WithProfileEnvironment, WithProfileSanitizer, WithProfileWriter, WithRegistryClientTTL, WithResourceSubscriptionHooks
WithSanitizer, WithServerIDGenerator, WithServerInfoMetadata, WithSessionReconstructionClock
WithSessionReconstructionStaleAfter, WithSessionStore, WithStreamIDGenerator, WithStreamStore, WithTaskRuntime
WithTier, WithWebSocketClientFactory, WithWebSocketSupport, WithZapLogger, WrapError, XMLSanitizationPattern
AccountAssertion, AccountAssertionAssumeFailed, AccountAssertionMismatch, AccountAssertionNotConfigured,
AccountAssertionState, AccountAssertionUnavailable, AccountAssertionVerified, ArtifactEntry,
ArtifactVerificationArchiveInvalid, ArtifactVerificationDigestMismatch, ArtifactVerificationInvalidRequest,
ArtifactVerificationState, ArtifactVerificationUnavailable, ArtifactVerificationVerified,
ArtifactVerificationVersionMismatch, ArtifactVerificationVersionRequired, AssertAccount, AssumeFirst,
AssumeFirstResult, AssumeRoleAPI, AssumeRoleRequest, CallerIdentityAPI, CallerIdentityFactory, ErrAccountMismatch,
ErrArtifactArchiveInvalid, ErrArtifactDigestMismatch, ErrArtifactInvalidRequest, ErrArtifactUnavailable,
ErrArtifactVersionMismatch, ErrArtifactVersionRequired, ErrAssumeRoleFailed, ErrCallerIdentityUnavailable,
ErrExpectedAccountNotConfigured, MaxVersionedArtifactBytes, MaxVersionedArtifactEntries,
VerifyVersionedArtifact, VersionedArtifact, VersionedArtifactRequest
MCPPath, MCPServerConfig, NewMCPProtectedResourceDiscoveryHandler, NormalizeRequestOrigin, OAuthAuthorizationServerMCPPath, OAuthProtectedResourceMCPPath
OAuthProtectedResourcePath, RegisterMCPServer
Capabilities, DefaultCapabilities, FacadeConfig, HandlerFactory, RegisterMCPFacade, RootDiscoveryConfig, Route, RouteInventory, URLMode
URLModePublicBaseURL, URLModeRequestHost
AgentMCPPattern, AuthorizationAuthorizePathForResourcePath, AuthorizationServerPathForResourcePath, AuthorizationServerPrefix, AuthorizationServerSuffixPathForResourcePath, AuthorizationTokenPathForResourcePath, EndpointKind, EndpointKindAgent, EndpointKindNamespace, EndpointKindPartnerAgent, EndpointKindPartnerNamespace, EndpointPath, EndpointTemplate, NamespaceMCPPattern, OAuthDiscoveryTemplate, OAuthFacadeTemplate, ParamAgentID, ParamClientNamespace, ParamPartnerID, ParseMCPPath, PartnerAgentMCPPattern, PartnerNamespaceMCPPattern, ProtectedResourcePathForResourcePath, ProtectedResourcePathFromMCPPath, ProtectedResourcePrefix, ResourcePathFromProtectedResourcePath, SupportedEndpointTemplates, SupportedOAuthDiscoveryTemplates, SupportedOAuthFacadeTemplates
```

</details>
<!-- apptheory-api-docs:go:end -->
