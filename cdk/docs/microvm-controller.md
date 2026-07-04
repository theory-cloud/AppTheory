# MicroVM Controller

`AppTheoryMicrovmController` is the AppTheory CDK surface for deploying the Lambda MicroVM control plane. It creates:

- a controller Lambda from caller-supplied Lambda packaging props;
- protected HTTP API v2 routes for the M15 controller vocabulary;
- a durable DynamoDB session registry table with the canonical TableTheory shape (`pk`/`sk` and TTL `ttl`);
- IAM grants for the session table, scoped MicroVM image actions, network-connector pass-through, and an optional
  MicroVM execution role;
- fail-closed controller environment wiring.

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
- No live AWS mutation happens during construct tests or synthesis.

## TypeScript

```ts
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  AppTheoryMicrovmController,
  AppTheoryMicrovmImage,
  AppTheoryMicrovmNetworkConnector,
} from "@theory-cloud/apptheory-cdk";

const connector = new AppTheoryMicrovmNetworkConnector(this, "MicrovmEgress", {
  vpc,
  subnets,
  securityGroups: [microvmEgressSecurityGroup],
});

const image = new AppTheoryMicrovmImage(this, "MicrovmImage", {
  // required image props omitted for brevity
  egressNetworkConnectors: [connector],
});

const controller = new AppTheoryMicrovmController(this, "MicrovmController", {
  controller: {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromAsset("dist/microvm-controller"),
  },
  authorizer,
  microvmImage: image,
  egressNetworkConnectors: [connector],
  sessionTableName: "my-microvm-sessions",
});

controller.endpoint;
```

## Routes

The construct registers the fixed M15 controller route set:

- `POST /microvms`
- `POST /microvms/{session_id}/start`
- `POST /microvms/{session_id}/stop`
- `GET /microvms/{session_id}/status`
- `GET /microvms/{session_id}`

Each route uses the same controller Lambda integration and the same Lambda request authorizer.

## IAM and environment

The controller Lambda receives:

- read/write permissions on the session registry table;
- MicroVM control-plane permissions scoped to the configured `microvmImage`;
- `lambda:PassNetworkConnector` scoped to the configured egress connector ARNs;
- `iam:PassRole` only when `executionRole` is supplied.

Reserved environment variables:

- `APPTHEORY_MICROVM_CONTRACT_NAME`
- `APPTHEORY_MICROVM_CONTRACT_VERSION`
- `APPTHEORY_MICROVM_CONTROLLER_ENDPOINT`
- `APPTHEORY_MICROVM_CONTROLLER_AUTH_REQUIRED`
- `APPTHEORY_MICROVM_CONTROLLER_AUTH_DEFAULT`
- `APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE`
- `APPTHEORY_MICROVM_IMAGE_REF`
- `APPTHEORY_MICROVM_NETWORK_CONNECTOR_REFS`
- `APPTHEORY_MICROVM_EXECUTION_ROLE_ARN` (only when `executionRole` is supplied)

The real AppTheory MicroVM controllers read `APPTHEORY_MICROVM_EXECUTION_ROLE_ARN` automatically and pass it to provider
`RunMicrovm` requests. Controller code should use the AppTheory runtime/provider primitives instead of accepting
caller-provided role ARNs or forking a raw AWS SDK provider.

## Fail-closed validation

The construct fails synthesis when:

- `controller`, `authorizer`, or `microvmImage` is missing;
- no egress network connector is supplied, or more than 10 are supplied;
- a controller environment variable attempts to override an AppTheory-reserved key;
- customer-managed session-table encryption is selected without a KMS key;
- the authorizer identity header or stage name is empty.
