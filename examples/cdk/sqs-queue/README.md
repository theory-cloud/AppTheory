# SQS Queue Example

This example demonstrates the composable SQS constructs in AppTheory CDK:

- `AppTheoryQueue` - Standalone queue with DLQ
- `AppTheoryQueueConsumer` - Event source mapping to Lambda
- `AppTheoryQueueProcessor` - Combined queue + consumer

## Features Demonstrated

- **Queue-only mode**: Queue for external producers (contract queue pattern)
- **Queue + consumer composition**: Separate queue and consumer for maximum flexibility
- **Processor mode**: Combined queue + consumer for simple use cases
- **DLQ support**: Dead Letter Queue with configurable max receive count
- **Full event-source options**: Batch size, batching window, partial failures, concurrency

## Structure

```
sqs-queue/
├── bin/
│   └── app.ts              # CDK app entry point
├── lib/
│   └── sqs-stack.ts        # Stack definition
├── handlers/
│   ├── producer.mjs        # Producer Lambda (API)
│   ├── worker.mjs          # Main worker Lambda
│   └── dlq-handler.mjs     # DLQ handler Lambda
├── cdk.json
├── package.json
└── tsconfig.json
```

## Deploy

```bash
npm install
npx cdk deploy
```

## Test

### Send a message to the queue

```bash
aws sqs send-message \
  --queue-url <QueueUrl from output> \
  --message-body '{"event": "test", "data": "hello"}'
```

### Watch worker logs

```bash
aws logs tail /aws/lambda/<WorkerFunctionName>
```

## Acceptance Criteria

This example proves:

1. ✅ Queue-only mode (no event-source mapping)
2. ✅ Queue + consumer mode with full options
3. ✅ DLQ creation and configuration
4. ✅ Batch size, batching window, partial failures
5. ✅ Max concurrency limiting
6. ✅ AppTheory can synthesize the same queue/DLQ/event-source mapping shape as Lesser's Lift-era stack
