# Python API Reference

This document describes the primary user-facing surfaces. The authoritative public surface is:
- `py/src/apptheory/__init__.py` (`__all__`)
- `api-snapshots/py.txt` (drift gate)

## Core entrypoints

- `create_app()` → creates an `App`
- `create_test_env()` → deterministic `TestEnv` (clock + IDs + AWS event builders)

## Routing

Routes are registered on `App`:
- `app.get(path, handler, *opts)`
- `app.post(path, handler, *opts)`
- `app.put`, `app.delete`, `app.patch`, `app.options`
- `app.handle(method, path, handler, *opts)`

## Middleware

- `app.use(middleware)`
- Middleware is sync and wraps `next_handler(ctx)` (handlers may be sync or `async def`)

## Responses

Common helpers:
- `text(status, body)`
- `json(status, value)`
- `html(status, body)`
- `binary(status, bytes, content_type)`
- `sse(status, events)` / `sse_event_stream(iterable)`

## AWS helpers

Event builders (deterministic tests):
- `build_apigw_v2_request(...)`
- `build_lambda_function_url_request(...)`
- plus builders for ALB/SQS/SNS/Kinesis/EventBridge/DynamoDB streams/WebSockets

## Universal Lambda entrypoint (`app.handle_lambda`)

Problem: you want one Lambda handler that accepts many AWS triggers.

Solution: export a single Lambda handler that delegates to `app.handle_lambda(event, ctx)`.

✅ CORRECT:
```py
from apptheory import create_app, text

app = create_app()
app.get("/healthz", lambda ctx: text(200, "ok"))

def handler(event, ctx):
    return app.handle_lambda(event, ctx)
```

### Event shape → handler mapping (Python)

| Event shape | Detection heuristic | Method called |
| --- | --- | --- |
| SQS | `Records[0].eventSource == "aws:sqs"` | `app.serve_sqs(...)` |
| DynamoDB Streams | `Records[0].eventSource == "aws:dynamodb"` | `app.serve_dynamodb_stream(...)` |
| Kinesis | `Records[0].eventSource == "aws:kinesis"` | `app.serve_kinesis(...)` |
| SNS | `Records[0].EventSource == "aws:sns"` | `app.serve_sns(...)` |
| EventBridge | `detail-type` or `detailType` | `app.serve_eventbridge(...)` |
| WebSocket (APIGW v2) | `requestContext.connectionId` | `app.serve_websocket(...)` |
| API Gateway v2 (HTTP API) | `requestContext.http` + `routeKey` | `app.serve_apigw_v2(...)` |
| Lambda Function URL | `requestContext.http` + no `routeKey` | `app.serve_lambda_function_url(...)` |
| ALB Target Group | `requestContext.elb.targetGroupArn` | `app.serve_alb(...)` |
| API Gateway v1 (REST proxy) | `httpMethod` | `app.serve_apigw_proxy(...)` |

## Strict route registration (`app.handle_strict`)

By default, invalid route patterns are silently ignored (fail-closed).

✅ CORRECT: use `app.handle_strict(...)` in tests/CI for fast feedback.

```py
async def user(ctx):
    return text(200, ctx.params.get("id", ""))

app.handle_strict("GET", "/users/{id}", user)
```

## Rate limiting (`apptheory.limited`)

Python includes a DynamoDB-backed rate limiter (ported from the Go `limited` package) under `apptheory.limited`.

It uses `boto3` (AWS SDK for Python). Ensure credentials/region are available via the standard boto3 provider chain.
