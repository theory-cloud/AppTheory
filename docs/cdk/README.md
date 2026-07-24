---
title: CDK Overview
permalink: /cdk/
---

# AppTheory CDK Guides

`docs/cdk/` is the canonical optional docs surface for AppTheory CDK constructs. Use these guides for deployable
patterns and treat `cdk/.jsii`, `cdk/lib/index.ts`, and `cdk/lib/*.d.ts` as the construct source of truth.

## Start here

- [Getting Started](./getting-started.md)
- [API Reference](./api-reference.md)
- [FaceTheory-First SSR Site](./ssr-site.md)
- [AppSync Lambda Resolvers](./appsync-lambda-resolvers.md)
- [REST API Router + Streaming](./rest-api-router-streaming.md)
- [MCP Server for Bedrock AgentCore](./mcp-server-agentcore.md)
- [Claude Remote MCP + Streaming](./mcp-server-remote-mcp.md)
- [MCP Protected Resource Metadata](./mcp-protected-resource.md)
- [Import Pipeline Constructs](./import-pipeline.md)
- [S3 Vector Index](./vector-index.md)
- [Kinesis + CloudWatch Logs](./kinesis-cloudwatch-logs.md)
- [Lambda MicroVM CDK Constructs](./lambda-microvm.md)

## Scope

These pages cover the canonical user-facing CDK patterns for:

- AppSync Lambda resolver wiring with standard `aws-cdk-lib/aws-appsync` constructs
- CloudFront + S3 + Lambda URL SSR/SSG/ISR deployment for FaceTheory-style apps
- HTTP and REST API routing
- response streaming and SSE
- MCP and OAuth discovery endpoints
- import-pipeline infrastructure primitives
- S3 Vectors semantic recall infrastructure
- EventBridge bus and rule-target transport primitives
- Kinesis stream, stream mapping, and CloudWatch Logs destination transport primitives
- Lambda MicroVM network connector, image, explicit runtime logging, protected controller, and durable session-registry
  wiring

Package-local authoring docs may still exist outside `docs/cdk/`, but canonical external guidance lives here.
