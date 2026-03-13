# Claude Remote MCP (Streamable HTTP) - REST API v1 + Streaming

This guide covers `AppTheoryRemoteMcpServer`, the recommended CDK construct for Claude Custom Connectors using Remote
MCP with MCP Streamable HTTP.

## Why this construct exists

Claude Remote MCP requires real incremental streaming for tool calls. On AWS that means:

- API Gateway REST API v1, not HTTP API v2
- Lambda response streaming

`AppTheoryRemoteMcpServer` provisions a REST API and configures `/mcp` correctly for that deployment shape.

## What it provisions

- API Gateway REST API v1
- `/mcp` routes:
  - `POST /mcp` (streaming enabled)
  - `GET /mcp` (streaming enabled; used for `Last-Event-ID` replay and session listeners)
  - `DELETE /mcp`
- optional DynamoDB tables:
  - session table (matches `runtime/mcp/session_dynamo.go` schema)
  - stream/event table (infra only unless the app wires a concrete `StreamStore`)

If you are using OAuth for Claude connectors, also add:

- `GET /.well-known/oauth-protected-resource`

## TypeScript example

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
  apiName: "remote-mcp",
  enableSessionTable: true,
  sessionTtlMinutes: 120,
  // enableStreamTable: true,
  // streamTtlMinutes: 120,
});

new AppTheoryMcpProtectedResource(stack, "ProtectedResource", {
  router: mcp.router,
  resource: mcp.endpoint,
  authorizationServers: ["https://auth.example.com"],
});
```

## Session and stream tables

Session table behavior:

- partition key: `sessionId`
- TTL attribute: `expiresAt`
- Lambda env vars:
  - `MCP_SESSION_TABLE`
  - `MCP_SESSION_TTL_MINUTES`

Stream table behavior:

- partition key: `sessionId`
- sort key: `eventId`
- TTL attribute: `expiresAt`
- Lambda env vars:
  - `MCP_STREAM_TABLE`
  - `MCP_STREAM_TTL_MINUTES`

Important caveat:

- the built-in runtime currently ships `MemoryStreamStore`
- `enableStreamTable` only provisions storage and injects env vars
- durable replay requires application code to provide a matching persistent `StreamStore` via `mcp.WithStreamStore(...)`

## Keepalive, replay, and origin guidance

For SSE connections, expect disconnects. Prefer:

- resumable streams (`Last-Event-ID`) + replay from an event log
- periodic progress updates during long-running work
- `GET /mcp` without `Last-Event-ID` as a keepalive listener path

If your clients send an `Origin` header, remember that the default runtime allowlist is Claude-oriented:

- `https://claude.ai`
- `https://claude.com`

Use `mcp.WithOriginValidator(...)` when you need other browser origins.

## Related docs

- `docs/mcp.md`
- `docs/remote-mcp.md`
- `docs/cdk/mcp-protected-resource.md`
