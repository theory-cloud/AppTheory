# AppTheory Docs Maintainer Guide

This guide is maintainer-facing and intentionally lives under `docs/development/**`, outside the ingestible
documentation surface.

## What to keep aligned

When bumping versions, keep these aligned:

- `VERSION`
- `ts/package.json`
- `py/pyproject.toml`
- `cdk/package.json`

Verification: `./scripts/verify-version-alignment.sh`.

## Generated outputs you must commit

- If you change TypeScript source (`ts/src/**`), regenerate and commit `ts/dist/**`.
- If you change CDK TypeScript source (`cdk/**`), regenerate and commit `cdk/lib/**` and `cdk/.jsii`.
- If you change exported APIs, update `api-snapshots/` via `./scripts/update-api-snapshots.sh`.

## Canonical docs contract

The canonical external root is `docs/`.

Required fixed files:

- `docs/README.md`
- `docs/_concepts.yaml`
- `docs/_patterns.yaml`
- `docs/_decisions.yaml`
- `docs/getting-started.md`
- `docs/api-reference.md`
- `docs/core-patterns.md`
- `docs/testing-guide.md`
- `docs/troubleshooting.md`
- `docs/migration-guide.md`
- `docs/_contract.yaml`
- `docs/development-guidelines.md`

Sanctioned optional ingestible surfaces:

- `docs/migration/**`
- `docs/cdk/**`
- `docs/llm-faq/**`

Package-local docs may still exist for maintainers and package-specific examples, but external guidance must be
reflected under `docs/` (and `docs/cdk/` for CDK operator guidance) before release.

## Local workflow

```bash
make fmt
make lint
make test-unit
make test
bash ./scripts/verify-docs-standard.sh
make rubric
```
