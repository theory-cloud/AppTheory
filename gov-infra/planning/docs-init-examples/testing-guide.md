# AppTheory Testing Guide (Example)

This file is an example for `docs/testing-guide.md`.

## Test Strategy

AppTheory verification should combine:
- fast unit checks for local iteration,
- cross-language contract tests for parity,
- rubric/build checks before publishing.

## Unit Tests

```bash
make test-unit
```

Expected result:
- `go test ./...` passes (via Makefile `test-unit` target).

## Contract Tests (Cross-language parity)

```bash
./scripts/verify-contract-tests.sh
```

✅ CORRECT:
- Update fixtures/snapshots deliberately when behavior changes.
- Keep docs changes and parity checks in the same PR.

## Full Verification Gate (Pre-PR / Pre-release)

```bash
make rubric
```

This runs repository verification gates (including lint/build/snapshot alignment workflows described in repo docs and scripts).

## Additional Drift Checks

```bash
./scripts/verify-version-alignment.sh
./scripts/update-api-snapshots.sh
```

## Evidence To Capture

- Command output proving unit and rubric checks passed.
- API snapshot diffs when public interfaces changed (`api-snapshots/go.txt`, `api-snapshots/ts.txt`, `api-snapshots/py.txt`).
- Any contract-test fixture updates required for behavior changes.

## Failure Handling

If a check fails:
1. Record the failing command and error output.
2. Reconcile docs with canonical sources (`api-snapshots/*`, `go.mod`, package manifests, and script outputs).
3. Re-run the failing command until clean.
