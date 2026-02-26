# CodeBuild Job Runner (Import Pipeline)

`AppTheoryCodeBuildJobRunner` is an opinionated CodeBuild construct intended for batch steps in import pipelines that
should not run in Lambda (PGP decrypt, large transforms, backfills, etc).

It standardizes:

- Safe defaults for build image/compute/timeout
- CloudWatch Logs group with retention (auto-managed by default)
- Optional EventBridge rule hook for build state changes
- Ergonomic grant helpers for S3/DynamoDB/Secrets Manager

## Basic usage

```typescript
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import { AppTheoryCodeBuildJobRunner } from "@theory-cloud/apptheory-cdk";

const runner = new AppTheoryCodeBuildJobRunner(stack, "Runner", {
  buildSpec: codebuild.BuildSpec.fromObject({
    version: "0.2",
    phases: { build: { commands: ["echo hello"] } },
  }),
});
```

## State change rule

```typescript
const runner = new AppTheoryCodeBuildJobRunner(stack, "Runner", {
  buildSpec,
  enableStateChangeRule: true,
});

runner.stateChangeRule?.addTarget(/* your target */);
```

## Common grants

```typescript
runner.grantS3Read(bucket);
runner.grantDynamoRead(jobsTable);
runner.grantSecretRead(secret);
```

