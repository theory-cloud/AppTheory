# AppTheory Migration Guide

Use this guide when migrating from Lift or raw Lambda handler wiring to AppTheory’s contract-first runtime.

## When To Use This Guide

- Your service currently depends on Lift imports or Lift runtime patterns.
- Your Lambda handlers use custom AWS event-shape branching.
- You need migration evidence that behavior remains stable across Go, TypeScript, and Python surfaces.

## Source / Legacy Context

- Lift migration deep-dive: `docs/migration/from-lift.md`
- Canonical interface map: `docs/api-reference.md`
- Canonical patterns: `docs/core-patterns.md`
- Validation workflow: `docs/testing-guide.md`

## Migration Plan

1. Confirm current entrypoints and exported dependencies.
   - For Go migration helper usage, review `cmd/lift-migrate/main.go` (flags include `-root` and `-apply`).
2. Move handler wiring to runtime entrypoints.
   - Prefer universal dispatcher (`HandleLambda` / `handleLambda` / `handle_lambda`) for mixed trigger Lambdas.
3. Replace Lift-specific dependencies with AppTheory equivalents.
   - Example: legacy `limited` imports migrate to `github.com/theory-cloud/apptheory/pkg/limited`.
4. Run verification before and after cutover.

## Lift-Oriented Migration Commands (Go)

```bash
# Dry run
go run ./cmd/lift-migrate -root ./path/to/service

# Apply rewrites
go run ./cmd/lift-migrate -root ./path/to/service -apply
```

`TODO:` If your service has non-standard import layout, document manual rewrite steps in this guide before applying.

## Validation

```bash
./scripts/verify-contract-tests.sh
./scripts/update-api-snapshots.sh
./scripts/verify-api-snapshots.sh
make rubric
```

Expected result:

- Contract tests confirm behavior parity.
- Snapshot gates confirm published public interface changes are explicit.
- Rubric gate passes for multi-language packaging and docs checks.

## Rollback / Safety Notes

- Keep rollback instructions in service runbooks when cutover changes runtime behavior.
- If a behavior is not yet snapshot-backed, mark it as `UNKNOWN:` and block rollout until verified.
- If a migration step cannot be validated in CI yet, add a concrete `TODO:` with owner and verification command.
