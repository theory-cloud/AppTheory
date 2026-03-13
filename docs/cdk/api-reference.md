# CDK API Reference

This page is the canonical human-readable overview of the AppTheory CDK surface. For exact prop types and exported
constructs, read `cdk/.jsii`, `cdk/lib/index.ts`, and `cdk/lib/*.d.ts`.

## Core API constructs

- `AppTheoryHttpApi`: API Gateway HTTP API v2 plus Lambda proxy routes
- `AppTheoryRestApi`: API Gateway REST API v1 plus single-Lambda proxy routes
- `AppTheoryRestApiRouter`: REST API v1 multi-Lambda routing with streaming support
- `AppTheoryMcpServer`: HTTP API v2 `POST /mcp` for Bedrock AgentCore
- `AppTheoryRemoteMcpServer`: REST API v1 `/mcp` with streaming for Remote MCP
- `AppTheoryMcpProtectedResource`: `/.well-known/oauth-protected-resource` metadata route
- `AppTheoryJobsTable`: opinionated DynamoDB jobs ledger table
- `AppTheoryS3Ingest`: secure S3 ingest front door with optional notifications
- `AppTheoryCodeBuildJobRunner`: batch-step runner for import pipelines
- `AppTheoryEventBridgeRuleTarget`: EventBridge rule or schedule to Lambda target
- `AppTheoryQueue`, `AppTheoryQueueConsumer`, `AppTheoryQueueProcessor`: SQS queue and consumer patterns

## Supporting constructs exported from `cdk/lib/index.ts`

- `AppTheoryFunction`
- `AppTheoryFunctionAlarms`
- `AppTheoryDynamoDBStreamMapping`
- `AppTheoryDynamoTable`
- `AppTheoryEventBusTable`
- `AppTheoryLambdaRole`
- `AppTheoryPathRoutedFrontend`
- `AppTheoryMediaCdn`
- `AppTheoryWebSocketApi`

## Selection guide

- Use `AppTheoryHttpApi` for the simplest HTTP API v2 deployment
- Use `AppTheoryRestApi` when you need REST API v1 but not multi-Lambda routing
- Use `AppTheoryRestApiRouter` when you need SSE or response streaming
- Use `AppTheoryMcpServer` for Bedrock AgentCore
- Use `AppTheoryRemoteMcpServer` plus `AppTheoryMcpProtectedResource` for Claude Remote MCP
- Use `AppTheoryJobsTable`, `AppTheoryS3Ingest`, and `AppTheoryCodeBuildJobRunner` for import pipelines

## AppSync note

AppTheory does not currently export an AppSync-specific CDK construct.

Use `aws-cdk-lib/aws-appsync` for the GraphQL API, schema, auth, and Lambda data source wiring, and keep the Lambda
handler on AppTheory's AppSync runtime entrypoints.

Guide:

- [AppSync Lambda Resolvers](./appsync-lambda-resolvers.md)
