# Claude Remote MCP (Streamable HTTP) — REST API v1 + Streaming

This guide covers `AppTheoryRemoteMcpServer`, the recommended CDK construct for **Claude Custom Connectors** using **Remote MCP** with **MCP Streamable HTTP**.

## Why this construct exists

Claude Remote MCP requires real incremental streaming for tool calls (SSE). On AWS, that means:

- API Gateway **REST API v1** (not HTTP API v2)
- Lambda **response streaming** (`/response-streaming-invocations`)

`AppTheoryRemoteMcpServer` provisions a REST API and configures `/mcp` correctly for streaming.

## What it provisions

- API Gateway **REST API v1**
- default `/mcp` routes:
  - `POST /mcp` (streaming enabled)
  - `GET /mcp` (streaming enabled; used for `Last-Event-ID` replay/resume)
  - `DELETE /mcp`
- optional per-actor bundle when `actorPath: true`:
  - `POST /mcp/{actor}` (streaming enabled)
  - `GET /mcp/{actor}` (streaming enabled)
  - `DELETE /mcp/{actor}`
  - `GET /.well-known/oauth-protected-resource/mcp/{actor}` (co-registered RFC9728 discovery)
- optional root discovery route when `enableWellKnownMcpDiscovery: true`:
  - `GET /.well-known/mcp.json`
- Optional DynamoDB tables:
  - session table (matches `runtime/mcp` Dynamo session store schema)
  - stream/event table (used by durable resumable SSE once the app wires a persistent `StreamStore`)

If you are using OAuth for Claude connectors on the default `/mcp` route, also add:

- `GET /.well-known/oauth-protected-resource/mcp` (RFC9728 protected resource metadata)

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
  scopePermissionToMethod: false,
  enableSessionTable: true,
  sessionTtlMinutes: 120,
  // enableStreamTable: true, // optional; pair with mcp.NewDynamoStreamStore(db)
});

// Required for MCP auth `2025-06-18` discovery (Claude Remote MCP)
new AppTheoryMcpProtectedResource(stack, "ProtectedResource", {
  router: mcp.router,
  resource: mcp.endpoint,
  authorizationServers: ["https://auth.example.com"],
});

// MCP endpoint URL (…/mcp)
// mcp.endpoint
```

For per-actor bundles, enable `actorPath` and let the construct register discovery automatically:

```ts
const mcp = new AppTheoryRemoteMcpServer(stack, "RemoteMcpPerActor", {
  handler,
  actorPath: true,
  enableWellKnownMcpDiscovery: true,
});

// mcp.endpoint === https://.../mcp/{actor}
// discovery route === /.well-known/oauth-protected-resource/mcp/{actor}
// well-known discovery route === /.well-known/mcp.json
```

## Lambda permission policy size

For large Remote MCP route bundles that share one Lambda, set `scopePermissionToMethod: false` to collapse
per-route invoke permissions into one API-scoped permission per Lambda.

If you want to keep method-scoped permissions but suppress the extra API Gateway console
`test-invoke-stage` entries, set `allowTestInvoke: false` instead.

## Keepalive + resumability guidance

For SSE connections, expect disconnects (idle timeouts, client refresh, Lambda max duration). Prefer:

- **resumable streams** (`Last-Event-ID`) + replay from an event log
- emitting periodic progress updates during long-running work

When you provision the optional stream table, wire the Go runtime with `mcp.WithStreamStore(mcp.NewDynamoStreamStore(db))`
to use the canonical `sessionId` / `eventId` / `expiresAt` schema this construct creates.

## Related docs

- Go runtime MCP server: `docs/integrations/mcp.md`
- Remote MCP planning + compatibility contract: `docs/development/planning/apptheory/remote-mcp/README.md`
- Protected resource metadata (RFC9728): `cdk/docs/mcp-protected-resource.md`
