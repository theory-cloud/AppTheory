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

The current verifier stores each example snapshot as a bare `.template.sha256` digest and compares that digest with the
freshly synthesized template. This detects drift, but a changed hash contains no CloudFormation structure, so the
snapshot diff itself is not reviewable. The intended direction is to check in normalized synthesized templates whose
semantic changes can be reviewed directly. That migration is a snapshot-format wave of its own: it must update every
example snapshot, `scripts/verify-cdk-synth.sh`, and the associated reviewer tooling together. It is deliberately out
of scope for the pre-A9 sweep and deferred until after A9.

## Full repo gates

```bash
make rubric
```
