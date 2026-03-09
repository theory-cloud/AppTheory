# AppTheory Development Guidelines

This guide is contract-only maintainer guidance. It defines how the AppTheory docs contract is maintained and is not part of the ingestible user-facing knowledgebase surface.

This repository is a multi-language monorepo. The primary goal is cross-language parity with explicit drift prevention.

## Knowledgebase contract

`docs/_contract.yaml` is the canonical declaration for AppTheory knowledgebase scope.

✅ CORRECT:
- Treat `fixed_ingestible` as the mandatory AppTheory knowledgebase core.
- Treat `fixed_contract_only` as maintainer-only and never ingest it as user-facing KB content.
- Add `sanctioned_optional_ingestible` only when the KB scope explicitly needs those specialized docs.
- Keep `docs/README.md` and `docs/_contract.yaml` aligned whenever official docs are added, retired, or reclassified.
- Keep ingestible docs free of links to out-of-scope trees such as `docs/development/**`, `docs/planning/**`, `docs/archive/**`, and `gov-infra/planning/**`.

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
