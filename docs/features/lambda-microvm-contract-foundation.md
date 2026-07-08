---
title: AWS Lambda MicroVM Golden Path
description: The corrective M16 AppTheory path for fixture-backed Lambda MicroVM lifecycle, token-hidden invoke, provider, controller, registry, CDK, and consumer conformance support.
---

# AWS Lambda MicroVM Golden Path

AppTheory's Lambda MicroVM support is an evidence-bounded framework path, not a shortcut around the runtime contract.
The `v1.14.0` / M15 line established a fixture-backed foundation, but it must not be described as complete live
first-class MicroVM support. The corrective M16 line is the canonical AppTheory path for real Lambda MicroVM operation
vocabulary, protected controller routes, token-hidden workload invocation, provider adapters, durable registry state, CDK
wiring, and consumer conformance harness proof.

The contract name is `apptheory.lambda_microvm`; the corrective fixture version is `m16.microvm/v1`. Corrective
fixtures live under `contract-tests/fixtures/microvm-operations/` and are validated by the Go, TypeScript, and Python contract runners.
The earlier M15 fixtures remain part of the compatibility history, but the real operation vocabulary below is canonical
for new docs, routes, conformance harnesses, and reviews.

This page is repository-local documentation for the integration line. The current example path has been live-smoked in
`us-east-1` with Go, TypeScript, and Python MicroVM workloads through the AppTheory controller invoke route. That is
example-path proof for this repository, not stable release evidence, EqualToAI/Host application proof, customer workload
readiness, or release-train execution evidence.

## What AppTheory proves

AppTheory can prove the framework surface locally:

- shared M16 fixtures for the real operation contract, route auth, tenant binding, protected invoke routing, lifecycle
  bypass denial, raw SDK denial, and token no-leak denial;
- Go, TypeScript, and Python runtime primitives for sanitized lifecycle adapters, constrained MicroVM controllers,
  provider adapters, token-hidden workload invocation, fake clients, provider-aware session records, and durable registry
  adapters;
- CDK constructs for typed ingress, egress, and shell-ingress connector references, MicroVM images, protected controller
  deployment, IAM grants, endpoint-dispatched no-hook images, and fail-closed environment wiring;
- a runnable controller example with Go, TypeScript, and Python in-MicroVM workloads, plus an AppTheory-owned consumer
  conformance harness that can be run in local dry-run mode.

That evidence does **not** claim arbitrary cloud mutation proof, customer workload proof, generalized account vending, or
proof that unauthenticated controllers are acceptable. Live application proof belongs to a consumer-provided
EqualToAI/Host lab run of the conformance harness with real lab configuration and supplied registry/log artifacts. Until
that external run exists, the acceptable claim is AppTheory example-path proof plus local corrective gate proof.

## Golden path

Use these pieces together. Do not replace one piece with an ad-hoc implementation.

1. **Model lifecycle through the AppTheory lifecycle adapter.** Handlers receive sanitized `MicroVMLifecycleEvent`
   values and return through the adapter's safe result/error envelope. They do not receive raw AWS hook payloads and they
   do not get raw SDK clients.
2. **Use the constrained provider surface.** Runtime code calls AppTheory `Run`, `Get`, `List`, `Suspend`, `Resume`,
   `Terminate`, `Invoke`, `CreateAuthToken`, and `CreateShellToken` provider methods through AppTheory request/response
   structs. Raw credentials, raw AWS SDK clients, bearer tokens, provider payloads, and plaintext session tokens are not
   part of the provider interface.
3. **Expose the controller through the fixed AppTheory routes.** Controller routes are protected, tenant-bound, and backed
   by the durable session registry. The canonical route/command names are `run`, `get`, `list`, `suspend`, `resume`,
   `terminate`, `invoke`, `auth-token`, and `shell-auth-token`.
4. **Deploy through AppTheory CDK constructs.** The deployment path is `AppTheoryMicrovmNetworkConnector` or typed
   connector references, `AppTheoryMicrovmImage`, and `AppTheoryMicrovmController`. The controller requires explicit
   ingress, egress, and shell-ingress connector references; AppTheory does not hide connector defaults.
5. **Persist controller state through the durable session registry.** Controller and session routes use the canonical
   TableTheory/DynamoDB-shaped registry instead of route-local memory, ad-hoc tables, or raw SDK calls.
6. **Use the conformance harness for consumer proof.** Local dry-run proves the harness is ready. Live EqualToAI/Host
   proof exists only when the consumer runs it against a deployed lab controller.

## Real lifecycle hooks

The corrective runtime lifecycle contract is language-neutral. All three runtimes validate the same M16 hook/state
vocabulary:

| Hook | Active state | Success state | Failure state | Purpose |
| --- | --- | --- | --- | --- |
| `validate` | `validating` | `validated` | `failed` | Validate a requested MicroVM before provider `run`. |
| `run` | `running` | `running` | `failed` | Track the provider `RunMicrovm` operation. |
| `ready` | `ready` | `ready` | `failed` | Record a ready observation without widening the state model. |
| `suspend` | `suspending` | `suspended` | `failed` | Track provider suspend. |
| `resume` | `resuming` | `ready` | `failed` | Track provider resume. |
| `terminate` | `terminating` | `terminated` | `failed` | Track provider terminate. |
| `failure` | `failed` | `failed` | `failed` | Record terminal failure without widening the contract. |

The event shape stays intentionally small: `request_id`, `tenant_id`, `namespace`, `session_id`, `hook`, `state`, and
safe string metadata. The adapter fails closed for missing handlers, malformed events, unsupported transitions,
forbidden metadata, or explicit `raw_lifecycle_hook_bypass` requests.

The CDK image construct exposes AWS Lambda MicroVM hook **configuration** fields, but the live AppTheory workload path is
endpoint-dispatched HTTP with no AWS-invoked hooks. For that path, pass `hooks: {}` to `AppTheoryMicrovmImage`; AppTheory
synthesizes `Hooks: {}` and traffic is delivered through the MicroVM endpoint.

When hook configuration is needed, the available fields are:

| CDK hook group | Fields | Boundary |
| --- | --- | --- |
| `microvmImageHooks` | `ready`, `validate` | Enables or disables image-build hook integration for `AWS::Lambda::MicrovmImage`. |
| `microvmHooks` | `resume`, `run`, `suspend`, `terminate` | Enables or disables runtime MicroVM hook integration for the image resource. |

Those CDK fields configure the AWS resource. Application behavior still goes through the AppTheory runtime lifecycle
adapter and its sanitized event/result contract. Do not use hook configuration as a back door around the controller
invoke route.

## Real controller routes

`AppTheoryMicrovmController` and the runtime route helpers expose the fixed M16 controller surface under `/microvms`:

| Operation | Method | Route | Required request fields | Response boundary |
| --- | --- | --- | --- | --- |
| `run` | `POST` | `/microvms` | `tenant_id`, `namespace`, `image_ref`, connector refs, `session_spec` | Session ID, provider MicroVM ID, state, provider state, registry version. |
| `list` | `GET` | `/microvms` | `tenant_id`, `namespace` | Tenant/namespace-bound sessions and recovery cursor. |
| `get` | `GET` | `/microvms/{session_id}` | `tenant_id`, `namespace`, `session_id` | Tenant-bound session state and provider state. |
| `suspend` | `POST` | `/microvms/{session_id}/suspend` | `tenant_id`, `namespace`, `session_id` | Updated state, provider state, registry version. |
| `resume` | `POST` | `/microvms/{session_id}/resume` | `tenant_id`, `namespace`, `session_id` | Updated state, provider state, registry version. |
| `terminate` | `DELETE` | `/microvms/{session_id}` | `tenant_id`, `namespace`, `session_id` | Terminal-or-denied state, provider state, registry version. |
| `invoke` | `ANY` | `/microvms/{session_id}/invoke` and `/microvms/{session_id}/invoke/{proxy+}` | `tenant_id`, `namespace`, `session_id`, optional `X-AppTheory-MicroVM-Port` | Proxied workload status, sanitized headers, body bytes, and base64 flag. |
| `auth-token` | `POST` | `/microvms/{session_id}/auth-token` | `tenant_id`, `namespace`, `session_id`, optional port scope | Sanitized `token_id`, `token_type`, `expires_at`, and `scope` only. |
| `shell-auth-token` | `POST` | `/microvms/{session_id}/shell-auth-token` | `tenant_id`, `namespace`, `session_id` | Sanitized `token_id`, `token_type`, `expires_at`, and `scope` only. |

`auth-token` and `shell-auth-token` responses must never expose provider token values, bearer credentials, raw AWS
credentials, or plaintext session tokens. `shell-auth-token` is canonical. `shell-token` may appear in API snapshots or
runtime compatibility aliases for earlier corrective callers, but it is not the canonical route or command.

`invoke` is the only AppTheory path for ordinary HTTP traffic into a running MicroVM workload. The caller sends normal
controller auth, tenant, and namespace headers to AppTheory. The controller reads the tenant-bound session endpoint from
the durable registry, mints the provider auth token internally, forwards the request to the MicroVM endpoint, and returns
only a sanitized HTTP response. `X-aws-proxy-auth`, bearer credentials, AWS SDK clients, raw provider token values, and
session tokens never cross the controller boundary.

The optional caller control headers are intentionally small:

| Header | Meaning |
| --- | --- |
| `X-AppTheory-MicroVM-Port` | Workload port to invoke. The example workloads listen on `8080`. |
| `X-AppTheory-MicroVM-Token-TTL` | Short auth-token TTL for the provider proxy request. |

Controller invoke removes hop-by-hop headers, AppTheory tenant/namespace control headers, provider proxy auth headers,
and `Authorization` before forwarding to the MicroVM workload. Query parameters reserved for AppTheory control are also
not forwarded.

The MicroVM execution role is deployment-owned, not caller-owned. When the CDK construct is configured with
`executionRole`, it sets `APPTHEORY_MICROVM_EXECUTION_ROLE_ARN`; the real controller reads that environment value and
passes it through the constrained provider request to AWS `RunMicrovm.ExecutionRoleArn`. Product HTTP requests should
not choose role ARNs, and consumers must not fork the provider or drop to raw SDK calls to add the field.

## Authentication posture

Controller routes are **protected and fail closed by default**:

- `AppTheoryMicrovmController` requires an `authorizer` Lambda function and attaches it to every fixed route.
- The construct sets `APPTHEORY_MICROVM_CONTROLLER_AUTH_REQUIRED=true` and
  `APPTHEORY_MICROVM_CONTROLLER_AUTH_DEFAULT=deny` for the controller Lambda.
- The authorizer result cache defaults to `Duration.seconds(0)` so stale decisions do not silently broaden controller
  access.
- The runtime controller requires authenticated, tenant-bound requests. `tenant_id`, `namespace`, and `auth_context`
  must agree with the caller's authorization model.

The examples use demo-only authorizers to prove route wiring. They are not production auth proof and must be replaced
with tenant-bound AppTheory authorization before deployment.

## Network and CDK boundary

AppTheory does not hide account or network mutation behind the MicroVM primitive.

`AppTheoryMicrovmNetworkConnector` creates caller-owned VPC egress connectors from explicit `vpc`, `subnets`, and
`securityGroups`. The CDK surface also exposes typed references for AWS-managed or imported connectors:

- `AppTheoryMicrovmNetworkConnector.allIngress(...)` and `.noIngress(...)` for ingress;
- `AppTheoryMicrovmNetworkConnector.internetEgress(...)` or created/imported egress connectors for egress;
- `AppTheoryMicrovmNetworkConnector.shellIngress(...)` for shell auth-token support.

`AppTheoryMicrovmController` requires `ingressNetworkConnectors`, `egressNetworkConnectors`, and
`shellIngressNetworkConnector` so the route/IAM/environment contract can fail closed. The construct does not synthesize a
VPC, select a default security group, vend an AWS account, mutate sibling accounts, or perform live AWS lookups.

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

Canonical durable records include tenant, namespace, session, image, connector, provider binding, AWS lifecycle,
registry version, timestamps, generation/version fields, last action metadata, auth subject, token metadata, and safe
metadata only. The session and controller routes must use this registry shape. Do not replace it with route-local memory,
an ad-hoc DynamoDB schema, raw SDK calls, or per-controller private storage.

## Compatibility and version boundary

- `m16.microvm/v1` is the canonical corrective contract version for real MicroVM operations.
- `m15.microvm/v1` and the synthetic `create`, `start`, `stop`, `status`, and `session` vocabulary were foundation and
  compatibility surfaces, not complete live support.
- API snapshots may still list legacy compatibility constants. Do not use those constants as evidence that the old
  vocabulary is canonical for new controller routes or conformance proof.
- Release execution, immutable tags, and stable release proof remain out of scope for this docs page.

## Explicit out of scope

AppTheory does not provide or prove:

- live AWS behavior beyond the verified AppTheory example path;
- EqualToAI/Host application proof without a consumer-run live harness;
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
- `examples/microvm-conformance`

## Validation

Run the shared contract runners when changing runtime-visible behavior:

```bash
./scripts/verify-contract-tests.sh
```

Run the local conformance harness proof without mutating AWS:

```bash
./scripts/verify-microvm-conformance-harness.sh
```

Run the repository gate for ordinary validation:

```bash
make test
```
