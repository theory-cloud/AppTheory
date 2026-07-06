# AppTheory CDK Hello World (Go, TypeScript, Python)

This example is the smallest deployable AppTheory HTTP API path. Each variant creates exactly one Lambda function with
an `AppTheoryHttpApi` in front of it:

- Go custom runtime (`-c lang=go`)
- TypeScript on Node.js 24 (`-c lang=ts`)
- Python 3.14 (`-c lang=py`)

All three handlers expose the same routes and response shape:

```text
GET /              -> { "message": "hello world", "runtime": "<lang>", "request_id": "...", "tenant_id": "" }
GET /hello/{name}  -> { "message": "hello {name}", "runtime": "<lang>", "request_id": "...", "tenant_id": "" }
```

The checked-in tests use the AppTheory testkit only; they do not call AWS.

## Prerequisites

- Node.js `>=24` and `npm`
- AWS CDK CLI through the local `npx cdk` dependency
- Go `1.26.4` for the Go variant
- Python `3.14` for the Python variant
- AWS credentials and a selected AWS account/region for `cdk bootstrap`, `cdk deploy`, and `cdk destroy`

## 1. Install dependencies

From a clean clone:

```bash
cd examples/cdk/hello-world
npm ci
```

## 2. Bootstrap the target account/region

Run this once per account/region before the first deployment:

```bash
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=${AWS_REGION:-us-east-1}
npx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}"
```

## 3. Deploy one language variant

Choose exactly one language for each deploy command. The stack name is language-specific, so the variants can be
deployed and destroyed independently.

```bash
# Go
npx cdk deploy -c lang=go AppTheoryHelloWorldGo

# TypeScript
npx cdk deploy -c lang=ts AppTheoryHelloWorldTs

# Python
npx cdk deploy -c lang=py AppTheoryHelloWorldPy
```

The deployment prints an `ApiUrl` output. Save it as `API_URL`.

## 4. Verify with curl

```bash
curl "${API_URL}/hello/AppTheory"
```

Expected shape:

```json
{"message":"hello AppTheory","runtime":"ts","request_id":"...","tenant_id":""}
```

The `runtime` field is `go`, `ts`, or `py` depending on the deployed variant.

## 5. Destroy

```bash
npx cdk destroy -c lang=go AppTheoryHelloWorldGo
npx cdk destroy -c lang=ts AppTheoryHelloWorldTs
npx cdk destroy -c lang=py AppTheoryHelloWorldPy
```

Only destroy stacks you deployed.

## No-AWS validation

The repository gate keeps this example deterministic without creating cloud resources:

```bash
./scripts/verify-testkit-examples.sh
./scripts/verify-cdk-synth.sh
```

`verify-testkit-examples.sh` runs the Go, TypeScript, and Python handler tests through the AppTheory testkit.
`verify-cdk-synth.sh` synthesizes the CDK templates and compares deterministic hashes. It does not run
`cdk bootstrap`, `cdk deploy`, or `cdk destroy`.

The TypeScript and Python synth snapshots intentionally include framework source in their Lambda asset hashes:
`ts/dist/index.js` for TypeScript and `py/src/apptheory/**` for Python. When a runtime change deliberately changes
either input, refresh the hello-world synth snapshot in the same change instead of treating the drift as incidental.

The future `theory-cli` on-ramp should wrap this same scaffold/synth/deploy/curl/destroy sequence. This example remains
repo-local CDK guidance and does not implement cross-repo CLI behavior.
