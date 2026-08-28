# MicroVM Image

`AppTheoryMicrovmImage` is the AppTheory CDK surface for Lambda MicroVM images. It synthesizes the
CloudFormation `AWS::Lambda::MicrovmImage` resource using the current AWS property names and nested shape for code
artifact, base image, build role, hooks, logging, resources, environment variables, and egress network connectors.

Official AWS reference: <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-microvmimage.html>

## Contract boundary

- Caller supplies the code artifact URI, base image ARN/version, and build role ARN.
- Egress is wired through `AppTheoryMicrovmNetworkConnector` references; AppTheory does not create a VPC here.
- The required normalized `logging` posture is exposed on `IAppTheoryMicrovmImage` so
  `AppTheoryMicrovmController` can propagate the same choice to every runtime `RunMicrovm` call.
- The construct is deployment-only; runtime MicroVM lifecycle and controller behavior remain in the AppTheory runtime
  contract.
- No live AWS mutation happens during construct tests or synthesis.

## TypeScript

```ts
import {
  AppTheoryMicrovmHookMode,
  AppTheoryMicrovmImage,
  AppTheoryMicrovmNetworkConnector,
  IAppTheoryMicrovmImage,
} from "@theory-cloud/apptheory-cdk";

const connector = new AppTheoryMicrovmNetworkConnector(this, "MicrovmEgress", {
  vpc,
  subnets,
  securityGroups: [microvmEgressSecurityGroup],
  connectorName: "my_microvm_egress",
});

const image = new AppTheoryMicrovmImage(this, "MicrovmImage", {
  name: "my-microvm-image",
  description: "My AppTheory MicroVM image",
  baseImageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image/base",
  baseImageVersion: "1",
  buildRoleArn: "arn:aws:iam::123456789012:role/MicrovmBuildRole",
  codeArtifact: { uri: "s3://my-artifacts/microvm/app.tar" },
  egressNetworkConnectors: [connector],
  hooks: {
    port: 8080,
    microvmImageHooks: {
      ready: AppTheoryMicrovmHookMode.ENABLED,
      readyTimeoutInSeconds: 120,
      validate: AppTheoryMicrovmHookMode.ENABLED,
      validateTimeoutInSeconds: 300,
    },
    microvmHooks: {
      run: AppTheoryMicrovmHookMode.ENABLED,
      runTimeoutInSeconds: 30,
      suspend: AppTheoryMicrovmHookMode.ENABLED,
      suspendTimeoutInSeconds: 10,
      resume: AppTheoryMicrovmHookMode.DISABLED,
      terminate: AppTheoryMicrovmHookMode.ENABLED,
      terminateTimeoutInSeconds: 15,
    },
  },
  logging: {
    cloudWatch: {
      logGroup: "/aws/lambda/microvm/my-service",
      logStream: "image-build",
    },
  },
  resources: [{ minimumMemoryInMiB: 2048 }],
  environmentVariables: [{ key: "APP_ENV", value: "prod" }],
});

image.microvmImageArn;
```

## Logging

`logging` is fail-closed: specify exactly one of `cloudWatch` or `disabled: true`. It is not only a
CloudFormation image property; it is the deployment-owned runtime posture exposed through `IAppTheoryMicrovmImage` and
copied by `AppTheoryMicrovmController` into the reserved `APPTHEORY_MICROVM_LOGGING` value.

```ts
new AppTheoryMicrovmImage(this, "MicrovmImage", {
  // required image props omitted for brevity
  logging: { disabled: true },
});
```

CloudWatch mode requires the consuming controller to receive `executionRole`. The MicroVM execution role must trust
Lambda for `sts:AssumeRole`, allow `sts:TagSession`, and allow `logs:CreateLogGroup`, `logs:CreateLogStream`, and
`logs:PutLogEvents`. It is separate from `buildRoleArn`.

Imported/structural references also carry the posture:

```ts
const importedImage: IAppTheoryMicrovmImage = {
  microvmImageArn: importedImageArn,
  logging: { disabled: true },
};
```

Omitted logging, both members, and `disabled: false` are invalid. HTTP `run` callers cannot override the image's
deployment-owned choice. See the canonical
[AppTheory 2.0 migration guide](../../docs/migration/microvm-runtime-logging-v2.md).

## Defaults and validation

- `additionalOsCapabilities` defaults to `ALL`, the currently documented AWS value.
- `cpuConfigurations` defaults to one `ARM_64` entry; non-ARM MicroVM images are outside the v1 AppTheory contract.
- `resources` must contain exactly one entry because the AWS resource currently allows one `Resources` item.
- `egressNetworkConnectors` requires one to ten `AppTheoryMicrovmNetworkConnector` references.
- Environment variables are rendered as AWS `Key`/`Value` entries and duplicate keys fail closed.

## Version pruning

Every deployment that touches the image prunes old image versions. This is always-on encoded
behavior with no deploy-time knobs.

The construct synthesizes a custom resource whose inline Node handler talks to the Lambda MicroVMs
control plane:

- `ListMicrovmImageVersions` — `GET /2025-09-09/microvm-images/{imageIdentifier}/versions`
- `DeleteMicrovmImageVersion` — `DELETE /2025-09-09/microvm-images/{imageIdentifier}/versions/{imageVersion}`

requests are SigV4-signed with signing name `lambda` against `lambda.{region}.amazonaws.com`.

### Semantics

- The prune custom resource mirrors the image's rendered CloudFormation properties, so it is
  re-invoked exactly when the `AWS::Lambda::MicrovmImage` resource would be updated, and the image
  resource carries an explicit `DependsOn` on the prune custom resource. CloudFormation therefore
  prunes BEFORE the image update creates a new version.
- The handler keeps the two newest versions whose status is `ACTIVE` and attempts to delete every
  other version. Keeping the previous ACTIVE version as a safety copy protects MicroVMs that may
  still be running against it, without relying on service-side refusal (409) alone. Steady state is
  bounded: everything older than the previous active version is pruned on the next deploy before the
  new version is created, so an image never accumulates versions past the service quota.
- On a fresh stack CREATE the image does not exist yet, so the version list returns 404
  (`ResourceNotFoundException`); the handler treats a 404 on the list as nothing to prune and the
  create succeeds. On stack DELETE the handler returns success without pruning because
  CloudFormation deletes the whole image; pruning never blocks or fails deletion.
- The prune handler's execution role is least privilege: exactly `lambda:ListMicrovmImageVersions`
  and `lambda:DeleteMicrovmImageVersion` on the specific image ARN. No wildcard service permissions.

### Failure semantics

- A list failure (authentication, transport, service error) fails the deployment loudly. Silent quota
  debt is exactly the failure mode this behavior exists to prevent. The one exception: a 404
  (`ResourceNotFoundException`) from the version list means the image does not exist yet (fresh stack
  CREATE) and is treated as nothing to prune.
- A per-version delete refusal — for example a version still in use by running MicroVMs — is logged
  with a visible line and skipped; the deployment continues. The next deployment retries the version.
- Every run logs a one-line summary: versions seen, deleted, and skipped.
