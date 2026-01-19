# AppTheory CDK Multi-language Demo (Go + Node + Python)

This example deploys the **same AppTheory HTTP app** implemented in:

- Go (compiled from this repo)
- Node.js 24 (using the AppTheory TypeScript SDK)
- Python 3.14 (using the AppTheory Python SDK)

Each language is deployed as its own Lambda + HTTP API so you can compare behavior side-by-side.

## Prerequisites

- Node.js `>=24` + `npm`
- Go `1.25.6` (for local bundling of the Go Lambda)
- Python `3.14`
- AWS credentials configured (for deploy; synth does not require AWS access)

## Synth

```bash
cd examples/cdk/multilang
npm ci
npx cdk synth
```

## Deploy

```bash
cd examples/cdk/multilang
npx cdk deploy --all
```

## Configuration

The CDK stack injects a shared configuration story across languages:

- `APPTHEORY_TIER` (defaults to `p2`)
- `APPTHEORY_DEMO_NAME` (defaults to `apptheory-multilang`)

You can override these via CDK context:

```bash
npx cdk synth -c tier=p2 -c name=demo
```

