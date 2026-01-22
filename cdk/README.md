# AppTheory CDK Constructs

TS-first `jsii` constructs for deploying AppTheory apps with consistent defaults across Go/TypeScript/Python.

Status: early; start with a small “top 20%” set and grow based on real usage.

## Constructs

- `AppTheoryHttpApi` — HTTP API (APIGWv2) + Lambda proxy routes (`/` and `/{proxy+}`).
- `AppTheoryRestApi` — API Gateway REST API v1 + Lambda proxy routes (supports streaming per-method).
- `AppTheoryFunction` — Lambda wrapper with AppTheory-friendly defaults.
- `AppTheoryFunctionAlarms` — baseline CloudWatch alarms for a Lambda function.
- `AppTheoryQueueProcessor` — SQS queue + consumer wiring.
- `AppTheoryEventBridgeHandler` — EventBridge schedule/rule + Lambda target wiring.
- `AppTheoryDynamoDBStreamMapping` — DynamoDB Streams event source mapping + permissions.

## Minimal example

```ts
import { Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { AppTheoryHttpApi } from "@theory-cloud/apptheory-cdk";

const stack = new Stack();
const fn = new lambda.Function(stack, "Handler", {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: "index.handler",
  code: lambda.Code.fromAsset("dist"),
});

new AppTheoryHttpApi(stack, "Api", { handler: fn, apiName: "my-api" });
```

## Development

```bash
cd cdk
npm ci
npm test
```
