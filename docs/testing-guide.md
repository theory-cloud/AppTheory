# AppTheory Testing Guide

AppTheory relies on layered deterministic verification: fast unit tests, contract fixtures, snapshot checks, build
checks, and full rubric validation.

## Fast local loop

```bash
make test-unit
```

This runs `go test ./...` from the repo root and is the fastest default check.

## Targeted verification

Run the contract suite when behavior changes span language boundaries:

```bash
./scripts/verify-contract-tests.sh
```

Refresh public API snapshots when exported surfaces change:

```bash
./scripts/update-api-snapshots.sh
```

Package-focused checks that are part of the repo tooling:

```bash
cd ts && npm run check
cd py && python -m unittest discover -s tests
cd cdk && npm test
```

## Full repo gates

```bash
make rubric
```

`make rubric` runs version alignment, formatting, Go/TS/Python linting, packaging/build verification, CDK synth checks,
API snapshot verification, contract tests, testkit/example verification, and docs-standard checks.

## Evidence to capture

- commands run
- pass or fail outcomes
- snapshot updates, generated outputs, or logs that explain the change
- explicit gaps when a check was not run

✅ CORRECT: if behavior changes, update tests or fixtures first. Do not “fix” drift by weakening the gates.

## Governance bundle

```bash
bash gov-infra/verifiers/gov-verify-rubric.sh
```

Evidence is written to `gov-infra/evidence/`.
