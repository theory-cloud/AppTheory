---
title: First-class AWS Lambda MicroVM Support
description: The M15 golden path for fixture-backed Lambda MicroVM lifecycle, controller, registry, and CDK deployment support.
---

# First-class AWS Lambda MicroVM Support

M15 grows the Lambda MicroVM work from a contract foundation into an **evidence-bounded golden path** for AppTheory
applications that need first-class AWS Lambda MicroVM primitives. The path is still AppTheory's path: fixture-backed
runtime vocabulary, constrained controllers, durable TableTheory-shaped session records, and CDK constructs that wire the
deployment surface without introducing raw AWS SDK or raw lifecycle-hook bypasses.

The contract name is `apptheory.lambda_microvm`; the fixture version is `m15.microvm/v1`. Fixtures live under
`contract-tests/fixtures/m15/` and are validated by the Go, TypeScript, and Python contract runners.

## What the M15 feature line proves

M15 provides evidence for the AppTheory framework surface only:

- shared fixtures for lifecycle vocabulary, controller/session command envelopes, durable session-registry requirements,
  and denial cases;
- Go, TypeScript, and Python runtime primitives for lifecycle adapters, constrained MicroVM controllers, fake clients,
  AWS adapter factories, and durable registry adapters;
- CDK constructs for the MicroVM network connector, image resource, and protected controller deployment surface;
- a synth-only controller example that demonstrates how the constructs are assembled.

This evidence does **not** claim live deployment proof, cloud mutation proof, customer workload proof, generalized
account vending, or proof that unauthenticated controllers are acceptable. Demo-only authorizers and placeholder example
values are examples of shape, not production authentication or deployment evidence.

## Golden path

Use these pieces together. Do not replace one piece with an ad-hoc implementation.

1. **Model lifecycle through the AppTheory lifecycle adapter.** Handlers receive a sanitized `MicroVMLifecycleEvent` and
   return through the adapter's safe result/error envelope. They do not receive raw AWS hook payloads and they do not get
   a raw SDK client.
2. **Deploy network and image resources through AppTheory CDK constructs.** The network connector is bound to
   caller-provided VPC, subnet, and security-group context. The image references that connector and declares lifecycle
   hook enablement, logging, resources, base image, build role, and artifact URI.
3. **Expose the controller through `AppTheoryMicrovmController`.** The controller HTTP routes are fixed, protected by a
   Lambda request authorizer, and backed by the construct-created durable session table.
4. **Persist controller state through the durable session registry.** Controller and session routes use the registry
   table shape rather than ad-hoc storage.

## Lifecycle hooks

The runtime lifecycle contract is language-neutral. All three runtimes validate the same hook/state vocabulary:

| Hook | Active state | Success state | Failure state | Purpose |
| --- | --- | --- | --- | --- |
| `prepare_image` | `image_preparing` | `image_prepared` | `failed` | Prepare image-specific session state before start. |
| `start` | `starting` | `started` | `failed` | Start the MicroVM session through the constrained client. |
| `readiness` | `readiness_probing` | `ready` | `failed` | Confirm the session is ready before callers treat it as usable. |
| `stop` | `stopping` | `stopped` | `failed` | Stop a running session. |
| `teardown` | `tearing_down` | `terminated` | `failed` | Tear down session state and end the lifecycle. |
| `failure` | `failed` | `failed` | `failed` | Record terminal failure without widening the contract. |

The event shape is intentionally small: `request_id`, `tenant_id`, `namespace`, `session_id`, `hook`, `state`, and safe
string metadata. The adapter fails closed for missing handlers, malformed events, unsupported transitions, forbidden
metadata, or explicit `raw_lifecycle_hook_bypass` requests.

The CDK image construct also exposes AWS Lambda MicroVM hook **configuration** fields:

| CDK hook group | Fields | Boundary |
| --- | --- | --- |
| `microvmImageHooks` | `ready`, `validate` | Enables or disables image-build hook integration for `AWS::Lambda::MicrovmImage`. |
| `microvmHooks` | `resume`, `run`, `suspend`, `terminate` | Enables or disables runtime MicroVM hook integration for the image resource. |

Those CDK fields configure the AWS resource. Application behavior still goes through the AppTheory runtime lifecycle
adapter and its sanitized event/result contract.

## Controller routes

`AppTheoryMicrovmController` exposes the fixed M15 controller surface under `/microvms`:

| Command | Method | Route | Required request fields | Registry use |
| --- | --- | --- | --- | --- |
| `create` | `POST` | `/microvms` | `image_ref`, `network_connector_ref`, `session_spec` | Creates the tenant-bound session record. |
| `start` | `POST` | `/microvms/{session_id}/start` | `session_id` | Loads and updates the existing session record. |
| `stop` | `POST` | `/microvms/{session_id}/stop` | `session_id` | Loads and updates the existing session record. |
| `status` | `GET` | `/microvms/{session_id}/status` | `session_id` | Reads status through the session registry/client boundary. |
| `session` | `GET` | `/microvms/{session_id}` | `session_id` | Returns the durable tenant-bound session record. |

The controller request envelope requires `command`, `request_id`, `tenant_id`, `namespace`, and `auth_context`. Safe
errors expose only `code`, `message`, and `request_id`. The envelope and durable records forbid raw AWS credentials,
raw SDK clients, bearer tokens, raw lifecycle hook payloads, and plaintext session tokens.

## Authentication posture

Controller routes are **protected and fail closed by default**:

- `AppTheoryMicrovmController` requires an `authorizer` Lambda function and attaches it to every fixed route.
- The construct sets `APPTHEORY_MICROVM_CONTROLLER_AUTH_REQUIRED=true` and
  `APPTHEORY_MICROVM_CONTROLLER_AUTH_DEFAULT=deny` for the controller Lambda.
- The authorizer result cache defaults to `Duration.seconds(0)` so stale decisions do not silently broaden controller
  access.
- The runtime controller requires authenticated, tenant-bound requests. `tenant_id`, `namespace`, and `auth_context`
  must agree with the caller's authorization model.

The synth-only example uses a `DemoOnlyTokenAuthorizer` to prove route wiring. That authorizer is not production auth
proof and must be replaced with a tenant-bound AppTheory authorizer before deployment.

## VPC and network boundary

AppTheory does not hide account or network mutation behind the MicroVM primitive.

`AppTheoryMicrovmNetworkConnector` requires caller-provided network context:

- `vpc`: the application's VPC boundary;
- `subnets`: one to sixteen caller-selected subnets where Lambda may attach connector ENIs;
- `securityGroups`: one to five explicit security groups;
- optional `operatorRole` or an AppTheory-created operator role scoped to the supplied subnet/security-group IDs.

The construct does not synthesize a VPC, select a default security group, vend an AWS account, mutate sibling accounts,
or perform live AWS lookups. The controller and image constructs receive network connector references from this boundary;
there is no hidden fallback connector.

## Durable session registry shape

The durable registry is TableTheory/DynamoDB-shaped and tenant-bound. `AppTheoryMicrovmController` creates a DynamoDB
session table with:

- partition key `pk` (`STRING`);
- sort key `sk` (`STRING`);
- TTL attribute `ttl`;
- point-in-time recovery enabled by default;
- `RemovalPolicy.RETAIN` by default.

Canonical keys are derived from tenant and session identity:

| Field | Canonical value |
| --- | --- |
| `pk` | `TENANT#<tenant_id>#NAMESPACE#<namespace>` |
| `sk` | `SESSION#<session_id>` |
| `ttl` | Unix expiry derived from `expires_at` |

Canonical durable records include `tenant_id`, `namespace`, `session_id`, `state`, `desired_state`, `image_ref`,
`network_connector_ref`, `controller_id`, `created_at`, `updated_at`, `expires_at`, `generation`, `version`,
`last_action`, `last_command_id`, `auth_subject`, and optional `endpoint`, `microvm_id`, and safe metadata.

The session and controller routes must use this registry shape. Do not replace it with route-local memory, an ad-hoc
DynamoDB schema, raw SDK calls, or per-controller private storage.

## Explicit out of scope

M15 does not provide or prove:

- live AWS deployment success;
- cloud mutation receipts or customer workload execution;
- generalized account vending, VPC vending, or network mutation outside caller-provided VPC/subnet/security-group
  inputs;
- permission to expose unauthenticated controller routes;
- raw AWS SDK access from application code;
- raw lifecycle hook payload access or a hook bypass path;
- a TypeScript-only, Python-only, or Go-only MicroVM behavior variant;
- registry-published packages or a deployment path outside GitHub Releases and AppTheory CDK constructs.

If one of those capabilities becomes necessary, grow the AppTheory contract first with fixtures and cross-runtime parity.
Do not add a private escape hatch.

## Related docs and examples

- [MicroVM CDK constructs](../cdk/lambda-microvm.md)
- [Contract fixtures](../reference/contract-fixtures.md)
- `examples/cdk/microvm-controller`

## Validation

Run the shared contract runners when changing runtime-visible behavior:

```bash
./scripts/verify-contract-tests.sh
```

Run the repository gate for ordinary validation:

```bash
make test
```
