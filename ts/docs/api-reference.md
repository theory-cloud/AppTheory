# TypeScript API Reference

This document describes the primary user-facing surfaces. The authoritative public type surface is:
- `ts/dist/index.d.ts`
- `api-snapshots/ts.txt` (drift gate)

## Core entrypoints

- `createApp()` → creates an `App`
- `createTestEnv()` → deterministic `TestEnv` (clock + IDs + AWS event builders)

## Routing

Routes are registered on `App`:
- `app.get(path, handler, ...opts)`
- `app.post(path, handler, ...opts)`
- `app.put`, `app.delete`, `app.patch`, `app.options`
- `app.handle(method, path, handler, ...opts)`

## Middleware

- `app.use(middleware)`
- Middleware is async and wraps `next(ctx)`

## Responses

Common helpers:
- `text(status, body)`
- `json(status, value)`
- `html(status, body)`
- `binary(status, bytes, contentType)`
- `sse(status, events)` / `sseEventStream(asyncIterable)`

## AWS helpers

Event builders (deterministic tests):
- `buildAPIGatewayV2Request(...)`
- `buildLambdaFunctionURLRequest(...)`
- plus builders for SQS/SNS/Kinesis/EventBridge/DynamoDB streams/WebSockets

Handlers/adapters:
- `createLambdaFunctionURLStreamingHandler(app)` (Lambda response streaming)

## Universal Lambda entrypoint (`app.handleLambda`)

Problem: you want one Lambda handler that accepts many AWS triggers.

Solution: export a single Lambda handler that delegates to `app.handleLambda(event, ctx)`.

✅ CORRECT:
```ts
import { createApp } from "@theory-cloud/apptheory";

const app = createApp();
app.get("/healthz", async () => ({ status: 200, headers: {}, cookies: [], body: "ok", isBase64: false }));

export const handler = async (event: unknown, ctx: unknown) => app.handleLambda(event, ctx);
```

### Event shape → handler mapping (TypeScript)

| Event shape | Detection heuristic | Method called |
| --- | --- | --- |
| SQS | `Records[0].eventSource == "aws:sqs"` | `app.serveSQSEvent(...)` |
| DynamoDB Streams | `Records[0].eventSource == "aws:dynamodb"` | `app.serveDynamoDBStream(...)` |
| Kinesis | `Records[0].eventSource == "aws:kinesis"` | `app.serveKinesisEvent(...)` |
| SNS | `Records[0].Sns` | `app.serveSNSEvent(...)` |
| EventBridge | `detail-type` or `detailType` | `app.serveEventBridge(...)` |
| WebSocket (APIGW v2) | `requestContext.connectionId` | `app.serveWebSocket(...)` |
| API Gateway v2 (HTTP API) | `requestContext.http` + `routeKey` | `app.serveAPIGatewayV2(...)` |
| Lambda Function URL | `requestContext.http` + no `routeKey` | `app.serveLambdaFunctionURL(...)` |
| ALB Target Group | `requestContext.elb.targetGroupArn` | `app.serveALB(...)` |
| API Gateway v1 (REST proxy) | `httpMethod` | `app.serveAPIGatewayProxy(...)` |

## Strict route registration (`app.handleStrict`)

By default, invalid route patterns are silently ignored (fail-closed).

✅ CORRECT: use `app.handleStrict(...)` in tests/CI for fast feedback.

```ts
app.handleStrict("GET", "/users/{id}", async (ctx) => ({ status: 200, headers: {}, cookies: [], body: ctx.params.id, isBase64: false }));
```

## Rate limiting (`limited/*`)

TypeScript includes a DynamoDB-backed rate limiter (ported from the Go `limited` package):
- `DynamoRateLimiter`
- strategies: `FixedWindowStrategy`, `SlidingWindowStrategy`, `MultiWindowStrategy`

It uses SigV4 + `fetch` (no runtime deps). Provide `AWS_REGION` (or `AWS_DEFAULT_REGION`) and credentials (env or
explicit) for DynamoDB access.
