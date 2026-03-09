# Python Development Guidelines

This guide is contract-only maintainer guidance. It defines how the Python package docs contract is maintained and is not part of the ingestible user-facing knowledgebase surface.

## Knowledgebase contract

`py/docs/_contract.yaml` is the canonical declaration for Python package knowledgebase scope.

✅ CORRECT:
- Treat `fixed_ingestible` as the mandatory Python package knowledgebase core.
- Treat `fixed_contract_only` as maintainer-only and never ingest it as user-facing KB content.
- Add `sanctioned_optional_ingestible` only when the KB scope explicitly needs those specialized docs.
- Keep `py/docs/README.md` and `py/docs/_contract.yaml` aligned whenever official package docs are added, retired, or reclassified.

## Project layout

- Source: `py/src/apptheory/`
- Tests: `py/tests/`

## Commands

Lint (ruff) from repo root:
```bash
./scripts/verify-python-lint.sh
```

Build (wheel + sdist) from repo root:
```bash
./scripts/verify-python-build.sh
```

## API snapshots

If you change exports, update snapshots and commit the results:

```bash
./scripts/update-api-snapshots.sh
```
