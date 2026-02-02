# AppTheory CDK Constructs

TS-first `jsii` constructs for deploying AppTheory apps with consistent defaults across Go/TypeScript/Python.

Status: early; start with a small “top 20%” set and grow based on real usage.

## Documentation

* CDK docs index: `cdk/docs/README.md`
* Repo docs index: `docs/README.md`

## Constructs

* `AppTheoryHttpApi` — HTTP API (APIGWv2) + Lambda proxy routes (`/` and `/{proxy+}`).
* `AppTheoryRestApi` — API Gateway REST API v1 + Lambda proxy routes (supports streaming per-method).
* `AppTheoryRestApiRouter` — REST API v1 multi-Lambda router with full streaming parity + stage controls + domain wiring.
* `AppTheoryWebSocketApi` — WebSocket API + routes/permissions (optional connection table + access logging).
* `AppTheoryFunction` — Lambda wrapper with AppTheory-friendly defaults.
* `AppTheoryFunctionAlarms` — baseline CloudWatch alarms for a Lambda function.
* `AppTheoryQueue` — SQS queue with optional DLQ (queue-only friendly).
* `AppTheoryQueueConsumer` — SQS → Lambda event source mapping with full knobs.
* `AppTheoryQueueProcessor` — SQS queue + consumer wiring (convenience wrapper over `AppTheoryQueue` + `AppTheoryQueueConsumer`).
* `AppTheoryEventBridgeHandler` — EventBridge schedule/rule + Lambda target wiring.
* `AppTheoryDynamoDBStreamMapping` — DynamoDB Streams event source mapping + permissions.
* `AppTheoryEventBusTable` — DynamoDB table for AppTheory EventBus (`pk`/`sk` schema + required GSIs).
* `AppTheoryDynamoTable` — general-purpose DynamoDB table construct (schema-explicit + consistent defaults).
* `AppTheoryLambdaRole` — Lambda execution role helper (baseline + X-Ray + KMS + escape hatches).
* `AppTheoryPathRoutedFrontend` — CloudFront distribution for multi-SPA routing + API origin (stage domain pattern).
* `AppTheoryMediaCdn` — CloudFront distribution for an S3-backed media CDN (optional private media via key groups).
* `AppTheoryApp` — higher-level “app” pattern (Lambda + HTTP API + optional DynamoDB tables).
* `AppTheorySsrSite` — SSR site pattern (Lambda + CloudFront + domain/cert helpers).

## Minimal example

```go
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
