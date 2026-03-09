# AppTheory Migration Guide (Example)

This file is an example for `docs/migration-guide.md`.

## Source / Legacy Context

Primary known legacy source:
- `docs/migration/from-lift.md`

Additional context:
- Existing runtime docs (`docs/getting-started.md`, `docs/api-reference.md`) define current adapter and dispatcher patterns.
- Active `docs/migration/**` pages currently include `docs/migration/from-lift.md`, `docs/migration/g4-representative-migration.md`, and `docs/migration/lift-deprecation.md`.

## Migration Plan

1. Inventory current handlers and event-shape branching.
2. Map handlers to AppTheory app/container + dispatcher entry points.
3. Replace ad-hoc event switching with documented adapters and universal dispatch where needed.
4. Preserve behavioral expectations (header normalization, route validation, parity tests).
5. Run verification gates before cutover:

```bash
make test-unit
./scripts/verify-contract-tests.sh
./scripts/update-api-snapshots.sh
make rubric
```

## Validation

- Contract tests pass for migrated behavior.
- API snapshots align with any interface changes.
- Version alignment checks pass.
- Migration notes include unresolved gaps as `TODO:` / `UNKNOWN:`.
