# SQS Queue + Consumer Patterns

This guide covers the SQS queue constructs in AppTheory CDK, including composable patterns for queue-only deployments, queue + consumer, and the convenience `AppTheoryQueueProcessor` construct.

## Overview

AppTheory CDK provides three SQS-related constructs:

| Construct | Purpose |
|-----------|---------|
| `AppTheoryQueue` | Standalone queue with optional DLQ |
| `AppTheoryQueueConsumer` | Event source mapping from queue to Lambda |
| `AppTheoryQueueProcessor` | Combined queue + consumer (convenience) |

## AppTheoryQueue

Creates an SQS queue with optional Dead Letter Queue (DLQ) support. Use this when you need:

- A queue for message producers (other services, APIs, etc.)
- Manual consumer management
- Composition with `AppTheoryQueueConsumer` for flexible patterns

### Basic Usage

```typescript
import { AppTheoryQueue } from "@theory-cloud/apptheory-cdk";
import { Duration } from "aws-cdk-lib";

// Queue without DLQ
const simpleQueue = new AppTheoryQueue(stack, "SimpleQueue", {
  queueName: "my-queue",
  enableDlq: false,
});

// Queue with DLQ (default when enableDlq: true)
const queueWithDlq = new AppTheoryQueue(stack, "QueueWithDlq", {
  queueName: "my-queue",
  enableDlq: true,
  maxReceiveCount: 5,
  visibilityTimeout: Duration.seconds(60),
  dlqRetentionPeriod: Duration.days(14),
});
```

### Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `queueName` | `string` | CloudFormation-generated | Name of the queue |
| `enableDlq` | `boolean` | `true` | Whether to create a Dead Letter Queue |
| `maxReceiveCount` | `number` | `3` | Max receives before sending to DLQ |
| `visibilityTimeout` | `Duration` | `30 seconds` | Visibility timeout |
| `retentionPeriod` | `Duration` | `4 days` | Message retention period |
| `dlqVisibilityTimeout` | `Duration` | Same as main queue | DLQ visibility timeout |
| `dlqRetentionPeriod` | `Duration` | `14 days` | DLQ retention period |
| `encryption` | `QueueEncryption` | AWS managed | Encryption type |
| `fifo` | `boolean` | `false` | Whether queue is FIFO |
| `grantSendMessagesTo` | `IFunction[]` | - | Lambdas with send permission |
| `removalPolicy` | `RemovalPolicy` | `DESTROY` | Removal policy |

### Outputs

- `queue` - The main SQS queue
- `deadLetterQueue` - The DLQ (if enabled)
- `queueArn` - ARN of the main queue
- `queueUrl` - URL of the main queue
- `queueName` - Name of the main queue

## AppTheoryQueueConsumer

Creates an event source mapping between an SQS queue and a Lambda function with full control over batching, concurrency, and failure reporting.

### Basic Usage

```typescript
import { AppTheoryQueue, AppTheoryQueueConsumer } from "@theory-cloud/apptheory-cdk";
import { Duration } from "aws-cdk-lib";

const queue = new AppTheoryQueue(stack, "Queue", {
  queueName: "my-queue",
  enableDlq: true,
});

new AppTheoryQueueConsumer(stack, "Consumer", {
  queue: queue.queue,
  consumer: myLambda,
  batchSize: 100,
  maxBatchingWindow: Duration.seconds(10),
  reportBatchItemFailures: true,
  maxConcurrency: 50,
});
```

### Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `queue` | `IQueue` | **Required** | The SQS queue to consume from |
| `consumer` | `IFunction` | **Required** | Lambda function to process messages |
| `batchSize` | `number` | `10` | Max records per batch |
| `maxBatchingWindow` | `Duration` | No window | Max wait time for batch |
| `reportBatchItemFailures` | `boolean` | `false` | Enable partial batch failure reporting |
| `maxConcurrency` | `number` | No limit | Max concurrent Lambda instances (2-1000) |
| `enabled` | `boolean` | `true` | Whether mapping is enabled |
| `grantConsumeMessages` | `boolean` | `true` | Auto-grant consume permissions |
| `filters` | `FilterCriteria[]` | All messages | Message filters |

### Partial Batch Failure Reporting

When `reportBatchItemFailures: true`, your Lambda should return a response indicating which items failed:

```typescript
export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  return { batchItemFailures };
};
```

## AppTheoryQueueProcessor

A convenience construct that combines `AppTheoryQueue` and `AppTheoryQueueConsumer` into a single pattern. Use this for quick queue + consumer setups.

### Basic Usage

```typescript
import { AppTheoryQueueProcessor } from "@theory-cloud/apptheory-cdk";
import { Duration } from "aws-cdk-lib";

// Simple processor (backwards compatible)
new AppTheoryQueueProcessor(stack, "Processor", {
  consumer: myLambda,
});

// Processor with DLQ and full options
new AppTheoryQueueProcessor(stack, "Processor", {
  consumer: myLambda,
  queueName: "my-queue",
  enableDlq: true,
  maxReceiveCount: 5,
  batchSize: 100,
  maxBatchingWindow: Duration.seconds(10),
  reportBatchItemFailures: true,
  maxConcurrency: 50,
});
```

### Properties

Inherits properties from both `AppTheoryQueue` and `AppTheoryQueueConsumer`:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `consumer` | `IFunction` | **Required** | Lambda function to process messages |
| `queueName` | `string` | CloudFormation-generated | Queue name |
| `enableDlq` | `boolean` | `false`* | Whether to create DLQ |
| `maxReceiveCount` | `number` | `3` | Max receives before DLQ |
| `visibilityTimeout` | `Duration` | `30 seconds` | Visibility timeout |
| `batchSize` | `number` | `10` | Max records per batch |
| `maxBatchingWindow` | `Duration` | No window | Max wait time for batch |
| `reportBatchItemFailures` | `boolean` | `false` | Enable partial failures |
| `maxConcurrency` | `number` | No limit | Max concurrent instances |
| `enabled` | `boolean` | `true` | Whether mapping is enabled |

*Note: `enableDlq` defaults to `false` for backwards compatibility with the original implementation.

### Outputs

- `queue` - The main SQS queue
- `queueConstruct` - The underlying `AppTheoryQueue`
- `consumerConstruct` - The underlying `AppTheoryQueueConsumer`
- `deadLetterQueue` - The DLQ (if enabled)

## Patterns

### Pattern 1: Queue-Only (Contract Queue)

For scenarios where external services produce messages and you manage consumption separately:

```typescript
const contractQueue = new AppTheoryQueue(stack, "ContractQueue", {
  queueName: "contract-events",
  enableDlq: true,
  maxReceiveCount: 3,
});

// Grant access to producer Lambda
contractQueue.grantSendMessages(producerLambda);

// Export queue URL for external producers
new CfnOutput(stack, "QueueUrl", {
  value: contractQueue.queueUrl,
});
```

### Pattern 2: Queue + Consumer (Composable)

For maximum flexibility with separate queue and consumer configuration:

```typescript
const queue = new AppTheoryQueue(stack, "Queue", {
  queueName: "events",
  enableDlq: true,
  maxReceiveCount: 5,
});

// Primary consumer with high throughput
new AppTheoryQueueConsumer(stack, "PrimaryConsumer", {
  queue: queue.queue,
  consumer: primaryLambda,
  batchSize: 100,
  maxConcurrency: 100,
  reportBatchItemFailures: true,
});

// Grant additional producer access
queue.grantSendMessages(apiLambda);
```

### Pattern 3: Simple Processor

For quick queue + consumer setup with minimal configuration:

```typescript
const processor = new AppTheoryQueueProcessor(stack, "Processor", {
  consumer: workerLambda,
  enableDlq: true,
  batchSize: 50,
});

// Grant producer access to the queue
processor.queue.grantSendMessages(producerLambda);
```

### Pattern 4: DLQ Processing

Handle failed messages from a DLQ:

```typescript
const mainQueue = new AppTheoryQueue(stack, "MainQueue", {
  queueName: "main-events",
  enableDlq: true,
});

// Main consumer
new AppTheoryQueueConsumer(stack, "MainConsumer", {
  queue: mainQueue.queue,
  consumer: mainLambda,
  reportBatchItemFailures: true,
});

// DLQ consumer for failed message handling
if (mainQueue.deadLetterQueue) {
  new AppTheoryQueueConsumer(stack, "DlqConsumer", {
    queue: mainQueue.deadLetterQueue,
    consumer: dlqHandlerLambda,
    batchSize: 1, // Process one at a time for debugging
  });
}
```

## Best Practices

### 1. Always Enable DLQ for Production

```typescript
new AppTheoryQueue(stack, "Queue", {
  enableDlq: true,
  maxReceiveCount: 3,  // Fail fast
  dlqRetentionPeriod: Duration.days(14),  // Retain for investigation
});
```

### 2. Use Partial Batch Failures for High-Throughput Processing

```typescript
new AppTheoryQueueConsumer(stack, "Consumer", {
  queue: queue.queue,
  consumer: myLambda,
  batchSize: 100,
  reportBatchItemFailures: true,  // Don't reprocess successful items
});
```

### 3. Set Visibility Timeout Based on Lambda Timeout

```typescript
// Lambda timeout: 5 minutes
const lambdaTimeout = Duration.minutes(5);

new AppTheoryQueue(stack, "Queue", {
  // 6x Lambda timeout for safety (AWS recommendation)
  visibilityTimeout: Duration.minutes(30),
});
```

### 4. Use Max Concurrency to Protect Downstream

```typescript
new AppTheoryQueueConsumer(stack, "Consumer", {
  queue: queue.queue,
  consumer: myLambda,
  maxConcurrency: 10,  // Limit concurrent database connections
});
```

## Migration from Lift CDK

If you're migrating from Lift CDK's SQS constructs:

```typescript
// Before (Lift CDK pattern)
const queue = new sqs.Queue(stack, "Queue", { ... });
new lambda.EventSourceMapping(stack, "Mapping", { ... });

// After (AppTheory CDK)
const processor = new AppTheoryQueueProcessor(stack, "Processor", {
  consumer: myLambda,
  enableDlq: true,
  batchSize: 10,
});
```

For more control, use the composable pattern with `AppTheoryQueue` + `AppTheoryQueueConsumer`.
