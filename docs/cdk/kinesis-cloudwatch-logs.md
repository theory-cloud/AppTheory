# Kinesis + CloudWatch Logs

AppTheory's Kinesis ingestion path is a single chain:

```text
CloudWatch Logs subscription
  -> AppTheoryCloudWatchLogsDestination
  -> AppTheoryKinesisStream
  -> AppTheoryKinesisStreamMapping
  -> AppTheory Lambda runtime
  -> DecodeCloudWatchLogsSubscription
```

Use this path when CloudWatch Logs subscription records need to land in an AppTheory Lambda through Kinesis. Do not
replace the stream, destination, or event-source mapping with bespoke raw CDK resources for one service; if the supported
path is missing a needed control, grow the AppTheory construct surface.

## Construct roles

- `AppTheoryKinesisStream` creates or wraps the encrypted Kinesis Data Stream. New streams default to on-demand capacity,
  AWS-managed Kinesis encryption, and `RETAIN`; imports reject create-time props so they cannot silently synthesize a
  replacement stream.
- `AppTheoryKinesisStreamMapping` wires the stream to the Lambda consumer and grants read permissions. It defaults
  `reportBatchItemFailures` to `true` so the runtime can fail individual records without replaying successful records.
- `AppTheoryCloudWatchLogsDestination` creates the CloudWatch Logs destination, service role, and destination policy. It
  requires `allowedSourceAccounts` and/or `allowedOrganizationIds`; there is no broad default destination policy.

The CloudWatch Logs subscription filter is the source-side attachment that points a log group at
`destination.destinationArn`. Keep the destination, stream, mapping, and handler on the AppTheory path.

## CDK shape

```ts
import {
  AppTheoryCloudWatchLogsDestination,
  AppTheoryFunction,
  AppTheoryKinesisStream,
  AppTheoryKinesisStreamMapping,
} from "@theory-cloud/apptheory-cdk";
import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";

const sourceAccountId = "111122223333";
const organizationId = "o-example1234";

const stream = new AppTheoryKinesisStream(this, "LogsStream", {
  retentionPeriod: Duration.hours(24),
});

const consumer = new AppTheoryFunction(this, "LogsConsumer", {
  runtime: lambda.Runtime.PROVIDED_AL2023,
  handler: "bootstrap",
  code: lambda.Code.fromAsset("dist/handler"),
  environment: {
    APPTHEORY_KINESIS_STREAM_NAME: stream.streamName,
  },
});

new AppTheoryKinesisStreamMapping(this, "LogsConsumerMapping", {
  stream: stream.stream,
  consumer: consumer.fn,
  batchSize: 100,
  maxBatchingWindow: Duration.seconds(5),
});

const destination = new AppTheoryCloudWatchLogsDestination(this, "LogsDestination", {
  stream: stream.stream,
  allowedSourceAccounts: [sourceAccountId],
  allowedOrganizationIds: [organizationId],
});

new logs.CfnSubscriptionFilter(this, "SourceSubscription", {
  logGroupName: "/aws/lambda/source-function",
  destinationArn: destination.destinationArn,
  filterPattern: "",
  distribution: "ByLogStream",
});
```

`111122223333`, `o-example1234`, and the log group name above are placeholders. They are examples only, not live account
claims. Replace them with the trusted source accounts, organization IDs, and log groups for the deployment. A destination
without an explicit source-account or organization allowlist fails closed.

## Runtime handler shape

The Lambda handler still delegates to the AppTheory runtime:

- Go: `HandleLambda` detects Kinesis and calls `ServeKinesis`.
- TypeScript: `handleLambda` detects Kinesis and calls `serveKinesisEvent`.
- Python: `handle_lambda` detects Kinesis and calls `serve_kinesis`.

Register the stream handler by stream name, then decode CloudWatch Logs envelopes per record:

```go
app.Kinesis(streamName, func(ctx *apptheory.EventContext, record events.KinesisEventRecord) error {
	decoded, err := apptheory.DecodeCloudWatchLogsSubscription(record)
	if err != nil {
		return err
	}

	for _, event := range decoded.LogEvents {
		_ = event.Message // domain processing only; do not copy raw messages into safe logs
	}
	return nil
})
```

If a record fails decoding or processing, the runtime returns that record's `eventID` in `batchItemFailures`. Successful
records are omitted from the response. `DecodeCloudWatchLogsSubscription` returns `SafeSummary` for logs/metrics/traces;
raw log messages stay inside the decoded log events for local domain work.

## Producer and testkit helpers

When an AppTheory workload produces Kinesis JSON records, use the runtime helper for deterministic bytes and safe
summaries:

- Go: `NewKinesisJSONRecord` and `ReportKinesisPutRecordsFailures`
- TypeScript: `createKinesisJsonRecord` and `reportKinesisPutRecordsFailures`
- Python: `create_kinesis_json_record` and `report_kinesis_put_records_failures`

Use the testkit helpers for deterministic Kinesis and CloudWatch Logs subscription tests:

- Go: `KinesisEvent`, `KinesisCloudWatchLogsSubscriptionRecord`, `CloudWatchLogsSubscriptionData`
- TypeScript: `buildKinesisEvent`, `kinesisCloudWatchLogsSubscriptionRecord`, `cloudWatchLogsSubscriptionData`
- Python: `build_kinesis_event`, `kinesis_cloudwatch_logs_subscription_record`,
  `cloudwatch_logs_subscription_data`

Canonical example: `examples/cdk/kinesis-cloudwatch-logs`.
