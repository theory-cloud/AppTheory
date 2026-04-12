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
