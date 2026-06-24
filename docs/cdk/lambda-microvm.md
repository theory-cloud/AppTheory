---
title: Lambda MicroVM CDK Constructs
description: The AppTheory CDK golden path for AWS Lambda MicroVM network, image, controller, and session-registry wiring.
---

# Lambda MicroVM CDK Constructs

AppTheory's MicroVM CDK surface is the deployment side of the M15 MicroVM contract. Use these constructs together:

- `AppTheoryMicrovmNetworkConnector` for caller-owned VPC egress connector wiring;
- `AppTheoryMicrovmImage` for the `AWS::Lambda::MicrovmImage` resource and hook configuration;
- `AppTheoryMicrovmController` for protected controller routes, the controller Lambda, IAM grants, and the durable
  session registry table.

This is the single AppTheory deployment path for MicroVM applications. Do not drop to raw CDK resources or raw AWS SDK
calls to bypass controller auth, lifecycle validation, registry shape, or network-boundary requirements.

## Construct sequence

1. Import or pass the caller-owned `ec2.IVpc`, selected subnets, and explicit security groups.
2. Create `AppTheoryMicrovmNetworkConnector` with that network context.
3. Create `AppTheoryMicrovmImage` with a caller-provided base image, build role, artifact URI, hook configuration,
   logging posture, resources, and the connector reference.
4. Create `AppTheoryMicrovmController` with controller Lambda packaging, a Lambda request authorizer, the image
   reference, connector references, and optional session-table settings.
5. Implement the controller Lambda with AppTheory MicroVM runtime/controller primitives and the session registry table
   name from `APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE`.

The synth-only reference stack lives at `examples/cdk/microvm-controller`. It demonstrates construct wiring without live
AWS lookups or deployment.

## Network connector boundary

`AppTheoryMicrovmNetworkConnector` requires the network boundary to be explicit:

| Prop | Required | Notes |
| --- | --- | --- |
| `vpc` | yes | Caller-provided `ec2.IVpc`. AppTheory does not synthesize or look up a VPC for you. |
| `subnets` | yes | One to sixteen caller-provided subnets. |
| `securityGroups` | yes | One to five caller-provided security groups. No default-security-group fallback. |
| `networkProtocol` | no | Defaults to `AppTheoryMicrovmNetworkProtocol.IPV4`; `DUAL_STACK` is explicit. |
| `operatorRole` | no | Existing role Lambda can assume to manage connector ENIs. |
| `operatorRoleName` | no | Used only when AppTheory creates the operator role; cannot be combined with `operatorRole`. |

When AppTheory creates the operator role, it scopes the ENI policy to the supplied subnet and security-group IDs. The
construct creates the `AWS::Lambda::NetworkConnector` resource but does not vend accounts, mutate unrelated networks, or
invent a hidden connector.

## Image resource and hooks

`AppTheoryMicrovmImage` creates the `AWS::Lambda::MicrovmImage` resource from caller-provided inputs:

| Prop | Required | Notes |
| --- | --- | --- |
| `name`, `description` | yes | Image name and version description. |
| `baseImageArn`, `baseImageVersion` | yes | Caller-selected base image reference. |
| `buildRoleArn` | yes | Caller-provided IAM build role ARN. |
| `codeArtifact.uri` | yes | Artifact URI, such as an S3 path or ECR image URI. |
| `egressNetworkConnectors` | yes | One to ten `IAppTheoryMicrovmNetworkConnector` references. |
| `hooks` | yes | Hook enablement for image-build and runtime MicroVM hooks. |
| `logging` | yes | Exactly one of CloudWatch logging or `disabled: true`. |
| `resources` | yes | Exactly one resource entry; `minimumMemoryInMiB` is required. |
| `additionalOsCapabilities` | no | Defaults to `[ALL]`. |
| `cpuConfigurations` | no | Defaults to ARM64; M15 does not broaden this into arbitrary architectures. |

Hook fields on the image construct configure AWS resource integration:

- `hooks.microvmImageHooks.ready` and `hooks.microvmImageHooks.validate` for image-build hooks;
- `hooks.microvmHooks.resume`, `run`, `suspend`, and `terminate` for runtime MicroVM hooks;
- timeout fields alongside each hook when the AWS resource should enforce a hook timeout.

Application lifecycle behavior still belongs to AppTheory runtime lifecycle adapters. The image construct is not a raw
lifecycle hook bypass.

## Controller deployment

`AppTheoryMicrovmController` provisions:

- an HTTP API v2 API and stage;
- a controller Lambda created from caller-supplied `lambda.FunctionProps`;
- a Lambda request authorizer attached to every controller route;
- the durable TableTheory-shaped DynamoDB session table;
- IAM grants for the constrained Lambda MicroVM control-plane actions, listed MicroVM image, supplied network connector
  ARNs, and optional execution role pass-through;
- fail-closed environment wiring for the controller Lambda.

Required props:

| Prop | Required | Notes |
| --- | --- | --- |
| `controller` | yes | Lambda packaging/configuration. Handler code must use AppTheory MicroVM runtime/controller primitives. |
| `authorizer` | yes | Lambda request authorizer. Omission fails closed; unauthenticated routes are not synthesized. |
| `microvmImage` | yes | `IAppTheoryMicrovmImage` reference the controller may run. |
| `egressNetworkConnectors` | yes | Connector references the controller may pass to Lambda MicroVMs. |

Controller routes are fixed:

| Method | Path | Command |
| --- | --- | --- |
| `POST` | `/microvms` | `create` |
| `POST` | `/microvms/{session_id}/start` | `start` |
| `POST` | `/microvms/{session_id}/stop` | `stop` |
| `GET` | `/microvms/{session_id}/status` | `status` |
| `GET` | `/microvms/{session_id}` | `session` |

The construct sets these controller environment variables:

| Variable | Meaning |
| --- | --- |
| `APPTHEORY_MICROVM_CONTRACT_NAME` | `apptheory.lambda_microvm` |
| `APPTHEORY_MICROVM_CONTRACT_VERSION` | `m15.microvm/v1` |
| `APPTHEORY_MICROVM_CONTROLLER_ENDPOINT` | Synthesized `/microvms` base endpoint. |
| `APPTHEORY_MICROVM_CONTROLLER_AUTH_REQUIRED` | Always `true`. |
| `APPTHEORY_MICROVM_CONTROLLER_AUTH_DEFAULT` | Always `deny`. |
| `APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE` | Durable session table name. |
| `APPTHEORY_MICROVM_IMAGE_REF` | Permitted MicroVM image ARN/reference. |
| `APPTHEORY_MICROVM_NETWORK_CONNECTOR_REFS` | Comma-separated permitted connector ARNs. |
| `APPTHEORY_MICROVM_EXECUTION_ROLE_ARN` | Present only when an execution role is supplied. |

Reserved environment variables cannot be overridden through `controller.environment`.

## Session table shape

The controller-created table is the canonical durable session registry:

- partition key: `pk` (`STRING`);
- sort key: `sk` (`STRING`);
- TTL attribute: `ttl`;
- default billing: `PAY_PER_REQUEST`;
- default removal policy: `RETAIN`;
- point-in-time recovery enabled by default;
- AWS-managed encryption by default, with customer-managed KMS supported only when a key is supplied.

Records use the TableTheory/DynamoDB key shape:

| Field | Canonical value |
| --- | --- |
| `pk` | `TENANT#<tenant_id>#NAMESPACE#<namespace>` |
| `sk` | `SESSION#<session_id>` |
| `ttl` | Unix expiry derived from `expires_at` |

Controller/session handlers must use this registry table rather than route-local memory, ad-hoc tables, or raw SDK
storage. The durable record is tenant-bound and includes session state, desired state, image/network refs, controller ID,
creation/update/expiry fields, generation/version fields, last command metadata, auth subject, and optional safe
metadata.

## Authentication posture

Controller routes are protected and fail closed by default. A production authorizer must bind the caller to the tenant,
namespace, subject, and entitlements expected by the controller envelope. The example's demo token authorizer is only a
synth-time shape example; it is not production auth proof.

The authorizer result cache defaults to `Duration.seconds(0)`. Increase it only when your tenant-bound authorization
model can tolerate cached decisions.

## Evidence boundary and non-goals

The CDK docs and example demonstrate synth-time wiring for the AppTheory construct surface. They do not prove live AWS
deployment, customer workload behavior, cloud mutation, account vending, VPC creation, or that unauthenticated
controllers are acceptable.

M15 intentionally does not add:

- raw AWS SDK escape hatches;
- raw lifecycle hook bypasses;
- unauthenticated controller defaults;
- hidden account, VPC, subnet, security-group, or network connector mutation;
- a deployment path outside AppTheory CDK constructs.

## Validation

For this docs surface, ordinary repository validation is:

```bash
make test
```

When changing runtime-visible behavior or exported API, also run the contract and snapshot gates described in
[Contract Fixtures](../reference/contract-fixtures.md).
