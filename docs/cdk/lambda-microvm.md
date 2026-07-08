---
title: Lambda MicroVM CDK Constructs
description: The AppTheory CDK golden path for corrective M16 AWS Lambda MicroVM network, image, protected controller, invoke, and session-registry wiring.
---

# Lambda MicroVM CDK Constructs

AppTheory's MicroVM CDK surface is the deployment side of the corrective M16 MicroVM contract. The `v1.14.0` / M15
foundation should not be cited as complete live MicroVM support; new controller docs, examples, and conformance proof use
`m16.microvm/v1` and the real operation vocabulary.

Use these constructs together:

- `AppTheoryMicrovmNetworkConnector` or typed connector references for caller-owned and AWS-managed connector wiring;
- `AppTheoryMicrovmImage` for the `AWS::Lambda::MicrovmImage` resource and hook configuration;
- `AppTheoryMicrovmController` for protected real controller routes, the controller Lambda, IAM grants, fail-closed
  environment wiring, token-hidden workload invocation, and the durable session registry table.

This is the single AppTheory deployment path for MicroVM applications. Do not drop to raw CDK resources or raw AWS SDK
calls to bypass controller auth, lifecycle validation, registry shape, token safety, or network-boundary requirements.

## Construct sequence

1. Import or pass the caller-owned `ec2.IVpc`, selected subnets, and explicit security groups for any VPC egress
   connector AppTheory creates.
2. Create `AppTheoryMicrovmNetworkConnector` for VPC egress, or pass explicitly typed imported/AWS-managed connector
   references with the correct connector kind.
3. Create `AppTheoryMicrovmImage` with a caller-provided base image, build role, artifact URI, hook configuration,
   logging posture, resources, and egress connector references.
4. Create `AppTheoryMicrovmController` with controller Lambda packaging, a Lambda request authorizer, the image reference,
   explicit ingress connector references, explicit egress connector references, an explicit shell-ingress connector
   reference, and optional session-table settings.
5. Implement the controller Lambda with AppTheory MicroVM runtime/controller primitives and the session registry table
   name from `APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE`.
6. Use `examples/microvm-conformance` for consumer proof. Local dry-run proves harness readiness only; live proof requires
   a consumer-provided EqualToAI/Host lab deployment and configuration.

The runnable reference stack lives at `examples/cdk/microvm-controller`. It demonstrates construct wiring,
endpoint-dispatched no-hook image builds, and Go/TypeScript/Python workload invocation through the AppTheory controller.
Synthesis does not perform live AWS lookups; deployment requires a bootstrapped account in a region where Lambda
MicroVMs are available.

## Network connector boundary

`AppTheoryMicrovmNetworkConnector` creates VPC egress connectors from explicit caller-owned network context:

| Prop | Required | Notes |
| --- | --- | --- |
| `vpc` | yes | Caller-provided `ec2.IVpc`. AppTheory does not synthesize or look up a VPC for you. |
| `subnets` | yes | One to sixteen caller-provided subnets. |
| `securityGroups` | yes | One to five caller-provided security groups. No default-security-group fallback. |
| `networkProtocol` | no | Defaults to `AppTheoryMicrovmNetworkProtocol.IPV4`; `DUAL_STACK` is explicit. |
| `operatorRole` | no | Existing role Lambda can assume to manage connector ENIs. |
| `operatorRoleName` | no | Used only when AppTheory creates the operator role; cannot be combined with `operatorRole`. |

The same CDK surface exposes typed imported/AWS-managed connector references:

| Helper | Connector kind | Use |
| --- | --- | --- |
| `fromNetworkConnectorArn(..., kind)` | caller-supplied | Import a connector while preserving the ingress/egress/shell kind. |
| `allIngress(...)` | ingress | AWS-managed all-ingress connector reference. |
| `noIngress(...)` | ingress | AWS-managed no-ingress connector reference. |
| `internetEgress(...)` | egress | AWS-managed internet-egress connector reference. |
| `shellIngress(...)` | shell-ingress | AWS-managed shell-ingress connector required for shell auth-token support. |

When AppTheory creates an egress connector, it scopes the ENI policy to the supplied subnet and security-group IDs. The
construct creates the `AWS::Lambda::NetworkConnector` resource but does not vend accounts, mutate unrelated networks, or
invent hidden connectors.

## Image resource and hooks

`AppTheoryMicrovmImage` creates the `AWS::Lambda::MicrovmImage` resource from caller-provided inputs:

| Prop | Required | Notes |
| --- | --- | --- |
| `name`, `description` | yes | Image name and version description. |
| `baseImageArn`, `baseImageVersion` | yes | Caller-selected base image reference. |
| `buildRoleArn` | yes | Caller-provided IAM build role ARN. |
| `codeArtifact.uri` | yes | Artifact URI, such as an S3 path or ECR image URI. |
| `egressNetworkConnectors` | yes | One to ten egress connector references. |
| `hooks` | yes | Hook configuration object. Use `{}` for endpoint-dispatched no-hook images. |
| `logging` | yes | Exactly one of CloudWatch logging or `disabled: true`. |
| `resources` | yes | Exactly one resource entry; `minimumMemoryInMiB` is required. |
| `additionalOsCapabilities` | no | Defaults to `[ALL]`. |
| `cpuConfigurations` | no | Defaults to ARM64; AppTheory does not broaden this into arbitrary architectures. |

For the AppTheory endpoint-dispatched workload path, pass `hooks: {}`. AppTheory then synthesizes `Hooks: {}` so AWS
builds the image without AWS-invoked lifecycle hooks; runtime HTTP traffic is delivered through the MicroVM endpoint and
proxied by the controller `invoke` route.

When AWS hook integration is intentionally configured, hook fields on the image construct are:

- `hooks.microvmImageHooks.ready` and `hooks.microvmImageHooks.validate` for image-build hooks;
- `hooks.microvmHooks.resume`, `run`, `suspend`, and `terminate` for runtime MicroVM hooks;
- timeout fields alongside each hook when the AWS resource should enforce a hook timeout.

Application lifecycle behavior still belongs to AppTheory runtime lifecycle adapters. The image construct is not a raw
lifecycle hook bypass, and hook configuration is not the workload HTTP access path.

## Controller deployment

`AppTheoryMicrovmController` provisions:

- an HTTP API v2 API and stage;
- a controller Lambda created from caller-supplied `lambda.FunctionProps`;
- a Lambda request authorizer attached to every controller route;
- the durable TableTheory-shaped DynamoDB session table;
- IAM grants for the constrained Lambda MicroVM control-plane actions, `ListMicrovms`, permission-only
  `PassNetworkConnector`, the supplied MicroVM image, supplied network connector references, and optional execution-role
  pass-through;
- fail-closed environment wiring for the controller Lambda.

Required props:

| Prop | Required | Notes |
| --- | --- | --- |
| `controller` | yes | Lambda packaging/configuration. Handler code must use AppTheory MicroVM runtime/controller primitives. |
| `authorizer` | yes | Lambda request authorizer. Omission fails closed; unauthenticated routes are not synthesized. |
| `microvmImage` | yes | `IAppTheoryMicrovmImage` reference the controller may run. |
| `ingressNetworkConnectors` | yes | Ingress connector references the controller may pass to Lambda MicroVMs. |
| `egressNetworkConnectors` | yes | Egress connector references the controller may pass to Lambda MicroVMs. |
| `shellIngressNetworkConnector` | yes | Shell-ingress connector required for `shell-auth-token` support. |

Controller routes are fixed:

| Method | Path | Operation |
| --- | --- | --- |
| `POST` | `/microvms` | `run` |
| `GET` | `/microvms` | `list` |
| `GET` | `/microvms/{session_id}` | `get` |
| `POST` | `/microvms/{session_id}/suspend` | `suspend` |
| `POST` | `/microvms/{session_id}/resume` | `resume` |
| `DELETE` | `/microvms/{session_id}` | `terminate` |
| `ANY` | `/microvms/{session_id}/invoke` | `invoke` |
| `ANY` | `/microvms/{session_id}/invoke/{proxy+}` | `invoke` |
| `POST` | `/microvms/{session_id}/auth-token` | `auth-token` |
| `POST` | `/microvms/{session_id}/shell-auth-token` | `shell-auth-token` |

The invoke routes are the single AppTheory path for ordinary workload HTTP access. Callers use the same controller
authorizer plus tenant and namespace headers, optionally pass `X-AppTheory-MicroVM-Port` (the example workloads use
`8080`), and receive the workload's sanitized HTTP response. The controller mints the provider auth token internally and
does not expose `X-aws-proxy-auth`, provider bearer credentials, raw AWS SDK clients, or plaintext tokens to callers.

`shell-auth-token` is canonical. Runtime route helpers may accept `shell-token` as a compatibility alias, but the CDK
construct and conformance harness do not use it as a canonical route.

The construct sets these controller environment variables:

| Variable | Meaning |
| --- | --- |
| `APPTHEORY_MICROVM_CONTRACT_NAME` | `apptheory.lambda_microvm` |
| `APPTHEORY_MICROVM_CONTRACT_VERSION` | `m16.microvm/v1` |
| `APPTHEORY_MICROVM_CONTROLLER_ENDPOINT` | Synthesized `/microvms` base endpoint. |
| `APPTHEORY_MICROVM_CONTROLLER_OPERATIONS` | Comma-separated canonical operations, including `invoke`. |
| `APPTHEORY_MICROVM_CONTROLLER_ROUTES` | Comma-separated canonical method/path pairs, including root/proxy invoke routes. |
| `APPTHEORY_MICROVM_CONTROLLER_AUTH_REQUIRED` | Always `true`. |
| `APPTHEORY_MICROVM_CONTROLLER_AUTH_DEFAULT` | Always `deny`. |
| `APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE` | Durable session table name. |
| `APPTHEORY_MICROVM_IMAGE_REF` | Permitted MicroVM image ARN/reference. |
| `APPTHEORY_MICROVM_NETWORK_CONNECTOR_REFS` | Compatibility egress connector reference list. |
| `APPTHEORY_MICROVM_INGRESS_NETWORK_CONNECTOR_REFS` | Permitted ingress connector references. |
| `APPTHEORY_MICROVM_EGRESS_NETWORK_CONNECTOR_REFS` | Permitted egress connector references. |
| `APPTHEORY_MICROVM_SHELL_INGRESS_NETWORK_CONNECTOR_REF` | Required shell-ingress connector reference. |
| `APPTHEORY_MICROVM_EXECUTION_ROLE_ARN` | Present only when an execution role is supplied; the real runtime controller reads it and passes it to provider `RunMicrovm` as the MicroVM execution role. |

Reserved environment variables cannot be overridden through `controller.environment`.

When `executionRole` is supplied, controller handlers should stay on the AppTheory MicroVM golden path: construct the
real controller through `NewRealController` / `createRealMicroVMController` / `create_real_microvm_controller` and use the
official provider adapter. Those controllers consume `APPTHEORY_MICROVM_EXECUTION_ROLE_ARN` automatically. Do not accept
caller-provided role ARNs over the HTTP route and do not fork the AWS SDK provider only to set `ExecutionRoleArn`.

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
storage. The durable record is tenant-bound and includes session state, desired state, image/network refs, provider
binding, AWS lifecycle state, controller ID, creation/update/expiry fields, generation/version fields, last command
metadata, auth subject, token metadata, and optional safe metadata.

## Authentication posture

Controller routes are protected and fail closed by default. A production authorizer must bind the caller to the tenant,
namespace, subject, and entitlements expected by the controller envelope. The example's demo token authorizer is only a
synth-time shape example; it is not production auth proof.

The authorizer result cache defaults to `Duration.seconds(0)`. Increase it only when your tenant-bound authorization
model can tolerate cached decisions.

## Evidence boundary and non-goals

The CDK docs and examples demonstrate repo-local wiring for the AppTheory construct surface. The reference example has
been live-smoked in `us-east-1` with Go, TypeScript, and Python workloads through the AppTheory invoke route. That does
not prove EqualToAI/Host application behavior, customer workload readiness, arbitrary cloud mutation, account vending,
VPC creation, or that unauthenticated controllers are acceptable.

AppTheory intentionally does not add:

- raw AWS SDK escape hatches;
- raw lifecycle hook bypasses;
- unauthenticated controller defaults;
- hidden account, VPC, subnet, security-group, or network connector mutation;
- a deployment path outside AppTheory CDK constructs;
- release-train execution or immutable GitHub Release creation.

## Validation

For this docs surface, ordinary repository validation is:

```bash
make test
```

When changing runtime-visible behavior or exported API, also run the contract and snapshot gates described in
[Contract Fixtures](../reference/contract-fixtures.md). When changing MicroVM conformance coverage, run:

```bash
./scripts/verify-microvm-conformance-harness.sh
```
