# Claude Remote MCP (Streamable HTTP) — AppTheory guide

This guide is for building **Claude Custom Connectors** using **Remote MCP** on top of AppTheory.

Locked decisions:
- **Transport:** MCP **Streamable HTTP** only (`POST/GET/DELETE /mcp` on one path)
- **AWS edge for streaming:** API Gateway **REST API v1** + Lambda **response streaming**
- **Auth (day‑1):** OAuth + DCR (public clients) compatible with MCP auth `2025-06-18`

If you’re looking for the full method surface and payload shapes, start with `docs/integrations/mcp.md`.

## 1) Build a Streamable HTTP MCP server (Go)

```go
package main

import (
  "context"
  "encoding/json"

  apptheory "github.com/theory-cloud/apptheory/runtime"
  "github.com/theory-cloud/apptheory/runtime/mcp"
)

func buildApp() *apptheory.App {
  srv := mcp.NewServer("ExampleServer", "dev")

  _ = srv.Registry().RegisterTool(mcp.ToolDef{
    Name: "echo",
    Description: "Echo back the provided message.",
    InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`),
  }, func(ctx context.Context, args json.RawMessage) (*mcp.ToolResult, error) {
    var in struct{ Message string `json:"message"` }
    if err := json.Unmarshal(args, &in); err != nil {
      return nil, err
    }
    return &mcp.ToolResult{Content: []mcp.ContentBlock{{Type: "text", Text: in.Message}}}, nil
  })

  app := apptheory.New()
  h := srv.Handler()
  app.Post("/mcp", h)
  app.Get("/mcp", h)
  app.Delete("/mcp", h)
  return app
}
```

Important behaviors for Claude compatibility:
- `initialize` returns `Mcp-Session-Id` and must negotiate `protocolVersion` (`2025-11-25`).
- `notifications/initialized` must return `202 Accepted` with no body.
- `POST /mcp` requires `Content-Type: application/json` and `Accept: application/json, text/event-stream`.
- `GET /mcp` requires `Accept: text/event-stream`.
- `tools/call` may stream with SSE when the target tool is registered for streaming and the client advertises SSE.
- SSE streams start with an empty-data priming event carrying a replay-safe `id`.
- Application SSE frames stay on `event: message`; progress is emitted as JSON-RPC `notifications/progress`, not custom
  SSE event names.
- Disconnections are not cancellation; resumability uses `GET /mcp` + `Last-Event-ID`.
- `Last-Event-ID` replay is stream-bound. A cursor from another stream fails closed instead of replaying unrelated
  events.
- `GET /mcp` without `Last-Event-ID` emits a short-lived keepalive SSE response by default.
- If you want that path to stay open for a bounded window on Lambda, use
  `mcp.WithInitialSessionListenerBudget(...)`.
- If the request includes an `Origin` header, the default runtime allowlist is Claude-oriented (`https://claude.ai`,
  `https://claude.com`); use `mcp.WithOriginValidator(...)` for other browser origins.
- Tool handler panics are recovered as sanitized JSON-RPC internal errors. Do not rely on panic text reaching the
  client; AppTheory logs it server-side and keeps the MCP server reusable.
- Optional utility methods are hook-gated. Resource subscription requests require
  `mcp.WithResourceSubscriptionHooks(...)`, logging level requests require `mcp.WithLoggingLevelHook(...)`, and
  completions require `mcp.WithCompletionHooks(...)`. AppTheory advertises only capabilities it can deliver
  end-to-end: completions can be advertised with hooks today, while `resources.subscribe` and `logging` remain omitted
  until the outbound notification contracts for resource updates and log messages exist.
- `notifications/cancelled` cancels matching in-flight AppTheory requests for the same session and safely ignores
  unknown or already-completed request ids.
- MCP tasks are opt-in. AppTheory advertises `tasks` only for protocol `2025-11-25` sessions when
  `mcp.WithTaskRuntime(...)` supplies a store and at least one registered tool declares task support.
- Task records are session-scoped. Products must bind the MCP session to the same principal, tenant, actor route, and
  entitlement policy used by OAuth validation before exposing task-capable tools.

Strict transport rollout checklist:

- Canary one connector/client population first and confirm it sends the strict `Accept` and `Content-Type` headers.
- Confirm the client carries forward the negotiated protocol version, or omits `Mcp-Protocol-Version` after
  initialization so AppTheory uses the session value.
- Confirm the client records the first SSE `id`, even when its `data:` field is empty, before long-running work emits
  progress.
- Confirm reconnect uses `GET /mcp` with the latest `Last-Event-ID` for the same session and stream.
- Treat HTTP `400` responses during canary as compatibility failures to fix in the client, not as server fallbacks to
  loosen.
- Do not hard-code `resources.subscribe`, `logging`, or `completions` capabilities in a Remote MCP product wrapper.
  Configure the AppTheory hook, let AppTheory emit the initialize capability, and keep the capability absent until
  product authorization and tenant policy are ready.
- Do not hard-code `tasks` in a Remote MCP product wrapper. Keep task runtime disabled until asynchronous-work policy,
  audit logging, quotas, and abuse controls are wired.

## 2) Add OAuth protection (Remote MCP auth `2025-06-18`)

Claude discovers OAuth using:
- `401` + `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/...resource path..."`
- `GET /.well-known/oauth-protected-resource/...resource path...` (RFC9728)

AppTheory provides helpers in `runtime/oauth`:
- `oauth.RequireBearerTokenMiddleware(...)`
- `oauth.NewProtectedResourceMetadata(...)` + `oauth.ProtectedResourceMetadataHandler(...)`

You typically:
1) Protect all `/mcp` routes with `RequireBearerTokenMiddleware`.
2) Expose the matching path-scoped `/.well-known/oauth-protected-resource/...` route (often via CDK mock integration;
   see below).
3) Validate Bearer tokens against Autheory (JWT verify via JWKS or introspection).

Important fail-closed rules:
- `RequireBearerTokenMiddleware(...)` now requires a `Validator`. If you omit it, the middleware rejects every request
  with `401` instead of accepting any syntactically valid Bearer token.
- The middleware derives the RFC9728 protected-resource metadata challenge URL only from an explicit
  `ResourceMetadataURL` or from the injected `MCP_ENDPOINT`. It no longer falls back to `Host` /
  `X-Forwarded-Proto` request headers.

When you deploy with `AppTheoryRemoteMcpServer`, the construct injects `MCP_ENDPOINT`. That is the canonical metadata
source when you do not provide `ResourceMetadataURL` explicitly.

For migration notes covering Bearer validation, initial listener keepalive changes, and expired-session fail-closed
behavior, see `docs/migration/v1-security.md`.

## 3) Deploy on AWS (REST API v1 response streaming)

Use these CDK constructs:
- `AppTheoryRemoteMcpServer` — provisions REST API v1 and enables Lambda response streaming for `/mcp` (POST/GET)
- `AppTheoryMcpProtectedResource` — adds the path-scoped `/.well-known/oauth-protected-resource/...` route for
  discovery

See:
- `docs/cdk/mcp-server-remote-mcp.md`
- `docs/cdk/mcp-protected-resource.md`

If you enable the optional Remote MCP stream table, wire a concrete persistent `StreamStore` such as
`mcp.NewDynamoStreamStore(db)` with `mcp.WithStreamStore(...)`. `enableStreamTable` alone still only provisions the
storage and env vars.

If you enable the optional Remote MCP session table, wire `mcp.WithSessionStore(mcp.NewDynamoSessionStore(db))`.
`DynamoSessionStore.Put` upserts sessions so sliding-session access refreshes TTL/data on the existing item.

If you enable the optional Remote MCP task table, wire
`mcp.WithTaskRuntime(mcp.TaskRuntimeOptions{Store: mcp.NewDynamoTaskStore(db)})`. `enableTaskTable` only provisions
storage and injects `MCP_TASK_TABLE` / `MCP_TASK_TTL_MINUTES`; it does not advertise task capability by itself. The
runtime still requires a configured task store and a tool with `ToolExecution.TaskSupport` set to `optional` or
`required`.

`MCP_TASK_TTL_MINUTES` is the default task lifetime used when the app does not set `TaskRuntimeOptions.DefaultTTL`.
Client-supplied `task.ttl` values are milliseconds and fail closed when they are non-positive or exceed the configured
maximum. `DynamoTaskStore` checks expiry before returning task state, so DynamoDB TTL cleanup is a storage backstop, not
the access-control boundary.

Task cancellation is cooperative. `tasks/cancel` marks the session-scoped task canceled and cancels AppTheory's
in-flight tool context when that task is still running. If the work has already completed, the terminal task state is not
rewritten.

`AppTheoryRemoteMcpServer` also provisions the canonical private S3 spill bucket whenever `enableStreamTable` is true.
The Dynamo stream store keeps small logical events inline in DynamoDB and spills larger events to S3 using the injected
`MCP_STREAM_SPILL_BUCKET` configuration. The inline spill threshold is bounded to AppTheory's DynamoDB-safe ceiling so
oversized inline writes fail closed into S3 spill instead of DynamoDB item-size errors. Clients still see one JSON-RPC
SSE message per logical event, and resume/replay continues to use `Last-Event-ID`; there is no client-visible chunk or
presigned URL protocol.

Replay reads for S3-spilled events are bounded before validation: AppTheory caps the S3 body read by the recorded event
byte count and `MCP_STREAM_MAX_EVENT_BYTES`, then verifies the recorded byte count and SHA-256 hash. Oversized,
truncated, or tampered spill objects fail closed instead of being streamed to the client.

`MCP_STREAM_TTL_MINUTES` is the runtime replay window. `DynamoStreamStore` rejects expired event records before
resolving `Last-Event-ID` or reading inline/S3-spilled event data, even if DynamoDB TTL or S3 lifecycle cleanup has not
physically removed the backing records or objects yet. S3 lifecycle remains a cleanup backstop, not access enforcement.

For production durable replay, pass the standard TableTheory DB to `mcp.NewDynamoStreamStore(db)`. That DB implements
`TransactWrite`, which AppTheory uses for the strongest `DeleteSession`/`Append` race protection after S3 spill writes.
Custom `tablecore.DB` implementations without `TransactWrite` are suitable for tests only; they cannot make the final
event create atomic with session deletion.

For actor-scoped deployments on this sanctioned REST API v1 path, AppTheory now accepts both `/mcp/{actor}` and
`/mcp/{actor}/`, plus the matching
`/.well-known/oauth-protected-resource/mcp/{actor}` / `/.well-known/oauth-protected-resource/mcp/{actor}/` forms.
You no longer need app-local trailing-slash stripping for those Remote MCP routes. This is intentionally narrow to the
Remote MCP REST API v1 path and is not a broad router-wide canonicalization rule.

## 4) Testing (no AWS required)

Deterministic test helpers:
- Streamable HTTP MCP client: `testkit/mcp`
  - buffered JSON calls: `NewClient(...).Initialize/ListTools/CallTool`
  - streaming SSE: `Client.RawStream(...)` + `Client.ResumeStream(...)`
  - disconnect/replay assertions: `Stream.Response()`, `Stream.Cancel()`, `Stream.Next()`, `Stream.ReadAll()`
- Claude-like OAuth harness (DCR → PKCE → refresh): `testkit/oauth`

Example OAuth harness usage:

```go
oauthClient := oauthtest.NewClaudePublicClient(nil)

discovery, dcr, tokenResp, refreshResp, err := oauthClient.Authorize(ctx, oauthtest.AuthorizeOptions{
  McpEndpoint: "https://api.example.com/prod/mcp",
})
```

Notes:

- `AuthorizeOptions.Origin` defaults to `https://claude.ai`
- `AuthorizeOptions.RedirectURI` defaults to `https://claude.ai/api/mcp/auth_callback`
- `McpEndpoint` is normalized to the canonical `/mcp` resource URL before discovery starts

## 5) Operational constraints (design for reconnect)

API Gateway REST response streaming connections are time-bounded and can disconnect. For “hours-long” logical sessions:
- keep sessions durable (`SessionStore` backed by DynamoDB)
- keep tool output durable (event log + `Last-Event-ID` replay) by wiring `mcp.NewDynamoStreamStore(db)` or another
  persistent `StreamStore`
- keep asynchronous tool task state durable by wiring `mcp.NewDynamoTaskStore(db)` through `mcp.WithTaskRuntime(...)`
  only after principal/tenant/actor policy is ready
- let AppTheory manage large stream payload storage through the Remote MCP S3 spill bucket; do not split tool responses
  or return object links as a tool-specific workaround
- execute long work asynchronously (worker Lambdas) and append progress/results into the event log

If you want the initial `GET /mcp` keepalive path to stay open for a bounded window before the Lambda deadline, opt in
with `mcp.WithInitialSessionListenerBudget(...)`. This applies only to the initial listener path with no
`Last-Event-ID`; resume/replay `GET /mcp` requests keep their existing behavior. The example in
`examples/mcp/resumable-sse` uses the default budget values (`SafetyBuffer: 5s`, `MaxDuration: 25s`) explicitly so the
Lambda behavior is visible in code.

Detailed compatibility notes and HTTP transcripts are maintained in non-canonical planning docs and intentionally kept
out of this user-facing guide.

## Examples

- Tools-only server: `examples/mcp/tools-only`
- Tools + resources + prompts: `examples/mcp/tools-resources-prompts`
- Resumable SSE tool call: `examples/mcp/resumable-sse`
