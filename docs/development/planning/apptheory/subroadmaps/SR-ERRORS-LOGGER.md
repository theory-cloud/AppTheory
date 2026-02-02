# SR-ERRORS-LOGGER - Portable Error + Logger Parity (Lift Migration, Go/TS/Py)

Goal: close the Lift parity gaps for **error handling** and **global logging** while preserving strict
cross-language parity (Go/TypeScript/Python).

This workstream exists because AppTheory's current `AppError` is intentionally minimal and the runtime has no
LiftLogger-style singleton. K3 and other Lift migrations rely on a richer error type and a global logger that can be
set once and used everywhere without refactoring call sites.

## Scope

- A portable, client-safe error type with a stable JSON shape and predictable serialization.
- Error chaining support in each language (idiomatic, but capability-equivalent).
- Helpers to detect/unwrap the portable error in handlers and middleware.
- A global logger singleton per language (default no-op) compatible with AppTheory's structured logging.
- Sanitization helpers exposed alongside the logger for safe-by-default usage.
- Contract and fixture updates to prevent cross-language drift.

Non-goals:

- Replacing every existing error surface or backend logger implementation at once.
- Introducing breaking changes to the current `AppError` contract without a clear migration path.

## Design requirements

- **Parity first:** error fields, serialization rules, and logger APIs must be available in Go/TS/Py.
- **Client-safe by default:** stack traces and internal details are opt-in, not default behavior.
- **Portable shape:** the error envelope must be stable and fixture-backed.
- **Compatibility:** existing `AppError` remains supported and can be bridged to the new type.
- **No-op safety:** the logger singleton must always be non-nil (no panics).

## Current status (AppTheory `main`)

- Go/TS/Py provide a minimal `AppError` with `code` + `message`.
- The runtime error envelope only includes `error.code` and `error.message` (optional `request_id`).
- Go has structured logging interfaces in `pkg/observability`, but no global logger singleton.
- Sanitization helpers already exist in Go/TS/Py (`pkg/sanitization`, `ts/dist`, `py/src/apptheory/sanitization.py`).

## Milestones

### E0 - Contract decision: portable error envelope

**Acceptance criteria**
- A portable error schema is defined and added to the runtime contract doc:
  - Required: `code`, `message`.
  - Optional (portable): `status_code`, `details`, `request_id`, `trace_id`, `timestamp`.
  - Optional (debug-only): `stack_trace` (explicitly documented as opt-in and disabled by default).
- The schema explicitly documents serialization rules and default redaction behavior.
- The parity matrix is updated to include the new error envelope fields.

**Deliverables**
- Update: `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md` (or v1 if promoted).
- Update: `docs/development/planning/apptheory/supporting/apptheory-parity-matrix.md`.

---

### E1 - Portable error type + fluent helpers (Go/TS/Py)

**Acceptance criteria**
- A new portable error type exists in all three languages (name TBD, e.g. `AppTheoryError` or `PortableError`).
- Fields include: `Code`, `Message`, `StatusCode`, `Details`, `RequestID`, `TraceID`, `Timestamp`, `StackTrace`, `Cause`.
- Fluent helpers exist across languages (`withDetails`, `withRequestID`, `withTraceID`, `withStackTrace`, `withCause`).
- Error chaining is idiomatic per language and can be unwrapped/inspected in handlers and middleware.
- `AppError` can be converted or wrapped without losing `code`/`message`.

---

### E2 - Runtime integration + response serialization

**Acceptance criteria**
- The runtime uses the portable error type to build responses when present.
- `AppError` remains supported and maps to the new envelope without breaking existing callers.
- `request_id` and `trace_id` propagate into error responses when available in context.
- Stack traces are not exposed unless explicitly enabled.
- Contract fixtures validate the envelope fields across Go/TS/Py.

**Deliverables**
- New or updated fixtures under `contract-tests/fixtures/` for error envelope fields.
- Updates to Go/TS/Py runtime error serialization paths.

---

### L0 - Global logger singleton (portable API)

**Acceptance criteria**
- A `logger` module/package exists in Go/TS/Py with a global getter/setter (`Logger()`/`SetLogger(...)`).
- Default logger is a no-op implementation (safe to call in any environment).
- The logger API is compatible with AppTheory's structured logger fields and follows parity across languages.
- Sanitization helpers are exposed alongside logging (via re-export or thin wrapper).
- Unit tests verify default behavior and safe replacement.

---

### L1 - Go integration with observability

**Acceptance criteria**
- Go `logger` wraps `pkg/observability.StructuredLogger` without changing its behavior.
- Existing zap logger implementations can be installed as the global logger with no API changes.
- The logger singleton is thread-safe and does not leak goroutines/resources.

---

### M0 - Migration guidance + usage examples

**Acceptance criteria**
- Lift migration docs show how to replace `lift.LiftError` and `logger.LiftLogger`.
- Examples demonstrate:
  - creating the portable error type
  - adding request/trace IDs
  - logging sanitized payloads via the global logger
- The migration plan highlights parity guarantees across Go/TS/Py and any intentional differences.

## Risks and mitigation

- **Contract drift:** require fixtures for new error fields and run in CI across all languages.
- **Leaking sensitive data:** stack traces and `details` are opt-in; sanitization guidance is mandatory.
- **API churn:** keep `AppError` stable; introduce new types without breaking current callers.
