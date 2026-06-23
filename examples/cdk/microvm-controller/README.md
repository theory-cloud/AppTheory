# MicroVM Controller CDK Example

This synth-only example demonstrates the first-class AppTheory Lambda MicroVM deployment path:

- `AppTheoryMicrovmNetworkConnector` with caller-provided VPC, subnet, and security-group context.
- `AppTheoryMicrovmImage` with MicroVM lifecycle hooks, code artifact URI, resources, and VPC egress connector reference.
- `AppTheoryMicrovmController` with protected HTTP API routes and controller Lambda packaging.
- The controller-owned durable session registry table using the TableTheory shape: partition key `pk`, sort key `sk`, and TTL attribute `ttl`.

## Security posture

The example is for synthesis and review only. It does not deploy and it does not perform live AWS lookups. The VPC, subnet,
security group, base image, build role, and code artifact values are placeholders.

Controller routes remain protected. The `DemoOnlyTokenAuthorizer` is intentionally named demo-only and authorizes only the
literal header `Authorization: Bearer demo-microvm-token`. Do not reuse it in production; replace it with a tenant-bound
AppTheory authorizer before deployment.

The controller Lambda body is also a synth-only placeholder that returns `501`. Production controller handlers must use
AppTheory's MicroVM runtime/controller primitives and the session registry table provided through
`APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE`.

## Commands

```bash
npm ci
npm run synth
```

Repository validation includes this example through:

```bash
./scripts/verify-cdk-synth.sh
```
