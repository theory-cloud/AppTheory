# Lift → AppTheory Mapping (Seed)

This document tracks what Lift concepts/packages map to in AppTheory and highlights where AppTheory intentionally diverges
to support multi-language parity.

Status: seed draft; refine as part of milestone `M2` and `SR-MIGRATION`.

## Guiding intent

- Lift stays in `pay-theory/lift`.
- AppTheory is a new repo in `theory-cloud` that borrows ideas and (selectively) code.
- “Easy migration” means predictable steps + automation helpers, not full API compatibility.
- Pay Theory requires **100% of Lift’s current functionality** to remain available for Go users (portable + Go-only where
  necessary), even if APIs change.

Related inventory (Pay Theory baseline):

- `docs/development/planning/apptheory/supporting/apptheory-lift-usage-inventory.md`

## Package mapping (Go)

This is a conceptual mapping to guide repo layout and migration docs.

| Lift (today) | AppTheory (target) | Notes |
| --- | --- | --- |
| `pkg/lift` | `pkg/apptheory` (or root entrypoint) | core app/router/handler surfaces |
| `pkg/context` | `pkg/context` | portable context shape must match contract |
| `pkg/middleware` | `pkg/middleware` | ordering must match contract |
| `pkg/middleware/limited.go` + `github.com/pay-theory/limited` | `pkg/middleware/ratelimit` | replicate `limited` feature set inside AppTheory (no long-term dependency on `limited`) |
| `pkg/validation` | `pkg/validation` | portable validation behavior; error mapping |
| `pkg/logger` / `pkg/observability` | `pkg/observability` | portable subset + hooks |
| `pkg/testing` | `pkg/testkit` | deterministic testkit (align with SR-MOCKS) |
| `pkg/cdk/constructs` | `cdk/` (TBD) | prefer jsii constructs for multi-language |

## Feature mapping (seed)

High-leverage Lift features to preserve (portable first):

- Type-safe handlers (language-idiomatic in each SDK)
- Router + method dispatch semantics
- Default middleware stack (request-id, recover, logger, CORS, auth hook, validation)
- Error taxonomy and safe error responses
- Deterministic local testing harness
- CDK example(s) that deploy “the same app” in all three languages

Likely Go-only (until proven portable):

- Deep integration with specific Go libraries/middleware ecosystems
- Some CDK constructs authored in Go (unless migrated to jsii)

## Migration posture for Pay Theory

Because Pay Theory controls the application stack:

- Optimize for “fast migration with known changes”.
- Allow breaking differences when they improve portability/safety (but document them clearly).
- Validate the playbook by migrating one representative service early.
