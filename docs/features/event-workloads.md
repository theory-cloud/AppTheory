# Event workload contracts

AppTheory's non-HTTP Lambda story uses the same single entrypoint as HTTP and AppSync:
`HandleLambda`, `handleLambda`, or `handle_lambda`. EventBridge, scheduled rules, SQS, Kinesis, SNS, and DynamoDB
Streams are detected by event shape and routed through the AppTheory event-source registry. Do not add a second dispatcher
for "background jobs"; grow the contract and fixtures when workload behavior needs to become portable.

This page documents the event workload contract pinned by the shared `m1` fixtures. Runtime helper APIs and framework-owned
panic recovery are implemented in follow-up runtime milestones; until those land, the fixtures are the specification and
runner handlers emulate the future contract shape.

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
- `AppTheoryQueue`, `AppTheoryQueueConsumer`, and `AppTheoryQueueProcessor`: SQS queue and worker patterns when a DLQ or
  queue boundary is the correct retry domain.
- `AppTheoryJobsTable`: job/run ledger storage for long-running workloads that need idempotency, leases, and record-level
  status.

The CDK constructs provide transport and IAM wiring. The handler still owns domain idempotency and must stay on the
AppTheory runtime entrypoint so the event workload contract remains fixture-backed across Go, TypeScript, and Python.
