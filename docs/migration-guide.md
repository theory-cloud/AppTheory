# Migration Guide

Use this guide when moving from Lift or legacy Lambda-handler patterns to AppTheory’s contract-first, cross-language
runtime. AppTheory is migration-oriented, but it is not a promise of drop-in API identity.

## Lift → AppTheory (Go)

Start here:

- `docs/migration/from-lift.md`
- `docs/migration/g4-representative-migration.md`
- `docs/api-reference.md`
- `docs/testing-guide.md`

✅ CORRECT: treat migration as a parity exercise:

- keep behavior equivalent where contract defines it
- document and test any intentional differences

## Migration plan

1. Confirm the current runtime entrypoint and Lift-specific imports.
2. Rewrite or replace Lift imports with AppTheory equivalents.
3. Move mixed-trigger Lambdas to `HandleLambda`, `handleLambda`, or `handle_lambda` unless a narrower adapter is required.
4. Run parity, snapshot, and docs checks before rollout.

## Migration commands

Use the migration helper in dry-run mode first:

```bash
./scripts/migrate-from-lift-go.sh -root ./path/to/service
go run ./cmd/lift-migrate -root ./path/to/service
```

Apply rewrites only after reviewing the diff:

```bash
./scripts/migrate-from-lift-go.sh -root ./path/to/service -apply
go run ./cmd/lift-migrate -root ./path/to/service -apply
```

`UNKNOWN:` no broader stable public CLI contract is documented for `cmd/**` beyond the Lift migration helper.

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
./scripts/verify-api-snapshots.sh
./scripts/verify-docs-standard.sh
make rubric
```

If the migration changes exported APIs, refresh snapshots before re-running verification:

```bash
./scripts/update-api-snapshots.sh
./scripts/verify-api-snapshots.sh
```

If a migration requirement is not yet confirmed by snapshots or tests, keep it explicit:

- `UNKNOWN:` for an interface or behavior that is not yet verified
- `TODO:` for the concrete follow-up needed before migration is complete
