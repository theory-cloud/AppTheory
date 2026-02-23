# Claude Remote MCP (Streamable HTTP) — REST API v1 + Streaming

This guide covers `AppTheoryRemoteMcpServer`, the recommended CDK construct for **Claude Custom Connectors** using **Remote MCP** with **MCP Streamable HTTP**.

## Why this construct exists

Claude Remote MCP requires real incremental streaming for tool calls (SSE). On AWS, that means:

- API Gateway **REST API v1** (not HTTP API v2)
- Lambda **response streaming** (`/response-streaming-invocations`)

`AppTheoryRemoteMcpServer` provisions a REST API and configures `/mcp` correctly for streaming.

## What it provisions

- API Gateway **REST API v1**
- `/mcp` routes:
  - `POST /mcp` (streaming enabled)
  - `GET /mcp` (streaming enabled; used for `Last-Event-ID` replay/resume)
  - `DELETE /mcp`
- Optional DynamoDB tables:
  - session table (matches `runtime/mcp` Dynamo session store schema)
  - stream/event table (intended for durable resumable SSE)

## TypeScript example

```ts
import { Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { AppTheoryRemoteMcpServer } from "@theory-cloud/apptheory-cdk";

const stack = new Stack();

const handler = new lambda.Function(stack, "McpHandler", {
  runtime: lambda.Runtime.PROVIDED_AL2023,
  handler: "bootstrap",
  code: lambda.Code.fromAsset("dist"),
});

const mcp = new AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
  handler,
  apiName: "remote-mcp",
  enableSessionTable: true,
  sessionTtlMinutes: 120,
  // enableStreamTable: true, // optional; depends on your StreamStore implementation
});

// MCP endpoint URL (…/mcp)
// mcp.endpoint
```

## Keepalive + resumability guidance

For SSE connections, expect disconnects (idle timeouts, client refresh, Lambda max duration). Prefer:

- **resumable streams** (`Last-Event-ID`) + replay from an event log
- emitting periodic progress updates during long-running work

## Related docs

- Go runtime MCP server: `docs/mcp.md`
- Remote MCP planning + compatibility contract: `docs/development/planning/apptheory/remote-mcp/README.md`

