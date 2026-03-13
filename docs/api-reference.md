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

HTTP error compatibility:

- Default HTTP error bodies remain nested under `error`.
- Lift-compatible flat HTTP error bodies are opt-in:
  - Go: `apptheory.WithHTTPErrorFormat(apptheory.HTTPErrorFormatFlatLegacy)` or `apptheory.WithLegacyHTTPErrorShape()`
  - TypeScript: `createApp({ httpErrorFormat: HTTP_ERROR_FORMAT_FLAT_LEGACY })`
  - Python: `create_app(http_error_format=HTTP_ERROR_FORMAT_FLAT_LEGACY)`
- This setting applies to HTTP serialization only. AppSync and WebSocket error payloads keep their existing shapes.

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

Recipe:

- [AppSync Lambda Resolvers](./migration/appsync-lambda-resolvers.md)
- [CDK AppSync Lambda Resolvers](./cdk/appsync-lambda-resolvers.md)

Infrastructure note:

- use `aws-cdk-lib/aws-appsync` for the GraphQL API, schema, auth, and Lambda data source wiring
- AppTheory does not currently export an AppSync-specific CDK construct

## Strict route registration

Invalid route patterns are fail closed across runtimes. Default registration remains compatibility-oriented, so invalid
patterns may be ignored unless you opt into the strict helpers.

Use these in tests and CI:

- Go: `app.GetStrict("/users/{id}", h)` or `app.HandleStrict("GET", "/users/{id}", h)`
- TypeScript: `app.handleStrict("GET", "/users/{id}", h)`
- Python: `app.handle_strict("GET", "/users/{id}", h)`

## Cross-language feature surfaces

These feature areas extend the core runtime and have dedicated guides when you need deeper operational detail.

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

Guide: [Sanitization](./features/sanitization.md)

### Jobs ledger

TableTheory-backed job ledger primitives exist for long-running workflows that need job state, record state,
idempotency, and leases.

- Go: `pkg/jobs`
- TypeScript: exports in `api-snapshots/ts.txt` including `DynamoJobLedger`, `CreateJobInput`, `JobMeta`, and related status types
- Python: exports in `api-snapshots/py.txt` including `DynamoJobLedger`, `JobsConfig`, and related helpers

Guide: [Jobs Ledger](./features/jobs-ledger.md)
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

- `runtime/mcp`: Streamable HTTP `POST/GET/DELETE /mcp`, protocol negotiation, origin validation, sessions, resumable
  SSE, and the MCP request surface (`initialize`, `ping`, `tools/*`, `resources/*`, `prompts/*`, plus accepted
  `notifications/initialized` / `notifications/cancelled`)
- `testkit/mcp`: deterministic in-process MCP client helpers (`NewClient`, `Initialize`, `ListTools`, `CallTool`,
  `ListResources`, `ReadResource`, `ListPrompts`, `GetPrompt`, `RawStream`, `ResumeStream`, `Stream.Response`,
  `Stream.Cancel`, `Stream.Next`, `Stream.ReadAll`) plus JSON-RPC request builders and assertions
- `runtime/oauth`: protected-resource metadata, challenges, DCR, PKCE, and token-store helpers
- `testkit/oauth`: Claude-like end-to-end OAuth flow helpers for remote MCP tests (`NewClaudePublicClient`,
  `AuthorizeOptions`, `Authorize`)

Related canonical integration guides:

- [Integration Guides](./integrations/README.md)
- [Bedrock AgentCore MCP](./integrations/agentcore-mcp.md)
- [Remote MCP](./integrations/remote-mcp.md)
- [Remote MCP + Autheory](./integrations/remote-mcp-autheory.md)
- [MCP Method Surface](./integrations/mcp.md)

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
