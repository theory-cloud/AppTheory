# CDK Development Guidelines

This guide is contract-only maintainer guidance. It defines how the CDK package docs contract is maintained and is not part of the ingestible user-facing knowledgebase surface.

## Knowledgebase contract

`cdk/docs/_contract.yaml` is the canonical declaration for CDK package knowledgebase scope.

✅ CORRECT:
- Treat `fixed_ingestible` as the mandatory CDK package knowledgebase core.
- Treat `fixed_contract_only` as maintainer-only and never ingest it as user-facing KB content.
- Add `sanctioned_optional_ingestible` only when the KB scope explicitly needs those specialized guides.
- Keep `cdk/docs/README.md` and `cdk/docs/_contract.yaml` aligned whenever official package docs are added, retired, or reclassified.

## Project layout

- Source (TypeScript): `cdk/*.ts`
- Generated output (committed): `cdk/lib/**` and `cdk/.jsii`
- Generated Python dist: `cdk/dist/python/**`
- Generated Go bindings (separate module): `cdk-go/`

✅ CORRECT: if you edit CDK TypeScript sources, regenerate and commit `cdk/lib/**` and `cdk/.jsii`.

## Commands

```bash
cd cdk
npm ci
npm test
```

From repo root:
```bash
./scripts/verify-cdk-constructs.sh
./scripts/verify-cdk-ts-pack.sh
./scripts/verify-cdk-python-build.sh
./scripts/verify-cdk-go.sh
./scripts/verify-cdk-synth.sh
```
