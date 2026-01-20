# Pay Theory Lift Usage Inventory (Baseline)

This inventory supports milestone **G0** in `docs/development/planning/apptheory/subroadmaps/SR-MIGRATION.md`.

Goal: establish a **Pay Theory baseline** of which Lift surfaces are actually in use so AppTheory can preserve **100% of
Lift’s current functionality** for Go users while we incrementally design a portable core for Go/TypeScript/Python.

Status: baseline snapshot. Refresh periodically.

## How this inventory was generated

This document is derived from GitHub code search across the `pay-theory` org for Go import paths:

- `github.com/pay-theory/lift/pkg/…`
- `github.com/pay-theory/limited`

The search API is rate-limited and results are not guaranteed to be exhaustive; treat the tables below as a baseline, not
as a proof of absence.

## Observed Lift import prefixes (sample)

Top observed import prefixes in a 200-result sample:

- `pkg/lift`
- `pkg/middleware`
- `github.com/pay-theory/limited`
- `pkg/observability` (including `zap`, `aws`, `cloudwatch`, `xray`)
- `pkg/cdk/constructs` and `pkg/cdk/patterns`
- `pkg/testing`
- `pkg/services`
- `pkg/dynamorm`
- `pkg/logger`
- `pkg/security`
- `pkg/naming`
- `pkg/deployment`
- `pkg/features`
- `pkg/utils/sanitization`

## “Keep 100% functionality” posture (categorization)

G0 requires mapping each usage to a posture (see `SR-MIGRATION`). For AppTheory we use these categories:

- **Direct replacement in AppTheory:** capability exists with Lift-equivalent intent; wiring may change, but semantics are
  preserved.
- **Replacement with behavior change:** capability exists, but users must adapt to a documented behavior or integration
  change (for example: TableTheory replacing DynamORM, different config defaults, different error envelopes).
- **Temporary: keep using Lift:** AppTheory migration can keep importing Lift for this capability until AppTheory has an
  equivalent; target is to remove all “temporary” items over time.
- **Drop:** intentionally removed. **Not allowed for Pay Theory baseline** (goal is 100% functionality).

Separately from the posture above, AppTheory tracks whether a replacement is:

- **Portable (contract surface):** must match fixtures in Go/TypeScript/Python.
- **Go-only:** available to Go users, explicitly non-portable.

## Package-level migration intent (baseline)

This table is intentionally conservative: anything not yet designed for portability is treated as Go-only or temporary,
but still preserved for Go users.

| Lift area | Examples in Lift | Posture | Portability | Notes |
| --- | --- | --- | --- | --- |
| Runtime core | `pkg/lift`, adapters | Direct replacement in AppTheory | Portable (P0/P1) | Becomes the P0/P1 contract surface. |
| Middleware | `pkg/middleware` | Direct replacement in AppTheory | Portable + Go-only extensions | Portable subset becomes contract; advanced prod middleware may be Go-only until ported. |
| Rate limiting | `pkg/middleware/limited.go` + `github.com/pay-theory/limited` | Replacement with behavior change | Portable API; Go impl first | Decision: replicate **all** `limited` functionality inside AppTheory (`pkg/limited`), backed by **TableTheory** (no long-term dependency on `limited` or DynamORM). |
| Data access (DynamoDB) | `pkg/dynamorm` | Replacement with behavior change | Portable data framework (TableTheory) | TableTheory is AppTheory’s companion data framework for Go/TypeScript/Python and replaces DynamORM for new work. |
| Observability | `pkg/observability/*`, `pkg/logger` | Replacement with behavior change | Portable hooks + Go-only integrations | Keep schema + hooks portable; provider integrations can be Go-only initially. |
| Testing | `pkg/testing` | Direct replacement in AppTheory | Portable testkit shape | Align with SR-MOCKS; preserve deterministic harness behavior. |
| CDK | `pkg/cdk/*` | Replacement with behavior change | TS-first jsii constructs + examples | Preserve Lift-equivalent capability via examples; multi-language constructs are TS-first (jsii). |
| Security/compliance | `pkg/security`, `pkg/compliance` | Replacement with behavior change | Go-only then portable subset | Preserve behavior; port portable subset as contract requirements later. |
| Deployment/dev tooling | `pkg/deployment`, `pkg/dev` | Temporary: keep using Lift | Go-only (Lift) | AppTheory will likely replace with repo templates + examples instead of a Go package. |
| Service clients | `pkg/services/*` | Replacement with behavior change | Portable interfaces; Go impl first | Preserve current surfaces; extract portable boundaries where possible. |

## Follow-ups for a deeper audit

To move from package-level inventory to feature-level precision:

- Identify the top ~5 internal services (by Lift usage) and record which middleware/features they actually enable
  (load shedding, idempotency, auth, tenant extraction, etc).
- Confirm which Lift CDK constructs/patterns are deployed in production and whether they need to be preserved as
  constructs or only as templates/examples.
- Confirm which “advanced” subsystems are relied upon (circuit breaker, bulkheads, adaptive load shedding, idempotency)
  and whether they must be portable or can be Go-only initially.
