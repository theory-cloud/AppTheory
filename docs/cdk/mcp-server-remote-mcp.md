# Claude Remote MCP + Streaming

Use `AppTheoryRemoteMcpServer` when you need an AppTheory CDK deployment for Remote MCP with incremental SSE
streaming.

## Why this construct exists

Claude Remote MCP requires real incremental streaming. On AWS that means:

- API Gateway REST API v1, not HTTP API v2
- Lambda response streaming

`AppTheoryRemoteMcpServer` provisions `/mcp` routes that fit that deployment shape.

## What it provisions

- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`
- optional DynamoDB session and stream tables

## Minimal example

```ts
import { Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  AppTheoryMcpProtectedResource,
  AppTheoryRemoteMcpServer,
} from "@theory-cloud/apptheory-cdk";

const stack = new Stack();
const handler = new lambda.Function(stack, "McpHandler", {
  runtime: lambda.Runtime.PROVIDED_AL2023,
  handler: "bootstrap",
  code: lambda.Code.fromAsset("dist"),
});

const mcp = new AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
  handler,
  enableSessionTable: true,
  sessionTtlMinutes: 120,
});

new AppTheoryMcpProtectedResource(stack, "ProtectedResource", {
  router: mcp.router,
  resource: mcp.endpoint,
  authorizationServers: ["https://auth.example.com"],
});
```

## Keepalive guidance

Expect SSE disconnects. Prefer resumable streams, `Last-Event-ID`, and periodic progress events for long-running work.
