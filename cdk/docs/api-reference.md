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
- `AppTheoryRestApi` (API Gateway REST API v1 + single-Lambda proxy routes)
- `AppTheoryRestApiRouter` (API Gateway REST API v1 + multi-Lambda routing + full streaming parity)
- `AppTheoryWebSocketApi` (WebSocket API + routes/permissions; optional connection table + stage access logging)
- `AppTheoryQueue` (SQS queue with optional DLQ)
- `AppTheoryQueueConsumer` (SQS → Lambda event source mapping with full options)
- `AppTheoryQueueProcessor` (SQS + Lambda consumer wiring convenience wrapper)
- `AppTheoryEventBridgeHandler` (EventBridge rule/schedule + Lambda target)
- `AppTheoryDynamoDBStreamMapping` (Streams mapping + permissions)
- `AppTheoryEventBusTable` (opinionated EventBus DynamoDB table + required GSIs)
- `AppTheoryDynamoTable` (general-purpose DynamoDB table; schema-explicit + consistent defaults)
- `AppTheoryLambdaRole` (Lambda execution role helper; baseline + X-Ray + KMS + escape hatches)
- `AppTheoryPathRoutedFrontend` (CloudFront distribution: multi-SPA routing + API origin + SPA rewrite)
- `AppTheoryMediaCdn` (CloudFront distribution: S3-backed media CDN; optional private media via key groups)
- Domain/cert helpers (hosted zone, certificate, custom domains)
- Higher-level “app”/SSR patterns (where present)

For the exact list and prop types, read `cdk/lib/*.d.ts`.
