# Migration Guide

Use this guide when moving from Lift or legacy Lambda-handler patterns to AppTheory’s contract-first, cross-language
runtime. AppTheory is migration-oriented, but it is not a promise of drop-in API identity.

## Lift → AppTheory (Go)

Start here:

- `docs/migration/from-lift.md`
- `docs/migration/lift-deprecation.md`
- `docs/migration/g4-representative-migration.md`

✅ CORRECT: treat migration as a parity exercise:

- keep behavior equivalent where contract defines it
- document and test any intentional differences

## From raw AWS Lambda handlers

✅ CORRECT: migrate in this order:

1. Wrap your handler logic into an AppTheory handler (`Context -> Response`).
2. Add routes and middleware.
3. Switch the AWS entrypoint to the matching adapter.
4. Add contract tests or examples for the behavior you rely on.

## Validation

Run these before cutting traffic to the migrated path:

```bash
./scripts/verify-contract-tests.sh
./scripts/update-api-snapshots.sh
make rubric
```

If a migration requirement is not yet confirmed by snapshots or tests, keep it explicit:

- `UNKNOWN:` for an interface or behavior that is not yet verified
- `TODO:` for the concrete follow-up needed before migration is complete
