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
- default `/mcp` routes:
  - `POST /mcp` (streaming enabled)
  - `GET /mcp` (streaming enabled; used for `Last-Event-ID` replay and session listeners)
  - `DELETE /mcp`
- optional per-actor bundle when `actorPath: true`:
  - `POST /mcp/{actor}` (streaming enabled)
  - `GET /mcp/{actor}` (streaming enabled)
  - `DELETE /mcp/{actor}`
  - `GET /.well-known/oauth-protected-resource/mcp/{actor}` (co-registered RFC9728 discovery)
- Lambda env var `MCP_ENDPOINT` pointing at the resolved `/mcp` URL or `/mcp/{actor}` template
- optional DynamoDB tables:
  - session table (matches `runtime/mcp/session_dynamo.go` schema)
  - stream/event table (used by durable replay once the app wires a concrete `StreamStore`)

If you are using OAuth for Claude connectors on the default `/mcp` route, also add:

- `GET /.well-known/oauth-protected-resource/mcp`

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
  // cors: true,
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

For per-actor bundles, enable `actorPath` instead of adding a separate protected-resource construct:

```ts
const mcp = new AppTheoryRemoteMcpServer(stack, "RemoteMcpPerActor", {
  handler,
  actorPath: true,
});

// mcp.endpoint === https://.../mcp/{actor}
// discovery route === /.well-known/oauth-protected-resource/mcp/{actor}
```

On this REST API v1 deploy path, the actor-scoped transport and discovery routes accept both the canonical path and the
same path with a trailing slash. You do not need app-local trailing-slash stripping for `/mcp/{actor}` or
`/.well-known/oauth-protected-resource/mcp/{actor}` when they are provisioned through
`AppTheoryRemoteMcpServer({ actorPath: true })`.

## CORS option

`AppTheoryRemoteMcpServer` exposes the underlying REST router `cors` option for API Gateway preflight handling.

Important caveat:

- API Gateway CORS alone is not enough for browser-based callers
- your Lambda still needs to emit `Access-Control-Allow-Origin` on actual `/mcp` responses
- runtime origin validation is separate and still controlled by `mcp.WithOriginValidator(...)`

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

- `enableStreamTable` only provisions storage and injects env vars
- durable replay requires application code to wire a persistent `StreamStore` via `mcp.WithStreamStore(...)`
- the Go runtime ships `mcp.NewDynamoStreamStore(db)` for the canonical `sessionId` / `eventId` / `expiresAt` table
  shape provisioned by this construct

## Injected environment variables

`AppTheoryRemoteMcpServer` injects these environment variables when the corresponding features are enabled:

- always: `MCP_ENDPOINT`
- session table: `MCP_SESSION_TABLE`, `MCP_SESSION_TTL_MINUTES`
- stream table: `MCP_STREAM_TABLE`, `MCP_STREAM_TTL_MINUTES`

`MCP_ENDPOINT` is the canonical deployed MCP resource URL or template:

- execute-api hostname: `https://{apiId}.execute-api.{region}.amazonaws.com/{stage}/mcp`
- custom domain without base path: `https://mcp.example.com/mcp`
- custom domain with base path: `https://api.example.com/{basePath}/mcp`
- per-actor execute-api template: `https://{apiId}.execute-api.{region}.amazonaws.com/{stage}/mcp/{actor}`
- per-actor custom domain template: `https://mcp.example.com/mcp/{actor}`

This matters for OAuth discovery. If `oauth.RequireBearerTokenMiddleware(...)` is used without an explicit
`ResourceMetadataURL`, the middleware derives the RFC9728 `/.well-known/oauth-protected-resource` challenge URL from
`MCP_ENDPOINT`.

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

- `docs/integrations/mcp.md`
- `docs/integrations/remote-mcp.md`
- `docs/cdk/mcp-protected-resource.md`
