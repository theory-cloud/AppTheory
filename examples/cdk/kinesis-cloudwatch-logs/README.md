# Kinesis CloudWatch Logs Ingestion Example

This example shows the AppTheory path for CloudWatch Logs subscription records:

1. `AppTheoryKinesisStream` creates the Kinesis Data Stream.
2. `AppTheoryCloudWatchLogsDestination` exposes a CloudWatch Logs destination with an explicit placeholder source-account and organization allowlist.
3. `AppTheoryFunction` builds a Go Lambda handler.
4. `AppTheoryKinesisStreamMapping` wires the stream to the Lambda consumer with partial batch failures enabled.
5. The Go handler registers an AppTheory Kinesis route and calls `DecodeCloudWatchLogsSubscription` for each record.

The account ID `111122223333` and organization ID `o-example1234` are deterministic placeholders for the example. They are not live account claims. Replace them before any real deployment.

## Structure

```text
kinesis-cloudwatch-logs/
├── bin/app.ts
├── lib/kinesis-cloudwatch-logs-stack.ts
├── handlers/go/main.go
├── handlers/go/main_test.go
├── cdk.json
├── package.json
└── tsconfig.json
```

## Validate locally

```bash
go test ./examples/cdk/kinesis-cloudwatch-logs/handlers/go
cd examples/cdk/kinesis-cloudwatch-logs
npm ci
npm run build
npm run synth -- --quiet --no-notices --no-version-reporting
```

`cdk deploy` is intentionally not part of validation. The example is a synthable pattern; it does not create live cloud resources unless you explicitly deploy it after replacing the placeholders.
