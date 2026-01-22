# AppTheory Testing Guide

AppTheory relies on three complementary test layers: unit tests, contract fixtures, and deterministic “real-shape” examples.

## Fast loop

```bash
make test-unit
```

## Full repo gates (recommended before PR)

```bash
make rubric
```

This includes linting, packaging/build verification, API snapshot checks, contract tests, and testkit/examples verification.

## Contract tests (cross-language parity)

```bash
./scripts/verify-contract-tests.sh
```

✅ CORRECT: if you change behavior, update fixtures/tests first; don’t “fix” drift by weakening gates.

## GovTheory rubric (governance bundle)

```bash
bash gov-infra/verifiers/gov-verify-rubric.sh
```

Evidence is written to:
- `gov-infra/evidence/gov-rubric-report.json`
- `gov-infra/evidence/*-output.log`

