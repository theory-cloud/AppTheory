---
title: Remote MCP Server
---

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
  - `POST /mcp` (both protocol shapes; streaming enabled for session-ful tools)
  - `GET /mcp` (2025-11-25 only; streaming replay and session listeners)
  - `DELETE /mcp` (2025-11-25 session termination)
- optional per-actor bundle when `actorPath: true`:
  - `POST /mcp/{actor}` (streaming enabled)
  - `GET /mcp/{actor}` (streaming enabled)
  - `DELETE /mcp/{actor}`
  - `GET /.well-known/oauth-protected-resource/mcp/{actor}` (co-registered RFC9728 discovery)
- the route contract as construct properties: `endpoint` (transport URL template) and the route-derived
  `protectedResourceMetadataUrl` (RFC 9728 metadata URL template); no `MCP_ENDPOINT` environment variable is injected
- optional DynamoDB tables:
  - session table (matches `runtime/mcp/session_dynamo.go` schema)
  - stream/event table (used by durable replay once the app wires a concrete `StreamStore`)
  - task table (used by the MCP task runtime once the app wires a concrete `TaskStore`)

If you are using OAuth for Claude connectors on the default `/mcp` route, also add:

- `GET /.well-known/oauth-protected-resource/mcp`

## Dual-version runtime contract

`AppTheoryRemoteMcpServer` deploys one handler and one route bundle. The runtime—not a CDK prop—selects between:

- established `2025-11-25` initialize/session/SSE behavior
- final `2026-07-28` stateless POST behavior

Modern clients call `server/discover`, send `Mcp-Method` on every JSON-RPC request/notification, and send `Mcp-Name`
for `tools/call`, `prompts/get`, and `resources/read`. Their successful results carry `resultType`; modern
header/version/capability validation can return `-32020`, `-32021`, or `-32022` with HTTP `400`.

The optional session, stream, and task tables continue to support the session-ful transport. Stateless requests neither
use those tables as a substitute session nor require a separate construct. `2026-07-28` GET/listen/subscriptions are not
advertised or routed.

Existing `2025-11-25` deployments require no construct changes. See `docs/migration/mcp-2026-07-28.md` before enabling a
modern client.

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
  // enableTaskTable: true,
  // taskTtlMinutes: 10,
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

## Session, stream, and task tables

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
  - `MCP_STREAM_SPILL_BUCKET`
  - `MCP_STREAM_SPILL_PREFIX`
  - `MCP_STREAM_SPILL_INLINE_MAX_BYTES`
  - `MCP_STREAM_MAX_EVENT_BYTES`

Important caveat:

- `enableStreamTable` only provisions storage and injects env vars
- durable replay requires application code to wire a persistent `StreamStore` via `mcp.WithStreamStore(...)`
- the Go runtime ships `mcp.NewDynamoStreamStore(db)` for the canonical `sessionId` / `eventId` / `expiresAt` table
  shape provisioned by this construct
- use the standard TableTheory DB with `mcp.NewDynamoStreamStore(db)` for production durable replay; its `TransactWrite`
  support is what gives `DynamoStreamStore` the strongest `DeleteSession`/`Append` race protection after spill writes
- `MCP_STREAM_TTL_MINUTES` is the runtime replay window; expired event records are unreplayable before inline or spilled
  data is read, even if DynamoDB TTL and S3 lifecycle have not physically cleaned up yet
- the construct also provisions a private, S3-managed encrypted S3 spill bucket for large logical stream event payloads;
  DynamoDB remains the replay index and stores the object pointer, byte count, and hash
- `streamSpillInlineMaxBytes` defaults to `32768` and must not exceed the DynamoDB-safe inline ceiling of `358400`;
  larger logical events spill to S3 instead of risking DynamoDB item-size failures
- MCP clients still receive normal JSON-RPC SSE messages. The spill bucket is accessed only through AppTheory's
  private object-store helper and is never exposed through presigned URLs or a client-visible chunking protocol.

Task table behavior:

- partition key: `sessionId`
- sort key: `taskId`
- TTL attribute: `expiresAt`
- Lambda env vars:
  - `MCP_TASK_TABLE`
  - `MCP_TASK_TTL_MINUTES`

Important caveat:

- `enableTaskTable` only provisions storage and injects env vars
- task capability advertisement still requires application code to wire `mcp.WithTaskRuntime(...)` with a concrete
  `TaskStore`
- the Go runtime ships `mcp.NewDynamoTaskStore(db)` for the canonical `sessionId` / `taskId` / `expiresAt` table shape
  provisioned by this construct
- at least one tool must declare `ToolExecution.TaskSupport` as `optional` or `required` before AppTheory advertises
  `tasks`
- `MCP_TASK_TTL_MINUTES` is the default runtime task lifetime; client-supplied `task.ttl` values are milliseconds and
  fail closed when they are non-positive or exceed `TaskRuntimeOptions.MaxTTL`
- task lookups, lists, results, cancellation, and session deletion stay scoped to the active MCP session id; products
  must bind that session to their principal, tenant, route, and entitlement policy before exposing task-capable tools
- `tasks/cancel` marks the session-scoped task canceled and cancels AppTheory's in-flight tool context when the work is
  still running; completed or otherwise terminal task state is not rewritten

## Injected environment variables

`AppTheoryRemoteMcpServer` injects these environment variables when the corresponding features are enabled:

- session table: `MCP_SESSION_TABLE`, `MCP_SESSION_TTL_MINUTES`
- stream table: `MCP_STREAM_TABLE`, `MCP_STREAM_TTL_MINUTES`
- stream spill: `MCP_STREAM_SPILL_BUCKET`, `MCP_STREAM_SPILL_PREFIX`, `MCP_STREAM_SPILL_INLINE_MAX_BYTES`,
  `MCP_STREAM_MAX_EVENT_BYTES`
- task table: `MCP_TASK_TABLE`, `MCP_TASK_TTL_MINUTES`

The route contract is exposed as construct properties, not environment variables. `endpoint` is the transport URL
template (`.../mcp`, or `.../mcp/{actor}` when `actorPath: true`) and `protectedResourceMetadataUrl` is the
route-derived RFC 9728 protected-resource metadata URL template, both derived from the same route model through the
shared MCP route algebra. With `actorPath: true` the property is a real URL for the deployed API whose only remaining
template placeholder is `{actor}` — the construct has already resolved the concrete API id, region, stage (or
custom-domain base path), so it is not a string to retype by hand:

```text
https://a1b2c3d4.execute-api.us-east-1.amazonaws.com/prod/.well-known/oauth-protected-resource/mcp/{actor}
```

The `https://{apiId}.execute-api.{region}.amazonaws.com/{stage}/...` form is schematic. Placeholders in the URL
authority are refused by the runtime's template compiler; only `{actor}`, a placeholder naming a matched route
parameter, survives. Without `actorPath` the property is the family form
`.../.well-known/oauth-protected-resource/mcp`.

This matters for OAuth discovery. The runtime reads no environment variable for the challenge, and the construct
injects none (the framework-injected `MCP_ENDPOINT` is retired). The supported wiring is explicit in your own app code:
your CDK passes `server.protectedResourceMetadataUrl` into a configuration surface you already own, and your app passes
that value to the runtime as the template option.

Adopter's CDK — hand the property to your own config (a Lambda environment variable, a parameter-store value, or
anything else you control):

```ts
const mcp = new AppTheoryRemoteMcpServer(stack, "Mcp", { handler, actorPath: true });

new Function(stack, "App", {
  // ... your own config surface:
  environment: { RESOURCE_METADATA_URL_TEMPLATE: mcp.protectedResourceMetadataUrl },
});
```

Adopter's app — wire that value as a per-actor template so the middleware resolves `{actor}` from the matched route:

```go
// Go
middleware := oauth.RequireBearerTokenMiddleware(oauth.RequireBearerTokenOptions{
    ResourceMetadataURLTemplate: cfg.ResourceMetadataURLTemplate,
    ClaimsValidator:             validateAccessToken,
})
```

```ts
// TypeScript
app.use(requireBearerTokenMiddleware({
    resourceMetadataURLTemplate: cfg.resourceMetadataURLTemplate,
    claimsValidator: validateAccessToken,
}));
```

```python
# Python
middleware = require_bearer_token_middleware(RequireBearerTokenOptions(
    resource_metadata_url_template=cfg.resource_metadata_url_template,
    claims_validator=validate_access_token,
))
```

Pinned template rules:

- every `{param}` placeholder must name a parameter of the matched route; interpolation reads only that route's path
  parameters,
- a substituted value must be 1..128 bytes of `[a-z0-9._~-]` and must not be `.` or `..`; any other value, or a
  placeholder the matched route does not supply, degrades the challenge to the bare `Bearer` form,
- a malformed template fails at startup (panic / throw / raise) when the middleware is registered,
- precedence is resolver > template > static URL (`ResourceMetadataURLFunc` > `ResourceMetadataURLTemplate` >
  `ResourceMetadataURL`),
- the middleware reads no environment variable.

`MCP_ENDPOINT` is retired — no construct writes it and no runtime reads it. With no resolver, no template, and no
explicit `ResourceMetadataURL`, the challenge is the bare `Bearer` form. When `actorPath: true` the construct emits a
synth warning naming `protectedResourceMetadataUrl` and this wiring — a protected per-actor route that advertises only
the bare `Bearer` challenge breaks Claude's RFC 9728 discovery.

Important fail-closed rules:

- `RequireBearerTokenMiddleware(...)` requires an explicit `Validator`; omitting it causes every request to be rejected
  with `401`.
- The middleware no longer derives protected-resource metadata from `Host` / `X-Forwarded-Proto` request headers.
  Configure the construct's `protectedResourceMetadataUrl` as the `ResourceMetadataURLTemplate` option (per-actor) so
  the middleware interpolates `{actor}` from the matched route, or use a resolver / explicit `ResourceMetadataURL`.
- Invalid-audience bearer tokens are intentionally treated as authorization failures: the fixture-pinned response is
  `403 app.forbidden` without a `WWW-Authenticate` challenge, matching insufficient-scope denial. Missing or expired
  bearer tokens remain `401` discovery/challenge cases.

For migration notes covering Bearer validation, initial listener keepalive changes, and expired-session fail-closed
behavior, see `docs/migration/v1-security.md`.

## Keepalive, replay, and origin guidance

For SSE connections, expect disconnects. Prefer:

- resumable streams (`Last-Event-ID`) + replay from an event log
- periodic progress updates during long-running work
- `GET /mcp` without `Last-Event-ID` as a keepalive listener path

Strict Streamable HTTP compatibility:

- `POST /mcp` clients must send `Content-Type: application/json` and
  `Accept: application/json, text/event-stream`
- `GET /mcp` clients must send `Accept: text/event-stream`
- clients should omit `Mcp-Protocol-Version` after `initialize` or send the exact negotiated session version
- streaming responses start with an empty-data priming event; clients should store that `id` for reconnect before
  progress or result messages arrive
- `Last-Event-ID` replay is stream-bound; AppTheory fails closed if the cursor belongs to another stream
- canary older clients before rollout, especially clients that previously sent JSON-only `Accept` headers or assumed the
  first SSE frame was JSON-RPC

If your clients send an `Origin` header, remember that the default runtime allowlist is Claude-oriented:

- `https://claude.ai`
- `https://claude.com`

Use `mcp.WithOriginValidator(...)` when you need other browser origins.

## Related docs

- `docs/integrations/mcp.md`
- `docs/integrations/remote-mcp.md`
- `docs/cdk/mcp-protected-resource.md`
