# AppTheory Logging & Operational Standards (Rubric v1.0.0)

This document defines what “acceptable logging” means for AppTheory and how we avoid accidental sensitive data
exposure (PII/secrets/tokens) via logs.

## Scope

In scope for COM-6 (logging-ops):
- First-party framework/runtime code tracked in git under the repo root, excluding:
  - `examples/`
  - `testkit/`
  - `contract-tests/`
  - `gov-infra/`
  - build outputs (`dist/`, `build/`)
  - `*_test.go`

Out of scope for COM-6:
- Examples and verification harnesses (they may print to stdout by design), but they should still avoid real secrets.

## Allowed patterns

Allowed in in-scope code:
- Structured logging via `pkg/observability` (`observability.StructuredLogger`) and `pkg/observability/zap`.
- Logging minimal request metadata (method/path/status/error codes) without request/response bodies or full headers.

Required:
- Never log raw payloads (AWS event objects, request bodies, response bodies) or unredacted auth tokens.
- Sanitize values that may contain untrusted data (no newlines/control characters; redact sensitive fields).

## Prohibited patterns

Disallowed in in-scope code:
- Stdout printing (`fmt.Print*`, `print`, `println`) as an operational logging strategy.
- Standard-library logging (`log.Print*`, `log.Fatal*`, `log.Panic*`) in framework/runtime code.
- Logging entire request/event objects (headers, payloads) instead of minimal metadata.

## Tests (operational standards)

Operational standards are enforced by deterministic Go tests prefixed with `TestOps_` (see COM-6 verifier).
