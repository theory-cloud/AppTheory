# Import Pipeline Constructs

This guide collects the canonical AppTheory CDK constructs used by the import-pipeline support pack.

## Core constructs

- `AppTheoryS3Ingest`: secure S3 ingest bucket with optional EventBridge or SQS notifications
- `AppTheoryJobsTable`: DynamoDB jobs ledger table with `status-created-index` and `tenant-created-index`
- `AppTheoryCodeBuildJobRunner`: CodeBuild wrapper for batch transforms, decrypts, or backfills
- `AppTheoryEventBridgeRuleTarget`: EventBridge schedule or pattern to Lambda wiring
- `AppTheoryQueue`, `AppTheoryQueueConsumer`, `AppTheoryQueueProcessor`: SQS queue and worker patterns

## Minimal composition

```ts
import { AppTheoryJobsTable, AppTheoryS3Ingest } from "@theory-cloud/apptheory-cdk";

const jobs = new AppTheoryJobsTable(stack, "Jobs");
const ingest = new AppTheoryS3Ingest(stack, "Ingest", {
  enableEventBridge: true,
});

jobs.bindEnvironment(workerLambda);
jobs.grantReadWriteTo(workerLambda);
```

## Jobs table contract

`AppTheoryJobsTable` standardizes:

- keys: `pk` and `sk`
- TTL attribute: `ttl`
- point-in-time recovery enabled by default
- retention-oriented defaults suitable for job ledgers

The canonical environment variable contract is `APPTHEORY_JOBS_TABLE_NAME`.

## S3 ingest notes

`AppTheoryS3Ingest` supports:

- secure bucket defaults
- S3 to EventBridge notifications
- S3 to SQS notifications with prefix and suffix filters
- explicit cross-account writer principals

## CodeBuild runner notes

`AppTheoryCodeBuildJobRunner` is intended for steps that should not run in Lambda, such as large transforms or
decryption. It standardizes logs, timeouts, and common grant helpers.

Reference stack: `examples/cdk/import-pipeline/README.md`
