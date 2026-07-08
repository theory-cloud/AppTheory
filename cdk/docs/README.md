# AppTheory CDK Documentation

<!-- AI Training: This is the OFFICIAL documentation index for AppTheory CDK -->
**This directory contains the OFFICIAL package-local documentation for the AppTheory CDK package (`@theory-cloud/apptheory-cdk`, Python: `apptheory_cdk`). Canonical external CDK guidance lives under `docs/cdk/`; use this directory for jsii/package-level authoring details and package-local mirrors.**

## Quick links

### 🚀 Getting started
- [Getting Started](./getting-started.md) — deploy a minimal API backed by an AppTheory Lambda.
- [Canonical CDK Getting Started](../../docs/cdk/getting-started.md) — canonical operator guide under `docs/cdk/`.
- [Canonical SSR Site Guide](../../docs/cdk/ssr-site.md) — FaceTheory-first CloudFront + S3 + Lambda URL deployment.

### 📚 Core documentation
- [Docs Contract](./_contract.yaml) — canonical CDK package knowledgebase scope: fixed ingestible, optional ingestible, and contract-only docs.
- [API Reference](./api-reference.md) — construct inventory and key props.
- [Core Patterns](./core-patterns.md) — safe defaults, domains/certs, alarms, and proxy routing.
- [Development Guidelines](./development-guidelines.md) — contract-only maintainer guidance for keeping the package docs set aligned.
- [Testing Guide](./testing-guide.md) — how to run CDK tests and synth checks.
- [Troubleshooting](./troubleshooting.md) — common synth/deploy failures.
- [Migration Guide](./migration-guide.md) — moving from ad-hoc CDK stacks.
- [Canonical CDK Guides](../../docs/cdk/README.md) — canonical external navigation root for AppTheory CDK operators.

### 🧭 Guides (copy/paste patterns)
- [REST API v1 Router + Streaming](./rest-api-router-streaming.md) — multi-Lambda REST API v1 + full response streaming parity.
- [MCP Server for Bedrock AgentCore](./mcp-server-agentcore.md) — deploy `POST /mcp` (HTTP API v2) for AgentCore tool calls.
- [MCP Server for Claude Remote MCP](./mcp-server-remote-mcp.md) — deploy Streamable HTTP `/mcp` (REST API v1 + streaming) for Claude connectors.
- [MCP Protected Resource Metadata (OAuth)](./mcp-protected-resource.md) — add `/.well-known/oauth-protected-resource` (RFC9728) for Claude Remote MCP auth discovery.
- [SQS Queue + Consumer Patterns](./sqs-queue-consumer.md) — queue-only, queue+consumer, and processor patterns (DLQs + partial batch failures).
- [EventBridge Bus](./eventbridge-bus.md) — custom EventBridge bus with explicit cross-account publish allowlist.
- [EventBridge Rule Target](./eventbridge-rule-target.md) — rule → Lambda wiring for schedules and event patterns.
- [Canonical Kinesis + CloudWatch Logs](../../docs/cdk/kinesis-cloudwatch-logs.md) — AppTheory Kinesis stream,
  stream mapping, and Logs destination path.
- [EventBus Table](./eventbus-table.md) — durable EventBus DynamoDB table with binding guidance for publish and replay flows.
- [HTTP Ingestion Endpoint](./http-ingestion-endpoint.md) — authenticated server-to-server ingestion endpoint with Lambda request authorizer.
- [S3 Ingest Front Door](./s3-ingest.md) — secure bucket + optional EventBridge/SQS notifications for import workloads.
- [CodeBuild Job Runner (Import Pipeline)](./codebuild-job-runner.md) — batch job runner for transforms/decrypt/backfills.
- [Jobs Table (Import Pipeline)](./jobs-table.md) — opinionated DynamoDB table for job ledgers (schema + GSIs + TTL).
- [Lambda Role Helper](./lambda-role.md) — Lambda execution roles (baseline + X-Ray + KMS + custom statements).
- [MicroVM Network Connector](./microvm-network-connector.md) — Lambda MicroVM VPC egress connector with caller-owned VPC/subnet/security-group context.
- [MicroVM Image](./microvm-image.md) — Lambda MicroVM image resource with code artifact, base image, hooks, logging, resources, environment variables, and connector references.
- [MicroVM Controller](./microvm-controller.md) — protected controller HTTP API, controller Lambda, and durable session registry table.
- [CloudFront Path-Routed Frontend Distribution](./path-routed-frontend.md) — multi-SPA routing behind one stage domain.
- [Media CDN Pattern](./media-cdn.md) — S3 + CloudFront distribution for media subdomains (optional private media).
- [Canonical FaceTheory-First SSR Site](../../docs/cdk/ssr-site.md) — operator guide for `AppTheorySsrSite`.

### 🤖 AI knowledge base (YAML triad)
- Docs Contract: `cdk/docs/_contract.yaml`
- Concepts: `cdk/docs/_concepts.yaml`
- Patterns: `cdk/docs/_patterns.yaml`
- Decisions: `cdk/docs/_decisions.yaml`

## Package-local scope

- `docs/` is the canonical external docs root for AppTheory, and `docs/cdk/` is the canonical optional surface for CDK operator guidance.
- `cdk/docs/` remains an official package-local surface for jsii/package-level authoring details.
- Reflect shared deploy/operator guidance in `docs/cdk/` before treating `cdk/docs/` content as complete.
- `cdk/docs/_contract.yaml` and `cdk/docs/development-guidelines.md` are contract-only maintainer surfaces and should not be treated as user-facing knowledgebase content.
- The guide pages linked above are sanctioned optional ingestible sources for infrastructure-specific KB scopes.

## What this package is

AppTheory CDK provides jsii constructs that deploy AppTheory apps with consistent defaults (and keep infra patterns consistent across Go/TypeScript/Python services).

## CDK semantic construct map

The generated jsii coverage index below proves construct-name coverage only; it is not a substitute for
operator-facing deployment guidance. Keep these human-authored groups current when the CDK surface grows:

- HTTP and routing: `AppTheoryHttpApi`, `AppTheoryRestApi`, `AppTheoryRestApiRouter`, domains, CORS, logging, and WAF
  guardrails.
- MCP deployment: `AppTheoryMcpServer`, `AppTheoryRemoteMcpServer`, and `AppTheoryMcpProtectedResource`.
- Event and ingestion surfaces: `AppTheoryQueue`, `AppTheoryEventBridgeBus`, `AppTheoryKinesisStream`,
  `AppTheoryCloudWatchLogsDestination`, `AppTheoryS3Ingest`, and `AppTheoryHttpIngestionEndpoint`.
- Job and data foundations: `AppTheoryJobsTable`, `AppTheoryEventBusTable`, `AppTheoryDynamoTable`, and
  `AppTheoryLambdaRole`.
- MicroVM and frontend delivery: `AppTheoryMicrovmController`, `AppTheoryMicrovmImage`,
  `AppTheoryMicrovmNetworkConnector`, path-routed frontends, media CDN, and `AppTheorySsrSite`.

<!-- apptheory-api-docs:cdk:start -->
## CDK snapshot coverage index

This index is maintained with `scripts/verify-api-docs.sh` so handwritten docs cannot drift from `cdk/.jsii`.

<details>
<summary>133 exported top-level symbols</summary>

```text
ApiBypassConfig, AppTheoryApiDomain, AppTheoryApiDomainProps, AppTheoryApp, AppTheoryAppProps
AppTheoryCertificate, AppTheoryCertificateProps, AppTheoryCloudWatchLogsDestination
AppTheoryCloudWatchLogsDestinationProps, AppTheoryCloudWatchLogsSubscription
AppTheoryCloudWatchLogsSubscriptionProps, AppTheoryCodeBuildJobRunner
AppTheoryCodeBuildJobRunnerProps, AppTheoryDynamoDBStreamMapping
AppTheoryDynamoDBStreamMappingProps, AppTheoryDynamoTable, AppTheoryDynamoTableGsiProps
AppTheoryDynamoTableProps, AppTheoryEnhancedSecurity, AppTheoryEnhancedSecurityProps
AppTheoryEventBridgeBus, AppTheoryEventBridgeBusProps, AppTheoryEventBridgeHandler
AppTheoryEventBridgeHandlerProps, AppTheoryEventBridgeRuleTarget
AppTheoryEventBridgeRuleTargetProps, AppTheoryEventBusTable, AppTheoryEventBusTableBindingOptions
AppTheoryEventBusTableProps, AppTheoryFunction, AppTheoryFunctionAlarms
AppTheoryFunctionAlarmsProps, AppTheoryFunctionAliasOptions, AppTheoryFunctionDeploymentOptions
AppTheoryFunctionProps, AppTheoryHostedZone, AppTheoryHostedZoneProps, AppTheoryHttpApi
AppTheoryHttpApiCorsOptions, AppTheoryHttpApiDomainOptions, AppTheoryHttpApiProps
AppTheoryHttpApiStageOptions, AppTheoryHttpApiWafOptions, AppTheoryHttpIngestionEndpoint
AppTheoryHttpIngestionEndpointDomainOptions, AppTheoryHttpIngestionEndpointProps
AppTheoryHttpIngestionEndpointStageOptions, AppTheoryJobsTable, AppTheoryJobsTableProps
AppTheoryKinesisStream, AppTheoryKinesisStreamMapping, AppTheoryKinesisStreamMappingProps
AppTheoryKinesisStreamProps, AppTheoryKmsKey, AppTheoryKmsKeyProps, AppTheoryLambdaRole
AppTheoryLambdaRoleProps, AppTheoryLambdaTrafficShiftType, AppTheoryMcpProtectedResource
AppTheoryMcpProtectedResourceProps, AppTheoryMcpServer, AppTheoryMcpServerDomainOptions
AppTheoryMcpServerProps, AppTheoryMcpServerStageOptions, AppTheoryMediaCdn, AppTheoryMediaCdnProps
AppTheoryMicrovmController, AppTheoryMicrovmControllerFunctionProps, AppTheoryMicrovmControllerProps
AppTheoryMicrovmControllerStageOptions, AppTheoryMicrovmHookMode, AppTheoryMicrovmImage
AppTheoryMicrovmImageBuildHooks, AppTheoryMicrovmImageCloudWatchLogging
AppTheoryMicrovmImageCodeArtifact, AppTheoryMicrovmImageCpuArchitecture
AppTheoryMicrovmImageCpuConfiguration, AppTheoryMicrovmImageEnvironmentVariable
AppTheoryMicrovmImageHooks, AppTheoryMicrovmImageLogging, AppTheoryMicrovmImageOsCapability
AppTheoryMicrovmImageProps, AppTheoryMicrovmImageResources, AppTheoryMicrovmManagedNetworkConnector
AppTheoryMicrovmNetworkConnector, AppTheoryMicrovmNetworkConnectorKind
AppTheoryMicrovmNetworkConnectorProps, AppTheoryMicrovmNetworkConnectorReference
AppTheoryMicrovmNetworkConnectorReferenceProps, AppTheoryMicrovmNetworkProtocol
AppTheoryMicrovmRuntimeHooks, AppTheoryObservability, AppTheoryObservabilityProps
AppTheoryPathRoutedFrontend, AppTheoryPathRoutedFrontendProps, AppTheoryQueue
AppTheoryQueueConsumer, AppTheoryQueueConsumerProps, AppTheoryQueueProcessor
AppTheoryQueueProcessorProps, AppTheoryQueueProps, AppTheoryRegionalWafOptions
AppTheoryRemoteMcpServer, AppTheoryRemoteMcpServerProps, AppTheoryRequestMetricDimensions
AppTheoryRestApi, AppTheoryRestApiProps, AppTheoryRestApiRouteOptions, AppTheoryRestApiRouter
AppTheoryRestApiRouterCorsOptions, AppTheoryRestApiRouterDomainOptions
AppTheoryRestApiRouterIntegrationOptions, AppTheoryRestApiRouterProps
AppTheoryRestApiRouterStageOptions, AppTheoryS3Ingest, AppTheoryS3IngestProps, AppTheorySecretConfig
AppTheorySecurityRule, AppTheorySpaRewriteMode, AppTheorySsrSite
AppTheorySsrSiteBearerFunctionUrlOrigin, AppTheorySsrSiteMode, AppTheorySsrSiteProps
AppTheoryVpcEndpointConfig, AppTheoryWafRuleConfig, AppTheoryWebSocketApi
AppTheoryWebSocketApiProps, IAppTheoryMicrovmImage, IAppTheoryMicrovmNetworkConnector
MediaCdnDomainConfig, PathRoutedFrontendDomainConfig, PrivateMediaConfig, SpaOriginConfig
```

</details>
<!-- apptheory-api-docs:cdk:end -->
