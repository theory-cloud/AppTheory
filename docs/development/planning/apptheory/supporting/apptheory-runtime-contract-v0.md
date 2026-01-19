# AppTheory Runtime Contract v0 (Draft)

This document defines the **portable runtime contract** for AppTheory across Go/TypeScript/Python.

Status: draft; enforced via `contract-tests/` as part of `SR-CONTRACT`.

## Goals

- Provide a language-neutral spec for core HTTP request/response behavior.
- Enable fixture-driven contract tests that prevent semantic drift.
- Keep the contract small enough to be portable and testable.

## Event sources (v0)

Contract v0 covers **HTTP** events only:

- AWS Lambda Function URL
- API Gateway v2 (HTTP API)

Other event sources (SQS, EventBridge, DynamoDB Streams, etc.) are out-of-scope until fixture-backed.

## Canonical request model

Implementations MUST normalize incoming events into a canonical request model:

- `method`: uppercase HTTP method
- `path`: URL path (leading slash)
- `raw_query`: raw query string (without leading `?`) when available
- `query`: map of key → list of values (decision: multi-value supported at canonical level)
- `headers`: case-insensitive map of key → list of values
- `cookies`: list of cookie header values (post-normalization)
- `body`: bytes
- `is_base64`: boolean indicating whether the original event body was base64-encoded

Normalization rules (v0):

- Header lookup is case-insensitive.
- If the event format only provides single header values, implementations MUST preserve the provided value.
- If the event format provides cookies as a list, implementations MUST use it; otherwise parse the `Cookie` header.
- If `isBase64Encoded` is true, body MUST be decoded to bytes before handler code sees it.

## Canonical response model

Implementations MUST normalize handler output to a canonical response model:

- `status`: integer HTTP status
- `headers`: case-insensitive map of key → list of values
- `cookies`: list of `Set-Cookie` strings (if supported by the event source)
- `body`: bytes
- `is_base64`: boolean controlling whether the outgoing event response body is base64-encoded

Response rules (v0):

- For textual bodies, `is_base64` SHOULD be false.
- For binary bodies, `is_base64` MUST be true and `body` is base64-encoded in the event response.
- Implementations MUST have deterministic header/cookie behavior (ordering rules must be specified by fixtures).

## Error taxonomy (portable)

Errors returned by AppTheory SHOULD be categorized by stable error codes:

- `app.bad_request` (400)
- `app.validation_failed` (400)
- `app.unauthorized` (401)
- `app.forbidden` (403)
- `app.not_found` (404)
- `app.method_not_allowed` (405)
- `app.conflict` (409)
- `app.too_large` (413) (if guardrails enabled)
- `app.rate_limited` (429) (if enabled)
- `app.internal` (500)

Error response envelope (v0) MUST include:

- `error.code` (string, stable)
- `error.message` (string, safe for clients)
- optional `error.request_id` (string)

Internal errors MUST NOT leak stack traces by default.

## Middleware ordering (v0)

Middleware MUST run in a consistent order across languages. The recommended default stack:

1. Request ID
2. Panic/exception recovery
3. Logging
4. CORS (if enabled)
5. Auth hook (if enabled)
6. Validation (if enabled)
7. Handler

Ordering changes must be made as contract changes and backed by fixtures.

## Contract tests (fixtures)

Fixtures in `contract-tests/` define:

- inputs (canonical request + config)
- expected outputs (canonical response)
- expected logs/fields where relevant (P2)

Fixture schema and file layout are owned by `SR-CONTRACT` and must remain stable once v1.0 ships.

