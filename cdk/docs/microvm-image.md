# MicroVM Image

`AppTheoryMicrovmImage` is the AppTheory CDK surface for Lambda MicroVM images. It synthesizes the
CloudFormation `AWS::Lambda::MicrovmImage` resource using the current AWS property names and nested shape for code
artifact, base image, build role, hooks, logging, resources, environment variables, and egress network connectors.

Official AWS reference: <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-microvmimage.html>

## Contract boundary

- Caller supplies the code artifact URI, base image ARN/version, and build role ARN.
- Egress is wired through `AppTheoryMicrovmNetworkConnector` references; AppTheory does not create a VPC here.
- The construct is deployment-only; runtime MicroVM lifecycle and controller behavior remain in the AppTheory runtime
  contract.
- No live AWS mutation happens during construct tests or synthesis.

## TypeScript

```ts
import {
  AppTheoryMicrovmHookMode,
  AppTheoryMicrovmImage,
  AppTheoryMicrovmNetworkConnector,
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

`logging` is fail-closed: specify exactly one of `cloudWatch` or `disabled: true`.

```ts
new AppTheoryMicrovmImage(this, "MicrovmImage", {
  // required image props omitted for brevity
  logging: { disabled: true },
});
```

## Defaults and validation

- `additionalOsCapabilities` defaults to `ALL`, the currently documented AWS value.
- `cpuConfigurations` defaults to one `ARM_64` entry; non-ARM MicroVM images are outside the v1 AppTheory contract.
- `resources` must contain exactly one entry because the AWS resource currently allows one `Resources` item.
- `egressNetworkConnectors` requires one to ten `AppTheoryMicrovmNetworkConnector` references.
- Environment variables are rendered as AWS `Key`/`Value` entries and duplicate keys fail closed.
