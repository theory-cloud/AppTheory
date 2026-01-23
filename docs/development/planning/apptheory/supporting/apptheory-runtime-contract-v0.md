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

Lift parity requires additional event sources (SQS, EventBridge, DynamoDB Streams, WebSockets, API Gateway REST v1/SSE).
These are **required AppTheory capabilities**, but are versioned as follow-on contract work (contract v1+), so they can
be specified and fixture-tested without destabilizing the already-shipped HTTP contract.

Tracking:

- `docs/development/planning/apptheory/subroadmaps/SR-EVENTSOURCES.md`
- `docs/development/planning/apptheory/subroadmaps/SR-WEBSOCKETS.md`
- `docs/development/planning/apptheory/subroadmaps/SR-SSE.md`

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

## Streaming response bodies (M14 extension)

AppTheory handlers MAY return a streaming response body, represented as a **stream-of-bytes** in addition to (or instead
of) a buffered body.

Portable shape (conceptual):

- `body`: bytes (optional, treated as a prefix when streaming)
- `body_stream`: stream-of-bytes (optional, yields ordered chunks)

Concatenation rules:

- The effective response body bytes MUST be `body` (prefix) concatenated with each streamed chunk in order.
- Streamed chunks MUST be treated as raw bytes (fixtures encode bytes as `utf8` or `base64` values in JSON).

Header/cookie finalization rules:

- For streaming responses, `status`, `headers`, and `cookies` MUST be finalized **before** the first chunk is emitted.
- Mutations to headers/cookies after streaming begins MUST NOT affect the finalized output (fixture-backed).

Late error rules:

- If an error occurs **before** the first chunk, the runtime MAY return a normal error response (status/headers/body).
- If an error occurs **after** the first chunk, the runtime MUST NOT change `status`/`headers`/`cookies`.
  - Test harnesses MUST surface the late error as a deterministic `stream_error_code` (fixture-backed).

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

## Request ID semantics (P1)

- The canonical request-id header is `X-Request-Id` (normalized as `x-request-id`).
- If the incoming request includes `x-request-id`, the runtime MUST propagate it.
- If the incoming request does not include `x-request-id`, the runtime MUST generate one.
- The runtime MUST include `x-request-id` on the response (success and error).
- For P1+ error responses, the runtime MUST include `error.request_id` in the error envelope.

## Tenant semantics (P1)

- Tenant ID MUST be extracted deterministically:
  1. `x-tenant-id` request header
  2. `tenant` query parameter (first value)
- The extracted tenant ID MUST be available to handlers and middleware as `tenant_id` (empty string when absent).

## Auth hook semantics (P1)

- Auth MUST be expressed as a hook/interface (not hard-coded to a provider).
- When auth is required for a route and the runtime cannot establish identity, it MUST map to `app.unauthorized` (401).
- When identity is established but access is denied, it MUST map to `app.forbidden` (403).
- Auth hook invocation order MUST match the middleware ordering (CORS headers must still be applied to auth failures).

## CORS semantics (P1)

- If the request includes an `Origin` header, responses MUST include:
  - `Access-Control-Allow-Origin` echoing the request origin
  - `Vary: Origin`
- Preflight handling: `OPTIONS` requests with `Access-Control-Request-Method` MUST be handled before routing and return
  a 204 response including `Access-Control-Allow-Methods` echoing the requested method.

## Size guardrails (P1)

If size guardrails are enabled/configured:

- Request bodies over the configured limit MUST map to `app.too_large` (413).
- Response bodies over the configured limit MUST map to `app.too_large` (413).

## Remaining time (P1)

- The runtime MUST make a `remaining_ms` value available to handler code (portable subset; derived from the invocation
  runtime when supported).

## Observability envelope (P2)

Portable observability is expressed as **hooks** with a minimum schema so apps can integrate their preferred providers.

Minimum structured log schema (P2):

- `event` (string): stable event name (e.g. `request.completed`)
- `level` (string): `info` / `warn` / `error`
- `request_id` (string)
- `tenant_id` (string)
- `method` (string)
- `path` (string)
- `status` (number)
- `error_code` (string; empty when not applicable)

If metrics/tracing hooks are provided, they MUST use stable naming and tagging rules (fixture-backed). Provider-specific
integrations are non-portable and may be Go-only until explicitly ported.

## Rate limiting + load shedding semantics (P2)

- Rate limiting MUST map to `app.rate_limited` (429). Implementations SHOULD include a `Retry-After` header when a
  deterministic retry hint exists.
- Load shedding MUST map to `app.overloaded` (503). Implementations SHOULD include a `Retry-After` header when a
  deterministic retry hint exists.
- Portable surface: implementations SHOULD expose a hook/middleware that can reject a request with one of the above
  codes plus optional headers. Storage-backed limiters (DynamoDB/Redis/etc) are explicitly out-of-scope for portability
  until fixture-backed.

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
- `app.overloaded` (503) (if enabled)
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
| `app.overloaded` | 503 |
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
