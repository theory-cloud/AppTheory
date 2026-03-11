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
- `./scripts/verify-contract-tests.sh`
- `./scripts/update-api-snapshots.sh`
- `./scripts/verify-api-snapshots.sh`
- `./scripts/verify-docs-standard.sh`
- `make rubric`

## Core runtime entrypoints

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| App container | `apptheory.New(...)` | `createApp()` | `create_app()` |
| Deterministic test env | `testkit.New()` | `createTestEnv()` | `create_test_env()` |
| Universal Lambda dispatcher | `app.HandleLambda(ctx, event)` | `app.handleLambda(event, ctx)` | `app.handle_lambda(event, ctx)` |
| AppSync resolver entrypoint | `app.ServeAppSync(ctx, event)` | `app.serveAppSync(event, ctx)` | `app.serve_appsync(event, ctx)` |
| Strict route registration | `app.GetStrict(...)`, `app.HandleStrict(...)` | `app.handleStrict(...)` | `app.handle_strict(...)` |
| HTTP entrypoints | `ServeAPIGatewayV2`, `ServeLambdaFunctionURL`, `ServeAPIGatewayProxy` | `serveAPIGatewayV2`, `serveLambdaFunctionURL`, `serveAPIGatewayProxy` | `serve_apigw_v2`, `serve_lambda_function_url`, `serve_apigw_proxy` |
| Streaming helpers | `SSEResponse`, `SSEStreamResponse` | `htmlStream`, `sseEventStream`, `createLambdaFunctionURLStreamingHandler` | `html_stream`, `sse_event_stream` |

Shared request model:

- `Request`: method, path, headers, query, and body
- `Response`: status, headers, cookies, body, and streaming fields where supported
- `Context`: request-scoped accessors for headers, params, request ID, tenant, clock, IDs, and middleware state

Common helper exports:

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| App creation | `apptheory.New(...)` | `createApp()` | `create_app()` |
| Deterministic HTTP builders | `testkit.APIGatewayV2Request`, `testkit.LambdaFunctionURLRequest` | `buildAPIGatewayV2Request`, `buildLambdaFunctionURLRequest` | `build_apigw_v2_request`, `build_lambda_function_url_request` |
| Deterministic AppSync builders | `testkit.AppSyncEvent` | `buildAppSyncEvent` | `build_appsync_event` |
| Basic response helpers | `Text`, `JSON`, `Binary` | `text`, `json`, `html`, `binary`, `sse` | `text`, `json`, `html`, `binary`, `sse` |

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

### AppSync resolvers

AppTheory supports the standard AWS direct Lambda resolver event shape in all three runtimes.

- Event models:
  - Go: `AppSyncResolverEvent`, `AppSyncResolverInfo`, `AppSyncResolverRequest`
  - TypeScript: `AppSyncResolverEvent`, `AppSyncResolverInfo`, `AppSyncResolverRequest`
  - Python: `AppSyncResolverEvent`, `AppSyncResolverInfo`, `AppSyncResolverRequest`
- Typed context:
  - Go: `ctx.AsAppSync()`
  - TypeScript: `ctx.asAppSync()`
  - Python: `ctx.as_appsync()`
- Request adaptation:
  - `Mutation -> POST /fieldName`
  - `Query -> GET /fieldName`
  - `Subscription -> GET /fieldName`
  - top-level `arguments` become the JSON request body
  - `request.headers` are forwarded and `content-type: application/json` is synthesized when absent
- Response behavior:
  - JSON bodies project back to native resolver payloads
  - `text/*` bodies project to UTF-8 strings
  - empty bodies project to `null`
  - binary and streaming bodies fail closed with deterministic AppSync system errors
- Error behavior:
  - handler failures return Lift-compatible AppSync error objects with `pay_theory_error`, `error_message`,
    `error_type`, `error_data`, and `error_info`

Recipe:

- [AppSync Lambda Resolvers](./migration/appsync-lambda-resolvers.md)

## Strict route registration

Invalid route patterns are fail closed across runtimes. Default registration remains compatibility-oriented, so invalid
patterns may be ignored unless you opt into the strict helpers.

Use these in tests and CI:

- Go: `app.GetStrict("/users/{id}", h)` or `app.HandleStrict("GET", "/users/{id}", h)`
- TypeScript: `app.handleStrict("GET", "/users/{id}", h)`
- Python: `app.handle_strict("GET", "/users/{id}", h)`

## Cross-language feature surfaces

### Rate limiting

The `limited` feature set provides DynamoDB-backed cross-instance rate limiting.

- Go: `pkg/limited`
- TypeScript: exports in `api-snapshots/ts.txt` including `DynamoRateLimiter`, `FixedWindowStrategy`, `SlidingWindowStrategy`, and `MultiWindowStrategy`
- Python: exports in `api-snapshots/py.txt` under `apptheory.limited`

### Sanitization

Safe logging helpers are exported in all three runtimes:

- Go: `pkg/sanitization`
- TypeScript: `sanitizeLogString`, `sanitizeFieldValue`, `sanitizeJSON`, `sanitizeJSONValue`, `sanitizeXML`
- Python: `sanitize_log_string`, `sanitize_field_value`, `sanitize_json`, `sanitize_json_value`, `sanitize_xml`

Guide: [Sanitization](./sanitization.md)

### Jobs ledger

TableTheory-backed job ledger primitives exist for long-running workflows that need job state, record state,
idempotency, and leases.

- Go: `pkg/jobs`
- TypeScript: exports in `api-snapshots/ts.txt` including `DynamoJobLedger`, `CreateJobInput`, `JobMeta`, and related status types
- Python: exports in `api-snapshots/py.txt` including `DynamoJobLedger`, `JobsConfig`, and related helpers

Guide: [Jobs Ledger](./jobs-ledger.md)
Reference stack: `examples/cdk/import-pipeline/`

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

AppTheory includes Go runtime support for MCP and OAuth-adjacent remote-MCP flows:

- `runtime/mcp`: JSON-RPC server methods, registries, and session support
- `testkit/mcp`: deterministic in-process MCP test helpers
- `runtime/oauth`: protected-resource metadata, challenges, DCR, PKCE, and token-store helpers
- `testkit/oauth`: end-to-end OAuth flow helpers for remote MCP tests

Related repo guides outside the current KT ingest set:

- [Bedrock AgentCore MCP](./agentcore-mcp.md)
- [Remote MCP](./remote-mcp.md)
- [Remote MCP + Autheory](./remote-mcp-autheory.md)
- [MCP Method Surface](./mcp.md)

## CDK construct overview

Canonical CDK guidance lives under [docs/cdk](./cdk/README.md). The construct inventory exported by `cdk/lib/index.ts`
includes:

- `AppTheoryHttpApi`
- `AppTheoryRestApi`
- `AppTheoryRestApiRouter`
- `AppTheoryMcpServer`
- `AppTheoryRemoteMcpServer`
- `AppTheoryMcpProtectedResource`
- `AppTheoryJobsTable`
- `AppTheoryS3Ingest`
- `AppTheoryCodeBuildJobRunner`

Start with:

- [CDK Getting Started](./cdk/getting-started.md)
- [CDK API Reference](./cdk/api-reference.md)
- [CDK Import Pipeline Guides](./cdk/import-pipeline.md)

Package-local docs remain available under `ts/docs/`, `py/docs/`, and `cdk/docs/` for language-specific examples, but
they should not be treated as the canonical external root.
