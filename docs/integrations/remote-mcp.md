---
title: Remote MCP
render_with_liquid: false
---

# Claude Remote MCP (Streamable HTTP) — AppTheory guide

This guide is for building **Claude Custom Connectors** using **Remote MCP** on top of AppTheory.

Locked decisions:
- **Transport:** one MCP **Streamable HTTP** path; session-ful 2025-11-25 uses `POST/GET/DELETE /mcp`, while stateless
  2026-07-28 uses `POST /mcp`
- **AWS edge for streaming:** API Gateway **REST API v1** + Lambda **response streaming**
- **Auth (day‑1):** OAuth + DCR (public clients) compatible with MCP auth `2025-06-18`

If you’re looking for the full method surface and payload shapes, start with `docs/integrations/mcp.md`.

## 1) Build a Streamable HTTP MCP server (Go)

```go
package main

import (
  "context"
  "encoding/json"

  apptheory "github.com/theory-cloud/apptheory/v2/runtime"
  "github.com/theory-cloud/apptheory/v2/runtime/mcp"
)

func buildApp() *apptheory.App {
  srv := mcp.NewServer("ExampleServer", "dev")

  type echoArgs struct {
    Message string `json:"message"`
  }

  _ = srv.Registry().RegisterTool(mcp.ToolDef{
    Name: "echo",
    Description: "Echo back the provided message.",
    InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`),
  }, mcp.WrapTool(mcp.ToolLifecycleOptions[echoArgs]{
    Name:       "echo",
    StrictJSON: true,
  }, func(ctx context.Context, in echoArgs) (*mcp.ToolResult, error) {
    return &mcp.ToolResult{Content: []mcp.ContentBlock{{Type: "text", Text: in.Message}}}, nil
  }))

  app := apptheory.New()
  h := srv.Handler()
  app.Post("/mcp", h)
  app.Get("/mcp", h)
  app.Delete("/mcp", h)
  return app
}
```

Important behaviors for Claude compatibility:
- AppTheory dual-serves the session-ful `2025-11-25` and final stateless `2026-07-28` shapes on the same handler.
- For `2025-11-25`, `initialize` returns `Mcp-Session-Id`, later requests carry that session id, and
  `notifications/initialized` returns `202 Accepted` with no body.
- For `2026-07-28`, every POST sends `Mcp-Protocol-Version: 2026-07-28` and the matching
  `params._meta["io.modelcontextprotocol/protocolVersion"]`. Metadata-only selection remains valid for non-HTTP
  bindings such as stdio, but the Streamable HTTP header is mandatory.
- Every 2026-07-28 request also sends
  `params._meta["io.modelcontextprotocol/clientCapabilities"]`, even when the declaration is empty.
- Each `2026-07-28` request or notification sends `Mcp-Method` equal to the JSON-RPC method. `tools/call`,
  `prompts/get`, and `resources/read` also send `Mcp-Name` equal to the routed `name` or `uri`.
- `Mcp-Name` may use the exact case-sensitive `=?base64?{value}?=` sentinel. AppTheory decodes canonical Base64
  before comparison and rejects malformed encoding with `-32020`.
- `server/discover` is routed by AppTheory in both transport shapes. It reports the server's supported protocol
  versions in preference order, derives capabilities from the configured registries and hooks, and returns the
  `NewServer(...)` name/version under `_meta["io.modelcontextprotocol/serverInfo"]`.
- `2026-07-28` clients do not initialize and never send or receive `Mcp-Session-Id`; `DELETE /mcp` is not routed for
  that shape. GET/subscriptions/listen support is intentionally outside this milestone. A posted JSON-RPC response is
  rejected with HTTP `400`; modern clients post only requests and notifications.
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
- Optional session-ful utility methods are hook-gated. Resource subscription requests require
  `mcp.WithResourceSubscriptionHooks(...)`, logging level requests require `mcp.WithLoggingLevelHook(...)`, and
  completions require `mcp.WithCompletionHooks(...)`. AppTheory advertises only capabilities it can deliver
  end-to-end: completions can be advertised with hooks today, while `resources.subscribe` and `logging` remain omitted
  until the outbound notification contracts for resource updates and log messages exist.
- `notifications/cancelled` cancels matching in-flight AppTheory requests for the same session and safely ignores
  unknown or already-completed request ids.
- MCP tasks are opt-in. AppTheory advertises `tasks` only for protocol `2025-11-25` discovery/initialize results when
  `mcp.WithTaskRuntime(...)` supplies a store and at least one registered tool declares task support.
- The stateless shape does not expose task methods or task-augmented `tools/call`; session-ful task behavior is
  unchanged.
- Task records are session-scoped. Products must bind the MCP session to the same principal, tenant, actor route, and
  entitlement policy used by OAuth validation before exposing task-capable tools.

### Discover the dual-version surface

Stateless clients call `server/discover` instead of `initialize`. Session-ful clients may call the same method before
initialization without a session id. AppTheory returns one server-owned advertisement in both cases:

- supported versions: `2026-07-28`, `2025-11-25`, `2025-06-18`, and `2025-03-26`, in that preference order
- capabilities derived from the server's enabled and registered tools, resources, prompts, completion hooks, and
  configured extensions; modern discovery omits `tasks` because AppTheory does not implement the 2026 task extension
- server identity from the name and version passed to `mcp.NewServer(...)`

The advertisement never includes a subscriptions capability. Do not add one in an application wrapper:
`subscriptions/listen` is outside AppTheory's Lambda transport contract.

Example stateless discovery request:

```bash
curl -sS \
  -X POST "https://YOUR_ENDPOINT/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: server/discover' \
  -d '{
    "jsonrpc":"2.0",
    "id":"discover",
    "method":"server/discover",
    "params":{
      "_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}
      }
    }
  }'
```

### `2026-07-28` results and fail-closed routing

Every successful stateless result carries `resultType: "complete"` or `resultType: "input_required"` and, by default,
includes the server name/version under `_meta["io.modelcontextprotocol/serverInfo"]`. The explicit server-level opt-out is
`mcp.WithServerInfoMetadata(false)` in Go, `includeServerInfoMetadata: false` in TypeScript, or
`include_server_info_metadata=False` in Python. For
`input_required`, collect the named `inputRequests`, preserve the returned `requestState`, and retry the original
request with `inputResponses`. Advertise the needed per-request client capabilities under
`params._meta["io.modelcontextprotocol/clientCapabilities"]`; AppTheory returns `-32021` when a required capability is
missing.

Modern transport validation errors are JSON-RPC envelopes returned with HTTP `400`:

- `-32020`: missing required `Mcp-Protocol-Version`, protocol/request `_meta` mismatch, or
  missing/mismatched/malformed `Mcp-Method`/`Mcp-Name`
- `-32021`: missing required client capability
- `-32022`: unsupported/future protocol version, including a sessionless request that would otherwise look like a
  missing legacy session
- `-32602`: missing or invalid required per-request protocol/client-capability metadata

The modern method set excludes `ping` and `logging/setLevel`. Those methods and every other unavailable modern method
return HTTP `404` with JSON-RPC `-32601`; session-ful method errors retain HTTP `200`.

Existing `2025-11-25` clients keep their session, initialize, response, SSE, and error behavior unchanged. See
`docs/migration/mcp-2026-07-28.md` for the client checklist.

Rate-limit integration is not a Remote MCP-specific feature. Route-, principal-, and tool-aware throttling should use the
normal AppTheory middleware path: validate OAuth/tenant policy, then mount `runtime.RateLimitMiddleware(...)` around the
`/mcp` routes with `pkg/limited` as the durable backend when shared counters are required. Product extractors may map the
normalized route, authenticated principal, actor path segment, JSON-RPC method, or tool name into the limiter key. Do not
add a second MCP wrapper or hard-code rate-limit capability metadata in `initialize`.

Strict transport rollout checklist:

- Canary one connector/client population first and confirm it sends the strict `Accept` and `Content-Type` headers.
- Confirm the client carries forward the negotiated protocol version, or omits `Mcp-Protocol-Version` after
  initialization so AppTheory uses the session value.
- For a stateless client, confirm `Mcp-Method` and any required `Mcp-Name` exactly match the JSON-RPC body.
- Confirm every stateless POST carries `Mcp-Protocol-Version: 2026-07-28` plus both required request `_meta` fields.
- Confirm stateless callers branch on `result.resultType` and preserve multi-round `requestState`.
- Confirm the client records the first SSE `id`, even when its `data:` field is empty, before long-running work emits
  progress.
- Confirm reconnect uses `GET /mcp` with the latest `Last-Event-ID` for the same session and stream.
- Treat HTTP `400` and modern method-probe `404` responses during canary as compatibility signals to handle in the
  client, not as server fallbacks to loosen.
- Do not hard-code `resources.subscribe`, `logging`, or `completions` capabilities in a Remote MCP product wrapper.
  Configure the AppTheory hook, let AppTheory emit the initialize capability, and keep the capability absent until
  product authorization and tenant policy are ready.
- Do not hard-code `tasks` in a Remote MCP product wrapper. Keep task runtime disabled until asynchronous-work policy,
  audit logging, quotas, and abuse controls are wired.

- Do not introduce a Remote MCP-specific rate limiter. Use `RateLimitMiddleware` plus `pkg/limited` in the AppTheory
  middleware chain, and fail closed or withhold a tool/task when the product cannot derive the scoped limiter bucket.

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
- Invalid-audience bearer tokens are intentionally treated as authorization failures: the fixture-pinned response is
  `403 app.forbidden` without a `WWW-Authenticate` challenge, matching insufficient-scope denial. Missing or expired
  bearer tokens remain `401` discovery/challenge cases.

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
The Dynamo stream store keeps small logical events inline in DynamoDB and spills larger events to private S3 objects
through AppTheory's internal object-store helper using the injected `MCP_STREAM_SPILL_BUCKET` and
`MCP_STREAM_SPILL_PREFIX` configuration. Spill writes use S3-managed server-side encryption; there are no Remote MCP KMS
construct props in this contract. The inline spill threshold is bounded to AppTheory's DynamoDB-safe ceiling so
oversized inline writes fail closed into S3 spill instead of DynamoDB item-size errors. Clients still see one JSON-RPC
SSE message per logical event, and resume/replay continues to use `Last-Event-ID`; there is no client-visible chunk or
presigned URL protocol.

Replay reads for S3-spilled events go through the same private object-store helper and are bounded before validation:
AppTheory caps the S3 body read by the recorded event byte count and `MCP_STREAM_MAX_EVENT_BYTES`, then verifies the
recorded byte count and SHA-256 hash. Oversized,
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
