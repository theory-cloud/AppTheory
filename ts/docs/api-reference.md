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

