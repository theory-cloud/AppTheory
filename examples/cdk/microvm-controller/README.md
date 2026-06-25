# MicroVM Controller CDK Example

This example demonstrates the first-class AppTheory Lambda MicroVM controller path without live AWS deployment:

- `AppTheoryMicrovmNetworkConnector` with caller-provided VPC, subnet, and security-group context.
- `AppTheoryMicrovmImage` with MicroVM lifecycle hooks, code artifact URI, resources, and VPC egress connector reference.
- `AppTheoryMicrovmController` with the canonical protected HTTP API routes: `run`, `get`, `list`, `suspend`, `resume`, `terminate`, `auth-token`, and `shell-auth-token`.
- A Go controller Lambda package in `controller/` that uses `apptheory.App.HandleLambda`, `microvm.RegisterControllerRoutes`, `microvm.NewRealController`, a constrained deterministic provider fake, and an AppTheory session registry wrapper with a product-owned reconstruction hook.
- The controller-owned durable session registry table using the TableTheory shape: partition key `pk`, sort key `sk`, and TTL attribute `ttl`.

## Local proof only

This is a local build/synth/runtime example. It does not deploy, perform AWS lookups, mutate an AWS account, or prove live Lambda MicroVM execution. The VPC, subnet, security group, base image, build role, and code artifact values are placeholders so `cdk synth` stays deterministic.

The Go controller uses an in-memory registry and deterministic provider fake for local tests. Production code must bind the same AppTheory route/controller path to a real AppTheory provider adapter and product-owned registry truth; do not replace this with raw AWS SDK routes or account-wide list logic.

## Security posture

Controller routes are fail-closed at both layers:

- The CDK construct requires a Lambda authorizer and disables authorizer result caching by default in this example.
- The Go AppTheory app registers only `RequireAuth` controller routes and accepts the obvious local-only header `Authorization: Bearer local-demo-only` together with `x-tenant-id` and `x-namespace-id`.
- Tenant and namespace mismatches return the AppTheory tenant-binding error envelope.
- `auth-token` and `shell-auth-token` responses expose only sanitized token metadata (`token_id`, `token_type`, `expires_at`, `scope`); they never log, persist, or return plaintext provider token values.
- Registry reconstruction is explicit: the local fake supplies a reconstruction hook, and missing hooks fail closed.
- Reserved `APPTHEORY_MICROVM_*` environment wiring and typed network connector refs remain owned by `AppTheoryMicrovmController`; this example does not override those values.

The local authorization header is not a credential and must not be reused outside this example.

## Commands

```bash
npm ci
npm run test:controller
npm run build:controller
npm run synth
```

Repository validation includes this example through:

```bash
./scripts/verify-cdk-synth.sh
```

A direct runtime smoke can also be run from the repository root:

```bash
go test ./examples/cdk/microvm-controller/controller
```

## TypeScript and Python parity note

The runnable controller package is Go because the current first-class local proof exercises the Go Lambda runtime and constrained provider path directly. TypeScript and Python consumers should keep the same AppTheory semantics and vocabulary through the shared MicroVM contract: do not introduce alternate route names, a `shell-token` canonical route, raw SDK clients, or unauthenticated shortcuts.
