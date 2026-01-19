# AppTheory Runtime Contract v0

This document defines the **portable runtime contract** for AppTheory across Go/TypeScript/Python.

Status: contract v0 is enforced via `contract-tests/` as part of `SR-CONTRACT`.

## Normative language

The key words “MUST”, “MUST NOT”, “SHOULD”, “SHOULD NOT”, and “MAY” in this document are to be interpreted as described
in RFC 2119.

## Goals

- Provide a language-neutral spec for core HTTP request/response behavior.
- Enable fixture-driven contract tests that prevent semantic drift.
- Keep the contract small enough to be portable and testable.

## Event sources (v0)

Contract v0 covers **HTTP** events only:

- AWS Lambda Function URL
- API Gateway v2 (HTTP API)

Other event sources (SQS, EventBridge, DynamoDB Streams, etc.) are out-of-scope until fixture-backed.

## Canonical request model (v0)

Implementations MUST normalize incoming events into a canonical request model:

- `method`: uppercase HTTP method (e.g. `GET`)
- `path`: URL path, MUST start with `/` and MUST NOT include a query string
- `query`: map of key → list of values (multi-value is supported at canonical level)
- `headers`: case-insensitive map of key → list of values
- `cookies`: map of cookie name → cookie value
- `body`: raw bytes
- `is_base64`: boolean indicating whether the original event body was base64-encoded

Normalization rules (v0):

- **Methods:** MUST be normalized to uppercase.
- **Headers:**
  - Header lookup MUST be case-insensitive.
  - Canonical header keys MUST be normalized to lowercase for determinism.
  - If an event format only provides single header values, implementations MUST preserve the provided value as a
    1-element list.
- **Query:**
  - Canonical query supports multi-value keys.
  - When parsing a raw query string, implementations MUST use `application/x-www-form-urlencoded` decoding rules
    (percent-decoding plus `+` to space).
- **Cookies:**
  - Implementations MUST parse cookies into a name→value map.
  - If the event format provides cookies as a list, implementations MUST use it as the input cookie source; otherwise
    parse the `Cookie` header.
  - If multiple cookies with the same name are provided, the **last** value wins.
- **Body:** if `isBase64Encoded` is true in the source event, the body MUST be decoded to bytes before handler code sees
  it.

## Canonical response model

Implementations MUST normalize handler output to a canonical response model:

- `status`: integer HTTP status
- `headers`: case-insensitive map of key → list of values
- `cookies`: list of `Set-Cookie` values (without the `Set-Cookie:` prefix)
- `body`: raw bytes
- `is_base64`: boolean controlling whether the outgoing event response body is base64-encoded

Response rules (v0):

- Header lookup MUST be case-insensitive.
- Canonical header keys MUST be normalized to lowercase for determinism.
- For textual bodies, `is_base64` SHOULD be false.
- For binary bodies, `is_base64` MUST be true and `body` is base64-encoded in the event response.
- Implementations MUST have deterministic header/cookie behavior (ordering rules must be specified by fixtures).

## Routing semantics (P0)

Route patterns (v0):

- Route matching is segment-based over the URL path (split on `/`).
- Static path segments MUST match exactly.
- Parameter segments are written as `{name}` and match exactly one non-empty segment.

404 / 405 rules (v0):

- If **no** route patterns match the request path, the runtime MUST return `app.not_found` (404).
- If **at least one** route pattern matches the request path, but **no** route matches the request method, the runtime
  MUST return `app.method_not_allowed` (405).
  - The response MUST include an `Allow` header listing allowed methods for the matched path.
  - `Allow` header formatting: methods are uppercase, sorted, and joined with `, ` (comma + space).

## JSON parsing semantics (P0)

When a handler requests JSON parsing:

- A request is considered JSON if its `Content-Type` header (case-insensitive) starts with `application/json`
  (parameters like `charset=utf-8` are allowed).
- If the request body is empty, it MUST be treated as JSON `null` (not an error).
- If the request body is non-empty and invalid JSON, it MUST map to `app.bad_request` (400).

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

Status mapping (v0):

| Error code | HTTP status |
| --- | --- |
| `app.bad_request` | 400 |
| `app.validation_failed` | 400 |
| `app.unauthorized` | 401 |
| `app.forbidden` | 403 |
| `app.not_found` | 404 |
| `app.method_not_allowed` | 405 |
| `app.conflict` | 409 |
| `app.too_large` | 413 |
| `app.rate_limited` | 429 |
| `app.internal` | 500 |

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
