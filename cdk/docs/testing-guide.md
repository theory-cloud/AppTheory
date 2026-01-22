# CDK Testing Guide

## Unit tests

```bash
cd cdk
npm ci
npm test
```

## Synth verification (repo gate)

```bash
./scripts/verify-cdk-synth.sh
```

## Full repo gates

```bash
make rubric
```

