# AppTheory Migration Guide

Use this guide when moving from a legacy workflow, tool, or package into AppTheory.

## When To Use This Guide

- You are migrating a Go service from Lift to AppTheory
- You are replacing raw AWS Lambda handler wiring with the AppTheory app container and adapter entrypoints
- You need compatibility and cutover guidance that is safe for user-facing retrieval

## Scope Guardrails

- Keep this guide user-facing and task-oriented.
- Do not link readers to `docs/development/**`, `docs/planning/**`, or `docs/archive/**`.
- Place detailed migration walkthroughs under sanctioned optional docs such as `docs/migration/**`.

## Source / Legacy Context

Confirmed migration surface from the bounded discovery pass:
- `docs/migration/from-lift.md` already exists and should remain the primary detailed migration document for Lift consumers.
- The current repo migration overview describes an incremental move from raw AWS Lambda handlers into the AppTheory app container, routes, middleware, and adapter entrypoints.
- AppTheory is positioned as an easy migration path, but **not** as a drop-in replacement.

## Migration Plan

### Path A: Lift to AppTheory

1. Start with `docs/migration/from-lift.md` for the detailed Go migration path.
2. Replace Lift runtime wiring with the AppTheory app container and route registration.
3. Switch the AWS entrypoint to the matching AppTheory adapter or to the universal dispatcher when one Lambda handles multiple event shapes.
4. Re-run verification commands before removing the old path.

### Path B: Raw AWS Lambda handlers to AppTheory

1. Wrap existing handler logic into an AppTheory handler returning the runtime `Response` shape.
2. Add routes and middleware in the App container.
3. Choose the adapter-specific entrypoint, such as API Gateway v2 or Lambda Function URL, or use the universal dispatcher for mixed triggers.
4. Add or update tests and snapshot evidence for the behavior you rely on.

## Validation

```bash
make test
make rubric
```

If exported symbols changed during migration work, also run:

```bash
./scripts/update-api-snapshots.sh
```

## Rollback / Safety Notes

- Keep rollback steps explicit if the migration changes request routing, event handling, or release artifacts.
- Preserve behavior equivalence where the current contract defines it, and document intentional differences.
- `UNKNOWN:` This bounded pass did not confirm a single canonical rollback command sequence for every migration path; add one only after confirming it from the relevant service workflow.

## Optional Detailed Docs

Sanctioned optional follow-up docs for local agents to keep or expand:
- `docs/migration/from-lift.md` - keep and adapt as the detailed Lift migration guide
- `docs/migration/**` - expand with task-oriented cutover guides when a migration topic outgrows this overview
- `docs/llm-faq/**` - create only if repeated assistant-facing migration questions need stable, user-safe answers
