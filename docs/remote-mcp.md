# Claude Remote MCP (Streamable HTTP) — AppTheory guide

This guide is for building **Claude Custom Connectors** using **Remote MCP** on top of AppTheory.

Locked decisions:
- **Transport:** MCP **Streamable HTTP** only (`POST/GET/DELETE /mcp` on one path)
- **AWS edge for streaming:** API Gateway **REST API v1** + Lambda **response streaming**
- **Auth (day‑1):** OAuth + DCR (public clients) compatible with MCP auth `2025-06-18`

If you’re looking for the full method surface and payload shapes, start with `docs/mcp.md`.

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
- Disconnections are not cancellation; resumability uses `GET /mcp` + `Last-Event-ID`.

## 2) Add OAuth protection (Remote MCP auth `2025-06-18`)

Claude discovers OAuth using:
- `401` + `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"`
- `GET /.well-known/oauth-protected-resource` (RFC9728)

AppTheory provides helpers in `runtime/oauth`:
- `oauth.RequireBearerTokenMiddleware(...)`
- `oauth.NewProtectedResourceMetadata(...)` + `oauth.ProtectedResourceMetadataHandler(...)`

You typically:
1) Protect all `/mcp` routes with `RequireBearerTokenMiddleware`.
2) Expose `/.well-known/oauth-protected-resource` (often via CDK mock integration; see below).
3) Validate Bearer tokens against Autheory (JWT verify via JWKS or introspection).

## 3) Deploy on AWS (REST API v1 response streaming)

Use these CDK constructs:
- `AppTheoryRemoteMcpServer` — provisions REST API v1 and enables Lambda response streaming for `/mcp` (POST/GET)
- `AppTheoryMcpProtectedResource` — adds `/.well-known/oauth-protected-resource` for discovery

See:
- `cdk/docs/mcp-server-remote-mcp.md`
- `cdk/docs/mcp-protected-resource.md`

## 4) Testing (no AWS required)

Deterministic test helpers:
- Streamable HTTP MCP client: `testkit/mcp`
  - buffered JSON calls: `NewClient(...).Initialize/ListTools/CallTool`
  - streaming SSE: `Client.RawStream(...)` + `Client.ResumeStream(...)`
- Claude-like OAuth harness (DCR → PKCE → refresh): `testkit/oauth`

## 5) Operational constraints (design for reconnect)

API Gateway REST response streaming connections are time-bounded and can disconnect. For “hours-long” logical sessions:
- keep sessions durable (`SessionStore` backed by DynamoDB)
- keep tool output durable (event log + `Last-Event-ID` replay)
- execute long work asynchronously (worker Lambdas) and append progress/results into the event log

See the compatibility contract + transcripts:
- `docs/development/planning/apptheory/remote-mcp/COMPATIBILITY_CONTRACT.md`
- `docs/development/planning/apptheory/remote-mcp/HTTP_TRANSCRIPTS.md`

## Examples

- Tools-only server: `examples/mcp/tools-only`
- Tools + resources + prompts: `examples/mcp/tools-resources-prompts`
- Resumable SSE tool call: `examples/mcp/resumable-sse`
