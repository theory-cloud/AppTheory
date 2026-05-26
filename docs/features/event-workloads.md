# Event workload contracts

AppTheory's non-HTTP Lambda story uses the same single entrypoint as HTTP and AppSync:
`HandleLambda`, `handleLambda`, or `handle_lambda`. EventBridge, scheduled rules, SQS, Kinesis, SNS, and DynamoDB
Streams are detected by event shape and routed through the AppTheory event-source registry. Do not add a second dispatcher
for "background jobs"; grow the contract and fixtures when workload behavior needs to become portable.

This page documents the event workload contract pinned by the shared `m1` fixtures. The fixtures remain the
specification for every event-source behavior. When a helper is part of the public API, use that helper instead of
copying event-shape or decoding logic into service code.

## EventBridge workload envelope

EventBridge workload handlers should be able to derive a safe envelope summary with these portable fields:

- `event_id`: EventBridge `id`
- `source`: EventBridge `source`
- `detail_type`: EventBridge `detail-type` or `detailType`
- `account`, `region`, `time`, and `resources`
- `request_id`: Lambda invocation request ID
- `correlation_id` and `correlation_source`

Correlation ID precedence is fixed across languages:

1. `event.metadata.correlation_id`
2. `event.headers["x-correlation-id"]`
3. `event.detail.correlation_id`
4. EventBridge `event.id`
5. Lambda context `awsRequestId`

`metadata` and top-level `headers` are an **AppTheory portable envelope convention** used by the contract fixtures and
future helpers. They are not fields that AWS EventBridge adds to native events. Producers using plain EventBridge custom
events should either put correlation data in `detail.correlation_id` or use an AppTheory-defined envelope before the
runtime helper reads the event. Header names are matched case-insensitively when the portable envelope is present.

If an EventBridge event does not match a registered rule name or source/detail-type selector, the existing AppTheory
behavior remains unchanged: the handler result is `nil` / `null`, not an alternate error path.

## Scheduled workloads

Scheduled workloads are EventBridge events with `source = "aws.events"` and `detail-type = "Scheduled Event"`. The contract
pins a structured run summary so schedule handlers do not invent per-service result shapes.

Portable summary fields:

- `kind`: always `scheduled`
- `run_id`: `detail.run_id`, then EventBridge `id`, then Lambda `awsRequestId`
- `idempotency_key`: `detail.idempotency_key`, then `eventbridge:<event.id>`, then `lambda:<awsRequestId>`
- `correlation_id` / `correlation_source`: the EventBridge precedence above
- `remaining_ms`: the remaining invocation time supplied by the Lambda context
- `deadline_unix_ms`: current runtime clock plus `remaining_ms`, or `0` when no deadline is available
- `result.status`: defaults to `ok`
- `result.processed` and `result.failed`: default to `0`

Retry and reliability guidance:

- Treat schedules as at-least-once triggers.
- Use the idempotency key before committing external side effects.
- Configure EventBridge target retry policy, maximum event age, and DLQ through the deployment construct instead of
  branching inside the handler.
- Use the Lambda remaining-time/deadline fields to stop before timeout and return a structured summary when possible.

## Kinesis workloads and CloudWatch Logs subscriptions

Kinesis uses the same AppTheory Lambda entrypoint as every other trigger. `HandleLambda`, `handleLambda`, and
`handle_lambda` detect `Records[0].eventSource == "aws:kinesis"` and route to the registered Kinesis stream handler:

- Go: `app.Kinesis(streamName, handler)` and `app.ServeKinesis(ctx, event)`
- TypeScript: `app.kinesis(streamName, handler)` and `app.serveKinesisEvent(event, ctx)`
- Python: `app.kinesis(stream_name, handler)` and `app.serve_kinesis(event, ctx)`

Kinesis handlers run per record. If a handler returns an error or throws, the record's `eventID` is returned in
`batchItemFailures`. Successful records are omitted. An event for an unregistered stream fails closed by returning every
record ID as a failure, matching Lambda's partial-batch response model.

The AppTheory-owned path for CloudWatch Logs delivered through Kinesis is:

1. A CloudWatch Logs subscription filter targets an `AppTheoryCloudWatchLogsDestination`.
2. `AppTheoryCloudWatchLogsDestination` delivers records to an `AppTheoryKinesisStream`.
3. `AppTheoryKinesisStreamMapping` wires the stream to the AppTheory Lambda consumer with partial-batch failures enabled.
4. The Lambda handler stays on `HandleLambda` / `handleLambda` / `handle_lambda`.
5. The Kinesis handler decodes each CloudWatch Logs envelope with the runtime decoder before domain processing.

Runtime decoder names:

| Language | Decoder |
| --- | --- |
| Go | `DecodeCloudWatchLogsSubscription(record)` |
| TypeScript | `decodeCloudWatchLogsSubscription(record)` |
| Python | `decode_cloudwatch_logs_subscription(record)` |

The decoder understands the gzip-compressed CloudWatch Logs subscription envelope carried in the Lambda Kinesis record's
data field. It returns typed log envelope fields plus `safe_summary`. Raw CloudWatch log messages are available only in
the decoded `log_events` / `LogEvents` payload for the handler's local domain work; `safe_summary` intentionally contains
only record/log identity and counts.

Kinesis producer helper names:

| Language | Record helper | Failure report helper |
| --- | --- | --- |
| Go | `NewKinesisJSONRecord` | `ReportKinesisPutRecordsFailures` |
| TypeScript | `createKinesisJsonRecord` | `reportKinesisPutRecordsFailures` |
| Python | `create_kinesis_json_record` | `report_kinesis_put_records_failures` |

Use these helpers when an AppTheory workload needs deterministic JSON bytes and safe PutRecords-style failure summaries.
They validate partition keys, canonicalize explicit hash keys, enforce Kinesis record bounds, align failures by
input/result index, and exclude JSON payload bodies and raw error messages from safe summaries. If a service needs a
broader producer abstraction, grow the AppTheory helper surface instead of inventing a per-service record or failure
shape.

Deterministic testkit helpers are available for Kinesis events and CloudWatch Logs subscription records:

- Go: `KinesisEvent`, `KinesisCloudWatchLogsSubscriptionRecord`, and `CloudWatchLogsSubscriptionData`
- TypeScript: `buildKinesisEvent`, `kinesisCloudWatchLogsSubscriptionRecord`, and `cloudWatchLogsSubscriptionData`
- Python: `build_kinesis_event`, `kinesis_cloudwatch_logs_subscription_record`, and
  `cloudwatch_logs_subscription_data`

Canonical example: `examples/cdk/kinesis-cloudwatch-logs`.

## DynamoDB Streams workloads

DynamoDB stream handlers keep the existing Lambda partial-batch response contract. Successful records are omitted from
`batchItemFailures`; failed records return their `eventID` as `itemIdentifier`; an unrecognized table fails closed by
returning every record ID as a failure.

The normalized safe record summary contains only operational metadata:

- `table_name`: parsed from `eventSourceARN`
- `event_id`: `eventID`
- `event_name`: `eventName`
- `sequence_number`: `dynamodb.SequenceNumber`
- `size_bytes`: `dynamodb.SizeBytes`
- `stream_view_type`: `dynamodb.StreamViewType`
- `safe_log`: a derived summary from table/event/sequence metadata

`Keys`, `NewImage`, and `OldImage` are not safe-log fields. The fixtures intentionally include raw-value sentinels such as
`release#rel_123`, `do-not-log`, and `previous-secret`; runtime helpers must not leak those values into logs, metrics,
spans, or safe summaries.

Retry and idempotency guidance:

- DynamoDB Streams are at-least-once. A failed `eventID` can be delivered again.
- Use the stream `eventID`, sequence number, or a domain key from a trusted normalized value for idempotency.
- Never log raw image values while diagnosing retries; log only the safe summary fields above.

## Non-HTTP observability and safe errors

Event workloads use the same portable fixture side-effect fields as P2 HTTP fixtures: `expect.logs`, `expect.metrics`, and
`expect.spans`. The event workload dimensions are trigger-specific and must not include raw payloads.

EventBridge dimensions:

- `trigger = "eventbridge"`
- `correlation_id`
- `source`
- `detail_type`
- `error_code`
- `outcome`

DynamoDB Streams dimensions:

- `trigger = "dynamodb_stream"`
- `correlation_id` set to the stream `eventID`
- `table_name`
- `event_id`
- `event_name`
- `error_code`
- `outcome`

The safe error posture for non-HTTP workloads is:

- observability records use `error_code = "app.internal"` for non-portable handler panics or raw internal errors
- surfaced errors use the safe message `apptheory: event workload failed`
- raw exception messages and raw event payloads are not logged or returned

Current fixture status: the `m1` safe-panic fixture is contract-first emulation by the runner handler. Follow-up runtime
milestones must add or convert fixtures so a handler throws a raw/internal error and the AppTheory runtime itself performs
recovery, sanitization, and effect emission.

## CDK wiring

Use AppTheory CDK constructs for deployment wiring; do not drop to bespoke raw CDK for one workload shape.

- `AppTheoryEventBridgeRuleTarget`: schedule or EventBridge pattern to Lambda wiring. Use `targetProps` for DLQs,
  retries, and maximum event age.
- `AppTheoryEventBridgeBus`: custom bus plus explicit cross-account publisher allowlist.
- `AppTheoryDynamoDBStreamMapping`: DynamoDB stream to Lambda event-source mapping.
- `AppTheoryKinesisStream`: create or wrap the encrypted Kinesis Data Stream for AppTheory event ingestion.
- `AppTheoryKinesisStreamMapping`: stream-to-Lambda event-source mapping with `reportBatchItemFailures` defaulting to
  `true`.
- `AppTheoryCloudWatchLogsDestination`: CloudWatch Logs destination with explicit source account and/or organization
  allowlists; it does not synthesize a broad default destination policy.
- `AppTheoryQueue`, `AppTheoryQueueConsumer`, and `AppTheoryQueueProcessor`: SQS queue and worker patterns when a DLQ or
  queue boundary is the correct retry domain.
- `AppTheoryJobsTable`: job/run ledger storage for long-running workloads that need idempotency, leases, and record-level
  status.

The CDK constructs provide transport and IAM wiring. The handler still owns domain idempotency and must stay on the
AppTheory runtime entrypoint so the event workload contract remains fixture-backed across Go, TypeScript, and Python.

For CloudWatch Logs through Kinesis, use the single AppTheory-owned chain documented above. Placeholder account IDs such
as `111122223333` and organization IDs such as `o-example1234` in examples are examples only; replace them before any
real deployment. The Logs destination must be explicitly allowlisted and should fail closed when no trusted source is
configured.
