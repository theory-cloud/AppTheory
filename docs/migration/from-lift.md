# Lift → AppTheory Migration (Draft)

Goal: provide a predictable migration path from `pay-theory/lift` to AppTheory across Go/TypeScript/Python.

This is intentionally **not** a drop-in compatibility promise. The posture is “easy, not identical”.

## Start here

- Mapping doc (seed): `docs/development/planning/apptheory/supporting/apptheory-lift-to-apptheory-mapping.md`
- Migration workstream roadmap: `docs/development/planning/apptheory/subroadmaps/SR-MIGRATION.md`

## Expected migration shape (high-level)

- **Handlers + routing:** move Lift handler/router surfaces to AppTheory’s portable P0 contract (routing, request/response normalization).
- **Middleware ordering:** align to the runtime contract ordering (request-id → recovery → logging → CORS → auth → validation → handler).
- **Errors:** adopt the portable error taxonomy/envelope (`app.*` codes) for consistent client behavior.
- **CDK story:** prefer examples-first; constructs strategy is tracked in `docs/development/planning/apptheory/subroadmaps/SR-CDK.md`.
- **Testing:** migrate to deterministic local testkits + contract fixtures as they land.

## What’s missing (tracked work)

The concrete, step-by-step playbook and any automation helpers are deliverables of `SR-MIGRATION` and milestone `M2`.

