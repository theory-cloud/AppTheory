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

## Universal Lambda entrypoint (`HandleLambda` / `handleLambda` / `handle_lambda`)

Problem: you want one Lambda handler that can accept many AWS triggers.

Solution: delegate to the runtime’s “untyped event” router.

✅ CORRECT (Go):
```go
func handler(ctx context.Context, event json.RawMessage) (any, error) {
    return app.HandleLambda(ctx, event)
}
```

✅ CORRECT (TypeScript):
```ts
export const handler = async (event: unknown, ctx: unknown) =>
  app.handleLambda(event, ctx);
```

✅ CORRECT (Python):
```py
def handler(event, ctx):
    return app.handle_lambda(event, ctx)
```

### Event shape → entrypoint mapping (high-level)

| Event shape | Detection heuristic | Entry point called |
| --- | --- | --- |
| SQS | `Records[0].eventSource == "aws:sqs"` | `ServeSQS` / `serveSQSEvent` / `serve_sqs` |
| DynamoDB Streams | `Records[0].eventSource == "aws:dynamodb"` | `ServeDynamoDBStream` / `serveDynamoDBStream` / `serve_dynamodb_stream` |
| Kinesis | `Records[0].eventSource == "aws:kinesis"` | `ServeKinesis` / `serveKinesisEvent` / `serve_kinesis` |
| SNS | `Records[0].Sns` (or `EventSource == "aws:sns"` in Python) | `ServeSNS` / `serveSNSEvent` / `serve_sns` |
| EventBridge | `detail-type` or `detailType` | `ServeEventBridge` / `serveEventBridge` / `serve_eventbridge` |
| WebSocket (APIGW v2) | `requestContext.connectionId` | `ServeWebSocket` / `serveWebSocket` / `serve_websocket` |
| API Gateway v2 (HTTP API) | `requestContext.http` + `routeKey` | `ServeAPIGatewayV2` / `serveAPIGatewayV2` / `serve_apigw_v2` |
| Lambda Function URL | `requestContext.http` + no `routeKey` | `ServeLambdaFunctionURL` / `serveLambdaFunctionURL` / `serve_lambda_function_url` |
| ALB Target Group | `requestContext.elb.targetGroupArn` | `ServeALB` / `serveALB` / `serve_alb` |
| API Gateway v1 (REST proxy) | `httpMethod` | `ServeAPIGatewayProxy` / `serveAPIGatewayProxy` / `serve_apigw_proxy` |

Notes:
- The dispatcher is intentionally strict: unknown shapes raise/throw.
- Exact field casing varies by AWS integration; use the deterministic event builders in the `testkit`.

## Strict route registration (`HandleStrict` / `handleStrict` / `handle_strict`)

Invalid route patterns are fail-closed across runtimes. By default, registration is **silently ignored** to preserve
backwards compatibility.

✅ CORRECT: use the strict variant in tests/CI when you want fast feedback.

Examples:
- Go: `app.GetStrict("/users/{id}", h)` or `app.HandleStrict("GET", "/users/{id}", h)`
- TypeScript: `app.handleStrict("GET", "/users/{id}", h)` (throws on invalid patterns)
- Python: `app.handle_strict("GET", "/users/{id}", h)` (raises `ValueError`)

## Rate limiting (`limited`)

AppTheory includes a DynamoDB-backed rate limiter with portable semantics:
- Go: `pkg/limited` (+ optional `runtime.RateLimitMiddleware`)
- TypeScript: exported from `@theory-cloud/apptheory` as `limited/*`
- Python: available as `apptheory.limited`

Use it when you need **cross-instance** rate limiting (DynamoDB is the coordination layer). The portable response
contract uses `app.rate_limited` with deterministic `Retry-After` when known.

## MCP server (Bedrock AgentCore)

AppTheory includes an MCP (Model Context Protocol) server implementation intended for **Bedrock AgentCore** tool integrations.

- Go runtime package: `runtime/mcp` (JSON-RPC methods: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`)
- Go test helpers: `testkit/mcp` (deterministic in-process MCP client)
- CDK construct (jsii): `AppTheoryMcpServer` (HTTP API v2 `POST /mcp` → Lambda, optional session table + custom domain)

Guides:
- AgentCore deployment: `docs/agentcore-mcp.md` and `cdk/docs/mcp-server-agentcore.md`
- Full MCP method surface + payload shapes: `docs/mcp.md`
