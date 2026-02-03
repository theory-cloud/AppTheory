# SR-LIFT-COMPAT-125 - Lift compat: MaskFirstLast + SNS env var

Goal: close two Lift migration gaps called out in issue #125 (k3 migration):
- Add MaskFirstLast / MaskFirstLast4 sanitization helpers with Lift-compatible behavior.
- Include ERROR_NOTIFICATION_SNS_TOPIC_ARN in default SNS error-notification env var list.

This workstream is explicitly about parity across Go/TypeScript/Python where applicable.

## Scope

- Add MaskFirstLast / MaskFirstLast4 in Go/TS/Py sanitization modules.
- Export the helpers in each language's public surface.
- Add tests for deterministic behavior and edge cases.
- Update default SNS error-notification env var list (Go zap logger).

Non-goals:
- Changing existing sanitization defaults or redaction rules.
- Reworking the SNS notifier implementation beyond env var compatibility.

## Design requirements

- **Lift-compatible behavior:**
  - Empty input -> "(empty)".
  - Too-short input -> "***masked***".
  - Otherwise keep first/last N with "***" in the middle.
  - **Deterministic + portable:** same input yields the same output in Go/TS/Py.
- **Stable public API:** functions are exported and covered by API snapshots.

## Current status (AppTheory main)

- Go/TS/Py expose sanitization utilities (log string, JSON, XML), but no MaskFirstLast helpers.
- DefaultEnvironmentErrorNotifications does not include ERROR_NOTIFICATION_SNS_TOPIC_ARN.

## Milestones

### M0 - Confirm Lift behavior + define spec

**Acceptance criteria**
- Lift implementation is inspected to confirm:
  - Function signatures (MaskFirstLast vs MaskFirstLast4).
  - Definition of "too short" and handling of whitespace/Unicode.
  - Edge cases (empty input, negative prefix/suffix).
- A spec is added to this roadmap describing the exact behavior to implement, aligned to Lift tests.

**Confirmed Lift behavior (pay-theory/lift `pkg/utils/sanitization/mask.go` + `mask_test.go`)**
- `MaskFirstLast(value, prefixLen, suffixLen)`:
  - If `value == ""` -> `"(empty)"`.
  - If `prefixLen < 0` or `suffixLen < 0` -> `"***masked***"`.
  - If `len(value) <= prefixLen + suffixLen` -> `"***masked***"`.
  - Else -> `value[:prefixLen] + "***" + value[len(value)-suffixLen:]`.
  - Uses raw string length (no trimming; byte-count semantics like Go).
- `MaskFirstLast4(value)` is equivalent to `MaskFirstLast(value, 4, 4)`.
- Example: `MaskFirstLast4("12345678")` -> `"***masked***"`, `MaskFirstLast4("1234567890abcdef")` -> `"1234***cdef"`.

---

### M1 - Go: MaskFirstLast helpers + tests

**Acceptance criteria**
- `pkg/sanitization` exports `MaskFirstLast` and `MaskFirstLast4`.
- Behavior matches the spec (empty -> "(empty)", too short -> "***masked***", else keep first/last N).
- Go tests cover:
  - empty string
  - short values (length below threshold)
  - normal values (alpha + numeric)
  - whitespace-trim behavior (if applicable)

**Deliverables**
- `pkg/sanitization/sanitization.go`
- `pkg/sanitization/*_test.go`

---

### M2 - TS/Py parity + exports

**Acceptance criteria**
- `ts/src/sanitization.ts` exports `maskFirstLast` + `maskFirstLast4` (or naming aligned to Go).
- `py/src/apptheory/sanitization.py` exports `mask_first_last` + `mask_first_last4`.
- Exports are wired into `ts/src/index.ts` and `py/src/apptheory/__init__.py`.
- TS dist is regenerated and API snapshots updated.
- Python tests mirror Go edge cases.

**Deliverables**
- `ts/src/sanitization.ts`, `ts/src/index.ts`, `ts/dist/*`
- `py/src/apptheory/sanitization.py`, `py/src/apptheory/__init__.py`
- `py/tests/test_sanitization.py`
- `api-snapshots/*`

---

### M3 - Default SNS env var compatibility (Go)

**Acceptance criteria**
- `DefaultEnvironmentErrorNotifications().TopicARNEnvVars` includes `ERROR_NOTIFICATION_SNS_TOPIC_ARN`.
- Tests confirm the legacy env var is honored.

**Deliverables**
- `pkg/observability/zap/env_sns.go`
- `pkg/observability/zap/sns_env_test.go`

---

### M4 - Documentation + migration notes

**Acceptance criteria**
- The Lift parity docs mention MaskFirstLast helpers and the SNS env var alias.
- Migration guidance notes that Lift services can drop local shims once updated.

**Deliverables**
- `docs/development/planning/apptheory/apptheory-gap-analysis-lift-parity.md`
- `docs/migration/from-lift.md`

## Risks and mitigation

- **Behavior drift:** lock behavior with tests in Go + Py and align TS output to match.
- **API surface churn:** ensure exports + API snapshots are updated in the same change.
- **Ambiguous Lift semantics:** resolve with a verified spec before implementation.
