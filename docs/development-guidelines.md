# AppTheory Development Guidelines

This repository is a multi-language monorepo. The primary goal is cross-language parity with explicit drift prevention.

## What to keep aligned

✅ CORRECT: when bumping versions, keep these aligned:
- `VERSION`
- `ts/package.json`
- `py/pyproject.toml`
- `cdk/package.json`

Verification: `./scripts/verify-version-alignment.sh`.

## Generated outputs you must commit

✅ CORRECT:
- If you change TypeScript source (`ts/src/**`), regenerate and commit `ts/dist/**`.
- If you change CDK TypeScript source (`cdk/**`), regenerate and commit `cdk/lib/**` and `cdk/.jsii`.
- If you change exported APIs, update `api-snapshots/` via `./scripts/update-api-snapshots.sh`.

## Documentation standard (Pay Theory)

All public packages must have a `docs/` directory with the standard file set and YAML triad:
- Repo docs: `docs/`
- TypeScript docs: `ts/docs/`
- Python docs: `py/docs/`
- CDK docs: `cdk/docs/`

Verification:
- Repo rubric: `./scripts/verify-docs-standard.sh`
- GovTheory: `bash gov-infra/verifiers/gov-verify-rubric.sh`

## Local workflow

```bash
make fmt
make lint
make test
make rubric
```

