# Lift → AppTheory Migration (Guide Skeleton)

Goal: provide a predictable migration path from `pay-theory/lift` to AppTheory across Go/TypeScript/Python.

This is intentionally **not** a drop-in compatibility promise. The posture is “easy, not identical”.

## Start here

- Pay Theory usage inventory (baseline): `docs/development/planning/apptheory/supporting/apptheory-lift-usage-inventory.md`
- Lift → AppTheory mapping (planning): `docs/development/planning/apptheory/supporting/apptheory-lift-to-apptheory-mapping.md`
- Migration workstream roadmap: `docs/development/planning/apptheory/subroadmaps/SR-MIGRATION.md`

## What changes (and why)

### Imports

- Lift imports like `github.com/pay-theory/lift/pkg/lift` become AppTheory imports rooted at
  `github.com/theory-cloud/apptheory`.
- Many Lift “subsystems” remain available, but will likely move into AppTheory subpackages (for example:
  `apptheory/middleware`, `apptheory/observability`, `apptheory/testkit`).

Why: AppTheory is a new repo with a multi-language contract and a single shared release version. Import paths must change
to reflect the new module/package identity.

### Handler signatures + routing

Lift today is Go-only and can afford Go-specific handler shapes and generics. AppTheory’s runtime core is defined by a
portable contract so the same fixtures pass in Go/TypeScript/Python.

Why: contract parity prevents behavior drift across languages.

### Middleware ordering and defaults

AppTheory will keep Lift’s “ship-ready” posture, but the default ordering will be contract-defined and fixture-backed.

Why: ordering differences are a major source of subtle production drift.

### Rate limiting

Lift historically used `github.com/pay-theory/limited`. AppTheory will provide a dedicated rate limiting middleware that
replicates the **full** `limited` feature set (strategies, fail-open behavior, usage stats) so migrations do not require a
feature cut.

Why: rate limiting is a production requirement and must be available as a first-class capability.

## What can be automated vs manual (initial intent)

Automatable (planned):

- Import path rewrites (`github.com/pay-theory/lift/pkg/...` → `github.com/theory-cloud/apptheory/...`).
- Mechanical symbol renames where AppTheory intentionally diverges (captured in the mapping table below).

Manual (expected):

- Reviewing middleware config knobs for safe defaults (timeouts, size limits, fail-open/fail-closed policy).
- Re-validating error mapping and client-facing behavior for critical endpoints.
- Updating deployment templates (CDK/examples) when the constructs story changes.

## Expected migration shape (high-level)

- **Handlers + routing:** move Lift handler/router surfaces to AppTheory’s portable P0 contract (routing, request/response normalization).
- **Middleware ordering:** align to the runtime contract ordering (request-id → recovery → logging → CORS → auth → validation → handler).
- **Errors:** adopt the portable error taxonomy/envelope (`app.*` codes) for consistent client behavior.
- **CDK story:** prefer examples-first; constructs strategy is tracked in `docs/development/planning/apptheory/subroadmaps/SR-CDK.md`.
- **Testing:** migrate to deterministic local testkits + contract fixtures as they land.

## Mapping table (seed)

This table is a starting point for G1 and will evolve as AppTheory’s P0/P1 contract is finalized.

| Lift symbol/pattern | AppTheory equivalent | Notes |
| --- | --- | --- |
| `lift.New()` | `apptheory.New()` (planned) | new app/router surface rooted at AppTheory |
| `app.Use(middleware.X())` | `app.Use(middleware.X())` (planned) | portable subset is contract-defined; advanced middleware may be Go-only initially |
| `lift.SimpleHandler(fn)` | `apptheory.Handler(fn)` (TBD) | exact shape depends on contract + language parity |
| `ctx.ParseRequest(&v)` | `ctx.Bind(&v)` (TBD) | portable parsing + validation semantics must match fixtures |
| `limited`-backed rate limiting | `middleware/ratelimit` (planned) | replicate full `limited` functionality inside AppTheory |
| Lift CDK constructs | AppTheory examples/templates (TBD) | preserve behavior even if authoring model changes |

## What’s missing (tracked work)

The concrete, step-by-step playbook and any automation helpers are deliverables of `SR-MIGRATION` and milestone `M2`.
