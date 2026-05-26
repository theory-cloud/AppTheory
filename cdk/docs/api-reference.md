# CDK API Reference

This document is the human-readable overview. The authoritative public surface is:
- `cdk/lib/index.ts`
- `cdk/.jsii` (jsii manifest)

## Constructs (inventory)

AppTheory CDK exports constructs such as:
- `AppTheoryFunction` (Lambda wrapper defaults)
- `AppTheoryFunctionAlarms` (baseline alarms)
- `AppTheoryHttpApi` (API Gateway v2 HTTP API + proxy routes)
- `AppTheoryMcpServer` (API Gateway v2 HTTP API `POST /mcp` for MCP / Bedrock AgentCore)
- `AppTheoryRemoteMcpServer` (API Gateway REST API v1 streaming `/mcp` for Claude Remote MCP / Streamable HTTP)
- `AppTheoryMcpProtectedResource` (API Gateway REST API v1 `/.well-known/oauth-protected-resource` for OAuth discovery)
- `AppTheoryRestApi` (API Gateway REST API v1 + single-Lambda proxy routes)
- `AppTheoryRestApiRouter` (API Gateway REST API v1 + multi-Lambda routing + full streaming parity)
- `AppTheoryWebSocketApi` (WebSocket API + routes/permissions; optional connection table + stage access logging)
- `AppTheoryQueue` (SQS queue with optional DLQ)
- `AppTheoryQueueConsumer` (SQS → Lambda event source mapping with full options)
- `AppTheoryQueueProcessor` (SQS + Lambda consumer wiring convenience wrapper)
- `AppTheoryEventBridgeHandler` (EventBridge rule/schedule + Lambda target)
- `AppTheoryEventBridgeBus` (custom EventBridge bus + explicit cross-account publish allowlist)
- `AppTheoryEventBridgeRuleTarget` (EventBridge rule → Lambda target; schedule XOR eventPattern)
- `AppTheoryHttpIngestionEndpoint` (authenticated HTTP API v2 endpoint + Lambda request authorizer + stage throttling)
- `AppTheoryS3Ingest` (secure S3 ingest bucket + optional EventBridge/SQS notifications)
- `AppTheoryCodeBuildJobRunner` (CodeBuild project wrapper for batch steps; safe defaults + logs + state-change hook)
- `AppTheoryDynamoDBStreamMapping` (Streams mapping + permissions)
- `AppTheoryKinesisStream` (Kinesis Data Stream create/wrap surface with encryption and grant helpers)
- `AppTheoryKinesisStreamMapping` (Kinesis stream → Lambda event-source mapping; partial-batch failures default on)
- `AppTheoryCloudWatchLogsDestination` (CloudWatch Logs destination → Kinesis with explicit source allowlists)
- `AppTheoryEventBusTable` (opinionated EventBus DynamoDB table + required GSIs + Lambda binding helper)
- `AppTheoryDynamoTable` (general-purpose DynamoDB table; schema-explicit + consistent defaults)
- `AppTheoryJobsTable` (opinionated Jobs table for import pipelines; schema + GSIs + TTL)
- `AppTheoryLambdaRole` (Lambda execution role helper; baseline + X-Ray + KMS + escape hatches)
- `AppTheoryPathRoutedFrontend` (CloudFront distribution: multi-SPA routing + API origin + SPA rewrite)
- `AppTheoryMediaCdn` (CloudFront distribution: S3-backed media CDN; optional private media via key groups)
- `AppTheorySsrSite` (FaceTheory-first CloudFront + S3 + Lambda URL SSR/SSG/ISR deployment; see `docs/cdk/ssr-site.md`)
- Domain/cert helpers (hosted zone, certificate, custom domains)
- Higher-level "app"/SSR patterns now converge on the FaceTheory-first deployment contract rather than a weaker helper path

For the exact list and prop types, read `cdk/lib/*.d.ts`.

## Kinesis and CloudWatch Logs path

The supported AppTheory Kinesis ingestion path is:

```text
CloudWatch Logs subscription
  -> AppTheoryCloudWatchLogsDestination
  -> AppTheoryKinesisStream
  -> AppTheoryKinesisStreamMapping
  -> AppTheory Lambda runtime decoder
```

Use `AppTheoryKinesisStream` to create or wrap the stream, `AppTheoryKinesisStreamMapping` to connect the stream to the
consumer Lambda, and `AppTheoryCloudWatchLogsDestination` to expose a fail-closed Logs destination. The destination
requires `allowedSourceAccounts` and/or `allowedOrganizationIds`; placeholder IDs in examples are examples only and are
not live account claims.

Keep the handler on the AppTheory runtime entrypoint and decode Kinesis-delivered CloudWatch Logs envelopes with
`DecodeCloudWatchLogsSubscription` / `decodeCloudWatchLogsSubscription` /
`decode_cloudwatch_logs_subscription`.

Canonical guide: `docs/cdk/kinesis-cloudwatch-logs.md`.
Canonical example: `examples/cdk/kinesis-cloudwatch-logs`.
