# MicroVM Controller CDK Example

This example is the AppTheory single path for AWS Lambda MicroVMs:

- `AppTheoryMicrovmImage` builds an endpoint-dispatched MicroVM image with `hooks: {}`. This matches the live AWS behavior verified by the AppTheory steward: runtime HTTP traffic is delivered through the MicroVM endpoint on port 8080 instead of AWS run-hook payloads.
- `AppTheoryMicrovmNetworkConnector.httpIngress`, `.shellIngress`, and `.internetEgress` use the AWS-managed connector references exposed by AppTheory.
- `AppTheoryMicrovmController` deploys the canonical protected HTTP API routes: `run`, `get`, `list`, `suspend`, `resume`, `terminate`, `invoke`, `auth-token`, and `shell-auth-token`.
- The controller Lambda is Go and uses AppTheory's real `microvm.NewAWSLambdaMicroVMProvider` plus the TableTheory-backed session registry when deployed. Local tests still use the constrained fake provider.
- The in-MicroVM workload is selectable in **Go**, **TypeScript**, or **Python** with the same deployment shape.

## Language selection

The default workload is Go. Select another workload at synth/deploy time:

```bash
npm run synth:go
npm run synth:ts
npm run synth:py
```

or pass CDK context directly:

```bash
npx cdk synth -c microvmLanguage=py
```

Each workload directory contains a Dockerfile and a tiny HTTP server listening on port 8080:

- `workloads/go/`
- `workloads/ts/`
- `workloads/py/`

## Local verification

```bash
npm ci
npm run test:controller
npm run test:workloads
npm run build:controller
npm run synth:go
npm run synth:ts
npm run synth:py
```

A direct runtime smoke can also be run from the repository root:

```bash
go test ./examples/cdk/microvm-controller/controller
go test ./examples/cdk/microvm-controller/workloads/go
node --check examples/cdk/microvm-controller/workloads/ts/server.js
python3 -m py_compile examples/cdk/microvm-controller/workloads/py/server.py
```

## Live deployment shape

The stack needs a bootstrapped CDK environment in a region where Lambda MicroVMs are available. The steward verified `us-east-1` with the AWS-managed base image:

```text
arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1
```

Deploy one language at a time by changing `microvmLanguage`:

```bash
AWS_PROFILE=TheoryCloud AWS_REGION=us-east-1 npx cdk deploy \
  -c microvmLanguage=go \
  --require-approval never
```

The deployed controller accepts a demo-only authorization header plus tenant and namespace headers:

```bash
curl -sS -X POST "$MicrovmControllerEndpoint" \
  -H 'Authorization: Bearer local-demo-only' \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant-1' \
  -H 'x-namespace-id: namespace-1' \
  -d '{"namespace":"namespace-1","session_spec":{"metadata":{"example":"go"}}}'
```

Then call the workload through the AppTheory invoke route. The controller mints the provider auth token internally and never exposes `X-aws-proxy-auth` to the caller:

```bash
curl -sS "$MicrovmControllerEndpoint/$SESSION_ID/invoke/hello?name=apptheory" \
  -H 'Authorization: Bearer local-demo-only' \
  -H 'x-tenant-id: tenant-1' \
  -H 'x-namespace-id: namespace-1' \
  -H 'x-apptheory-microvm-port: 8080'
```

`auth-token` and `shell-auth-token` remain available for sanctioned metadata flows. Their responses are intentionally sanitized: AppTheory stores and returns token metadata only, and plaintext provider tokens must not cross the controller boundary.

## Security posture

Controller routes are fail-closed at both layers:

- The CDK construct requires a Lambda authorizer and disables authorizer result caching by default in this example.
- The Go AppTheory app registers only authenticated controller routes and accepts the obvious demo-only header `Authorization: Bearer local-demo-only` together with `x-tenant-id` and `x-namespace-id`.
- The controller uses deployment-pinned image and connector defaults supplied by `AppTheoryMicrovmController`; callers do not need raw image or connector refs for the normal run path.
- The `invoke` route is the single AppTheory path for workload HTTP access; callers do not handle Lambda MicroVM proxy auth headers directly.
- Tenant and namespace mismatches return the AppTheory tenant-binding error envelope.
- `auth-token` and `shell-auth-token` responses expose only sanitized token metadata (`token_id`, `token_type`, `expires_at`, `scope`). They never log, persist, or return plaintext provider token values.
- Reserved `APPTHEORY_MICROVM_*` environment wiring and typed network connector refs remain owned by `AppTheoryMicrovmController`; this example does not override those values.

The local authorization header is not a credential and must not be reused outside this example.
