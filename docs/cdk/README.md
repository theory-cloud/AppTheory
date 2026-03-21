# AppTheory CDK Guides

`docs/cdk/` is the canonical optional docs surface for AppTheory CDK constructs. Use these guides for deployable
patterns and treat `cdk/.jsii`, `cdk/lib/index.ts`, and `cdk/lib/*.d.ts` as the construct source of truth.

## Start here

- [Getting Started](./getting-started.md)
- [API Reference](./api-reference.md)
- [AppSync Lambda Resolvers](./appsync-lambda-resolvers.md)
- [REST API Router + Streaming](./rest-api-router-streaming.md)
- [MCP Server for Bedrock AgentCore](./mcp-server-agentcore.md)
- [Claude Remote MCP + Streaming](./mcp-server-remote-mcp.md)
- [MCP Protected Resource Metadata](./mcp-protected-resource.md)
- [Import Pipeline Constructs](./import-pipeline.md)

## Scope

These pages cover the canonical user-facing CDK patterns for:

- AppSync Lambda resolver wiring with standard `aws-cdk-lib/aws-appsync` constructs
- HTTP and REST API routing
- response streaming and SSE
- MCP and OAuth discovery endpoints
- import-pipeline infrastructure primitives

Package-local authoring docs may still exist outside `docs/cdk/`, but canonical external guidance lives here.
