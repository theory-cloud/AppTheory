# MicroVM Controller

`AppTheoryMicrovmController` is the AppTheory CDK surface for deploying the Lambda MicroVM control plane. It creates:

- a controller Lambda from caller-supplied Lambda packaging props;
- protected HTTP API v2 routes for the real M16 controller vocabulary;
- a durable DynamoDB session registry table with the canonical TableTheory shape (`pk`/`sk` and TTL `ttl`);
- IAM grants for the session table, scoped MicroVM image actions, network-connector pass-through, and a caller-supplied
  MicroVM execution role when required;
- fail-closed controller environment wiring, including the image's required runtime logging posture.

Official AWS references:

- Lambda MicroVM guide: <https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html>
- RunMicrovm API: <https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html>

## Contract boundary

- The construct is a deployment contract only. Handler code must use AppTheory's MicroVM runtime/controller primitives;
  the CDK construct does not implement a product control-plane service.
- All controller routes are authenticated with a Lambda request authorizer. Omitting `authorizer` fails synthesis.
- AppTheory owns the session table shape: partition key `pk`, sort key `sk`, TTL attribute `ttl`, point-in-time recovery
  enabled by default, and AWS-managed encryption by default.
- The table name is wired to the runtime's canonical `APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE` environment variable.
- The controller environment also pins `APPTHEORY_MICROVM_CONTROLLER_AUTH_REQUIRED=true` and
  `APPTHEORY_MICROVM_CONTROLLER_AUTH_DEFAULT=deny`. Caller-provided Lambda environment variables cannot override
  AppTheory-reserved MicroVM keys.
- Logging is deployment-owned. The controller copies the normalized CloudWatch-or-disabled choice from
  `microvmImage.logging` into `APPTHEORY_MICROVM_LOGGING`; HTTP callers cannot replace it.
- No live AWS mutation happens during construct tests or synthesis.

## TypeScript

```ts
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  AppTheoryMicrovmController,
  AppTheoryMicrovmImage,
  AppTheoryMicrovmNetworkConnector,
} from "@theory-cloud/apptheory-cdk";

const egress = AppTheoryMicrovmNetworkConnector.internetEgress(this, "MicrovmEgress");
const ingress = AppTheoryMicrovmNetworkConnector.httpIngress(this, "MicrovmIngress");
const shellIngress = AppTheoryMicrovmNetworkConnector.shellIngress(this, "MicrovmShellIngress");

const executionRole = new iam.Role(this, "MicrovmExecutionRole", {
  assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
});

const image = new AppTheoryMicrovmImage(this, "MicrovmImage", {
  // required image props omitted for brevity
  egressNetworkConnectors: [egress],
  logging: {
    cloudWatch: {
      logGroup: "/aws/lambda/microvms/my-service",
      logStream: "runtime",
    },
  },
});

const controller = new AppTheoryMicrovmController(this, "MicrovmController", {
  controller: {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromAsset("dist/microvm-controller"),
  },
  authorizer,
  microvmImage: image,
  ingressNetworkConnectors: [ingress],
  egressNetworkConnectors: [egress],
  shellIngressNetworkConnector: shellIngress,
  executionRole,
  sessionTableName: "my-microvm-sessions",
});

controller.endpoint;
```

The abbreviated example does not show the execution-role trust addition or Logs policy. CloudWatch mode requires
`sts:AssumeRole`, `sts:TagSession`, `logs:CreateLogGroup`, `logs:CreateLogStream`, and `logs:PutLogEvents`; use
`examples/cdk/microvm-controller` as the runnable reference.

## Routes

The construct registers the fixed M16 controller route set:

- `POST /microvms` (`run`)
- `GET /microvms` (`list`)
- `GET /microvms/{session_id}` (`get`)
- `POST /microvms/{session_id}/suspend`
- `POST /microvms/{session_id}/resume`
- `DELETE /microvms/{session_id}` (`terminate`)
- `ANY /microvms/{session_id}/invoke`
- `ANY /microvms/{session_id}/invoke/{proxy+}`
- `POST /microvms/{session_id}/auth-token`
- `POST /microvms/{session_id}/shell-auth-token`

Each route uses the same controller Lambda integration and the same Lambda request authorizer.

## IAM and environment

The controller Lambda receives:

- read/write permissions on the session registry table;
- MicroVM control-plane permissions scoped to the configured `microvmImage`;
- permission-only `lambda:PassNetworkConnector`, with the usable ingress/egress/shell connector set constrained by
  typed props and reserved environment wiring;
- `iam:PassRole` only when `executionRole` is supplied.

Reserved environment variables:

- `APPTHEORY_MICROVM_CONTRACT_NAME`
- `APPTHEORY_MICROVM_CONTRACT_VERSION`
- `APPTHEORY_MICROVM_CONTROLLER_ENDPOINT`
- `APPTHEORY_MICROVM_CONTROLLER_OPERATIONS`
- `APPTHEORY_MICROVM_CONTROLLER_ROUTES`
- `APPTHEORY_MICROVM_CONTROLLER_AUTH_REQUIRED`
- `APPTHEORY_MICROVM_CONTROLLER_AUTH_DEFAULT`
- `APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE`
- `APPTHEORY_MICROVM_IMAGE_REF`
- `APPTHEORY_MICROVM_NETWORK_CONNECTOR_REFS`
- `APPTHEORY_MICROVM_INGRESS_NETWORK_CONNECTOR_REFS`
- `APPTHEORY_MICROVM_EGRESS_NETWORK_CONNECTOR_REFS`
- `APPTHEORY_MICROVM_SHELL_INGRESS_NETWORK_CONNECTOR_REF`
- `APPTHEORY_MICROVM_EXECUTION_ROLE_ARN` (only when `executionRole` is supplied)
- `APPTHEORY_MICROVM_LOGGING`

The real AppTheory MicroVM controllers read `APPTHEORY_MICROVM_EXECUTION_ROLE_ARN` and
`APPTHEORY_MICROVM_LOGGING` automatically and pass them to provider `RunMicrovm` requests. Controller code should use the
AppTheory runtime/provider primitives instead of accepting caller-provided role/logging values or forking a raw AWS SDK
provider.

## Runtime logging

`microvmImage.logging` must contain exactly one of:

```ts
{ cloudWatch: { logGroup: "/aws/lambda/microvms/my-service", logStream: "runtime" } }
```

or:

```ts
{ disabled: true }
```

CloudWatch mode requires `executionRole`. That role must trust Lambda for `sts:AssumeRole`, allow `sts:TagSession`, and
allow `logs:CreateLogGroup`, `logs:CreateLogStream`, and `logs:PutLogEvents`. AppTheory grants pass-role access but does
not inspect or mutate caller-owned policies.

Structural `IAppTheoryMicrovmImage` references must now carry their normalized `logging` posture. See the canonical
[AppTheory 2.0 migration guide](../../docs/migration/microvm-runtime-logging-v2.md).

## Fail-closed validation

The construct fails synthesis when:

- `controller`, `authorizer`, or `microvmImage` is missing;
- an ingress, egress, or shell-ingress connector set is missing, has the wrong typed kind, or exceeds its bound;
- `microvmImage.logging` is missing or does not contain exactly one valid member;
- CloudWatch logging is selected without `executionRole`;
- a controller environment variable attempts to override an AppTheory-reserved key;
- customer-managed session-table encryption is selected without a KMS key;
- the authorizer identity header or stage name is empty.
