# S3 Ingest (Import Pipeline Front Door)

`AppTheoryS3Ingest` standardizes the first step of most import pipelines: a secure S3 bucket plus optional notifications.

It supports:

- Secure bucket defaults when creating a bucket
- S3 → EventBridge notifications (bucket-level)
- S3 → SQS notifications with prefix/suffix filters
- Optional explicit cross-account writer bucket policies

## Create a secure bucket (defaults)

```typescript
import { AppTheoryS3Ingest } from "@theory-cloud/apptheory-cdk";

const ingest = new AppTheoryS3Ingest(stack, "Ingest");
// ingest.bucket
```

## Enable S3 → EventBridge

```typescript
import { AppTheoryS3Ingest } from "@theory-cloud/apptheory-cdk";

new AppTheoryS3Ingest(stack, "Ingest", {
  enableEventBridge: true,
});
```

## S3 → SQS notifications (with filters)

Prefix/suffix filters are applied as a cartesian product (prefixes×suffixes). For example, 2 prefixes and 2 suffixes produce 4 notifications.

```typescript
import { AppTheoryS3Ingest } from "@theory-cloud/apptheory-cdk";

const ingest = new AppTheoryS3Ingest(stack, "Ingest", {
  queueProps: {
    queueName: "import-ingest",
    enableDlq: true,
  },
  prefixes: ["incoming/"],
  suffixes: [".csv", ".json"],
});

// ingest.queue (created) and ingest.queueConstruct (AppTheoryQueue)
```

## Attach to an existing bucket

```typescript
import { AppTheoryS3Ingest } from "@theory-cloud/apptheory-cdk";
import * as s3 from "aws-cdk-lib/aws-s3";

const bucket = s3.Bucket.fromBucketName(stack, "ExistingBucket", "my-existing-ingest-bucket");

new AppTheoryS3Ingest(stack, "Ingest", {
  bucket,
  enableEventBridge: true,
});
```

## Cross-account writer principals (explicit)

If another AWS account needs to write objects into the ingest bucket, provide `writerPrincipals` to add explicit bucket policies (least privilege, no hidden assume-role behavior).

