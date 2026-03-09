# TypeScript Development Guidelines

This guide is contract-only maintainer guidance. It defines how the TypeScript package docs contract is maintained and is not part of the ingestible user-facing knowledgebase surface.

## Knowledgebase contract

`ts/docs/_contract.yaml` is the canonical declaration for TypeScript package knowledgebase scope.

✅ CORRECT:
- Treat `fixed_ingestible` as the mandatory TypeScript package knowledgebase core.
- Treat `fixed_contract_only` as maintainer-only and never ingest it as user-facing KB content.
- Add `sanctioned_optional_ingestible` only when the KB scope explicitly needs those specialized docs.
- Keep `ts/docs/README.md` and `ts/docs/_contract.yaml` aligned whenever official package docs are added, retired, or reclassified.

## Project layout

- Source: `ts/src/`
- Build output (committed): `ts/dist/`

✅ CORRECT: if you edit `ts/src/**`, regenerate and commit `ts/dist/**`.

## Commands

```bash
cd ts
npm ci
npm run lint
npm run build
npm run check
```

## API snapshots

If you change exports, update snapshots and commit the results:

```bash
./scripts/update-api-snapshots.sh
```
