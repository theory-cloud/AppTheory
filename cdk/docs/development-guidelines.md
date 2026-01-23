# CDK Development Guidelines

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

