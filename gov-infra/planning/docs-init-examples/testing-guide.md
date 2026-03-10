# AppTheory Testing Guide

This is an example target for `docs/testing-guide.md`.

## Test Strategy

AppTheory verification is layered so interface drift is caught early:

- Fast unit checks for local iteration (`make test-unit`)
- Cross-language contract checks (`./scripts/verify-contract-tests.sh`)
- Public API drift checks (`./scripts/update-api-snapshots.sh`, `./scripts/verify-api-snapshots.sh`)
- Full repo release gates (`make rubric`)

## Unit Tests

```bash
make test-unit
```

What it does:

- Runs `go test ./...` from the repository root (as defined in `Makefile`)

## Integration / Workflow Verification

```bash
./scripts/verify-contract-tests.sh
./scripts/update-api-snapshots.sh
./scripts/verify-api-snapshots.sh
make rubric
```

## Package-Focused Checks

```bash
(cd ts && npm run check)
(cd py && python -m unittest discover -s tests)
(cd cdk && npm test)
```

## Evidence To Capture

- Commands executed
- Pass/fail status and relevant logs
- Snapshot diffs when public APIs changed
- `TODO:` If a gate is intentionally skipped, record why and when it will be run

## CORRECT vs INCORRECT Test Documentation

✅ CORRECT:

- Tie docs examples to runnable repo commands.
- Treat snapshot changes as public API changes.

❌ INCORRECT:

- Claim parity without running `./scripts/verify-contract-tests.sh`.
- Update docs for new APIs without refreshing snapshots.
