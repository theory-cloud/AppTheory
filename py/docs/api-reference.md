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
- Middleware is sync and wraps `next_handler(ctx)`

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

