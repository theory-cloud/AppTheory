# Jobs Table (Import Pipeline)

`AppTheoryJobsTable` is an opinionated DynamoDB table construct for import pipeline job ledgers.

It is designed to be the backing table for the runtime “job ledger primitives” (issue `#173`), and standardizes:

- Keys: `pk` / `sk` (string)
- TTL attribute: `ttl` (configurable)
- PITR: enabled by default
- Encryption: AWS-managed by default (optional customer-managed KMS)
- Removal policy: `RETAIN` by default

## GSIs (locked by ADR 0002)

- `status-created-index`: `status` (pk) + `created_at` (sk)
- `tenant-created-index`: `tenant_id` (pk) + `created_at` (sk)

## Basic usage

```typescript
import { AppTheoryJobsTable } from "@theory-cloud/apptheory-cdk";

const jobs = new AppTheoryJobsTable(stack, "Jobs");

jobs.bindEnvironment(workerLambda); // APPTHEORY_JOBS_TABLE_NAME
jobs.grantReadWriteTo(workerLambda);
```

## Environment variable contract

The canonical env var is:

- `APPTHEORY_JOBS_TABLE_NAME`

App code should prefer this name (avoid alias sprawl).

