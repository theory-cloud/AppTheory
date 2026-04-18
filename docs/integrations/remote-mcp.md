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
- `tools/call` may stream with SSE when the client includes `Accept: text/event-stream`.
- SSE frames stay on `event: message`; progress is emitted as JSON-RPC `notifications/progress`, not custom SSE event names.
- Disconnections are not cancellation; resumability uses `GET /mcp` + `Last-Event-ID`.
- `GET /mcp` without `Last-Event-ID` stays open as a keepalive listener for the current session.
- If the request includes an `Origin` header, the default runtime allowlist is Claude-oriented (`https://claude.ai`,
  `https://claude.com`); use `mcp.WithOriginValidator(...)` for other browser origins.

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

When you deploy with `AppTheoryRemoteMcpServer`, the construct injects `MCP_ENDPOINT`. If
`RequireBearerTokenMiddleware(...)` is used without an explicit `ResourceMetadataURL`, the middleware derives the
RFC9728 protected-resource metadata challenge URL from that endpoint by default.

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
- execute long work asynchronously (worker Lambdas) and append progress/results into the event log

If you want the initial `GET /mcp` keepalive listener to end before the Lambda deadline, opt in with
`mcp.WithInitialSessionListenerBudget(...)`. This applies only to the initial listener path with no `Last-Event-ID`;
resume/replay `GET /mcp` requests keep their existing behavior. The example in `examples/mcp/resumable-sse` uses the
default budget values (`SafetyBuffer: 5s`, `MaxDuration: 25s`) explicitly so the Lambda behavior is visible in code.

Detailed compatibility notes and HTTP transcripts are maintained in non-canonical planning docs and intentionally kept
out of this user-facing guide.

## Examples

- Tools-only server: `examples/mcp/tools-only`
- Tools + resources + prompts: `examples/mcp/tools-resources-prompts`
- Resumable SSE tool call: `examples/mcp/resumable-sse`
