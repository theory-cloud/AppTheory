---
title: AgentCore MCP
render_with_liquid: false
---

# Bedrock AgentCore + AppTheory (MCP Gateway)

This guide explains how to expose an **MCP (Model Context Protocol)** server from an AppTheory Lambda so **Bedrock AgentCore** can call your tools.

AppTheory provides two building blocks:

- **Runtime (Go):** `github.com/theory-cloud/apptheory/v4/runtime/mcp` — a dual-version MCP JSON-RPC handler
  (`server/discover`, `initialize`, `tools/*`, plus optional `resources/*` and `prompts/*`), registries, sessions, and
  optional SSE progress streaming.
- **CDK (TypeScript/Python):** `AppTheoryMcpServer` — an API Gateway v2 route-family facade. Its default is the
  canonical four-kind family with MCP `POST`/`GET`/`DELETE` plus the full OAuth facade. AgentCore's singleton shape is
  an explicit specialization. Session state is on by default and configured through `sessionState`; owned domains and
  stages are configured under `ownedApi`.

For the full MCP method surface (including `resources/*` and `prompts/*`), see `docs/integrations/mcp.md`.

If you’re trying to answer “what do I deploy and what code do I write?”, start with **Quick Start** below.

---

## What you deploy (high level)

```
Bedrock AgentCore  ──HTTP POST /mcp──>  explicit singleton route family  ──>  Lambda (Go)
                                                                           └──>  app.Post("/mcp", ...)
                                                                                 └──> MCP server (tools registry)
```

Key details:

- AgentCore calls **`POST /mcp`** only when the deployment explicitly selects `routeFamily: { patterns: ["/mcp"] }`.
- This noncanonical family requires application-owned runtime registration. `runtime/mcpfacade.RegisterMCPFacade` serves
  only the canonical four-pattern family and cannot be configured as the singleton runtime counterpart.
- The payload is **JSON-RPC 2.0** (`jsonrpc: "2.0"`) with an `id`, `method`, and optional `params`.
- Existing `2025-11-25` clients initialize and track session state with **`Mcp-Session-Id`**.
- Final `2026-07-28` clients use stateless POST requests and do not initialize or send a session id.
- Ordinary MCP method errors use JSON-RPC errors with HTTP `200`; modern routing/version/capability validation uses a
  JSON-RPC error with HTTP `400`.

---

## Quick start (Go runtime)

Deploy the explicit singleton route family described below, register `POST /mcp` in the application, and point
AgentCore at the resulting `/mcp` URL.

```go
package main

import (
  "context"
  "encoding/json"
  "fmt"
  "os"

  "github.com/aws/aws-lambda-go/events"
  "github.com/aws/aws-lambda-go/lambda"

  apptheory "github.com/theory-cloud/apptheory/v4/runtime"
  "github.com/theory-cloud/apptheory/v4/runtime/mcp"
)

func serviceVersion() string {
  if v := os.Getenv("SERVICE_VERSION"); v != "" {
    return v
  }
  return "dev"
}

func main() {
  srv := mcp.NewServer("my-agentcore-tools", serviceVersion())

  // Example tool: echo
  if err := srv.Registry().RegisterTool(mcp.ToolDef{
    Name:        "echo",
    Description: "Echo back the provided message.",
    InputSchema: json.RawMessage(`{
      "type": "object",
      "properties": { "message": { "type": "string" } },
      "required": ["message"]
    }`),
  }, func(ctx context.Context, args json.RawMessage) (*mcp.ToolResult, error) {
    var in struct {
      Message string `json:"message"`
    }
    if err := json.Unmarshal(args, &in); err != nil {
      return nil, fmt.Errorf("invalid args: %w", err)
    }
    return &mcp.ToolResult{
      Content: []mcp.ContentBlock{{Type: "text", Text: in.Message}},
    }, nil
  }); err != nil {
    panic(err)
  }

  app := apptheory.New()
  app.Post("/mcp", srv.Handler())

  lambda.Start(func(ctx context.Context, ev events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
    return app.ServeAPIGatewayV2(ctx, ev), nil
  })
}
```

---

## Deploy with AppTheory CDK (`AppTheoryMcpServer`)

Use an explicit noncanonical family for the application-owned `POST /mcp` registration shown above:

```ts
const mcp = new AppTheoryMcpServer(this, "McpServer", {
  handler,
  routeFamily: { patterns: ["/mcp"] },
  // No OAuth facade is deployed; authentication remains application-owned.
  unauthenticatedMcp: true,
});
```

The construct wires the MCP transport methods for `/mcp`; AgentCore uses `POST`, and the application registers the
matching runtime handler. If a singleton deployment needs the full OAuth facade instead, omit `unauthenticatedMcp`
and register every derived `routeInventory` entry in application code. Do not use `RegisterMCPFacade`: it serves only
the canonical default family.

See: `docs/cdk/mcp-server-agentcore.md`.

---

## MCP protocol surface (what AgentCore calls)

AppTheory’s MCP server implements these JSON-RPC methods:

- `server/discover`
- `initialize`
- `tools/list`
- `tools/call`

AgentCore typically uses only the tools surface. AppTheory also supports additional MCP methods for non-AgentCore clients (`resources/*`, `prompts/*`) — see `docs/integrations/mcp.md`.

The application-owned singleton handler above serves two protocol shapes through its `POST /mcp` registration:

| Protocol | Client behavior |
| --- | --- |
| `2025-11-25` | Call `initialize`, retain `Mcp-Session-Id`, and use the established session-ful response contract |
| `2026-07-28` | Call `server/discover`, send stateless requests with modern routing headers, and read `resultType` |

Existing AgentCore integrations do not need to migrate to the stateless shape. If an AgentCore client adds
`2026-07-28`, follow `docs/migration/mcp-2026-07-28.md`; do not add a second Lambda handler or deployment mode.

### Example: initialize

```bash
curl -sS -i \
  -X POST "https://YOUR_ENDPOINT/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"agentcore","version":"unknown"}}}'
```

- The response includes a `mcp-session-id` header.
- Send that header on subsequent calls to keep a session.
- Send `mcp-protocol-version` on subsequent calls as well.

### Example: list tools

```bash
curl -sS \
  -X POST "https://YOUR_ENDPOINT/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: ${MCP_SESSION_ID}" \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

### Example: call a tool

```bash
curl -sS \
  -X POST "https://YOUR_ENDPOINT/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: ${MCP_SESSION_ID}" \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{
      "name":"echo",
      "arguments":{"message":"hello"}
    }
  }'
```

### Example: stateless discovery

The modern shape does not call `initialize`:

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

For every `2026-07-28` request or notification, `Mcp-Method` must match the JSON-RPC method. `tools/call` also needs
`Mcp-Name` equal to `params.name`. Successful results carry `resultType: "complete"` or
`resultType: "input_required"`. AppTheory returns `-32020` for routing/header mismatches, `-32021` for a missing
capability needed by multi-round input, and `-32022` for an unsupported version. The discover advertisement excludes
subscriptions/listen.

---

## `2025-11-25` sessions

The established session-ful shape uses a lightweight session mechanism:

- `initialize` issues **`mcp-session-id`**.
- After initialization, clients must send **`mcp-session-id`** on follow-up requests.
- Missing session headers fail with `400`.
- Unknown or expired sessions fail with `404`.
- TTL is controlled by `MCP_SESSION_TTL_MINUTES` (default: `60` minutes).

### Persistence options

By default, sessions are stored in-memory (fine for local/dev; not shared across cold starts).

For persistent session storage, use the DynamoDB-backed store:

```go
import (
  "os"

  "github.com/theory-cloud/apptheory/v4/runtime/mcp"
  "github.com/theory-cloud/tabletheory/v3"
  "github.com/theory-cloud/tabletheory/v3/pkg/session"
)

func buildMcpServerWithDynamoSessions() (*mcp.Server, error) {
  db, err := tabletheory.NewBasic(session.Config{
    Region: os.Getenv("AWS_REGION"),
  })
  if err != nil {
    return nil, err
  }

  srv := mcp.NewServer("my-agentcore-tools", "dev",
    mcp.WithSessionStore(mcp.NewDynamoSessionStore(db)),
  )

  // Register your tools on srv.Registry() as usual...
  return srv, nil
}
```

Notes:

- If you deploy with `sessionState.enabled`, the construct sets `MCP_SESSION_TABLE` and grants read/write permissions.
- Your code still needs to choose the Dynamo-backed store (`NewDynamoSessionStore`) to actually persist sessions.

---

## Streaming progress (SSE) for long-running tools

For a session-ful streaming tool, AppTheory formats the response as SSE. The `2026-07-28` stateless shape always buffers
tool results and does not expose GET/listen/subscriptions:

- every SSE frame is `event: message`
- intermediate progress is emitted as JSON-RPC `notifications/progress`
- the final frame is the JSON-RPC response to the original `tools/call`

Important adapter note:

- True incremental SSE streaming requires a response-streaming adapter.
  AppTheory’s streaming response (`SSEStreamResponse`) is supported by the API Gateway **REST API v1** adapter (`ServeAPIGatewayProxy` via `HandleLambda`).
- The HTTP API v2 adapter cannot stream: it drains a streaming body only when the stream terminates within a bounded
  budget (4 MiB / 5 seconds) and otherwise fails closed with HTTP 500
  (`{"error":{"code":"app.internal","message":"streaming response body cannot be delivered by the HTTP API v2 adapter"}}`).
  A long-running streaming tool served through HTTP API v2 therefore receives an explicit error instead of a silent
  empty `200`.

### Implement a streaming tool

```go
_ = srv.Registry().RegisterStreamingTool(mcp.ToolDef{
  Name:        "long_task",
  Description: "Example long-running task with progress events.",
  InputSchema: json.RawMessage(`{"type":"object","properties":{"steps":{"type":"integer"}}}`),
}, func(ctx context.Context, args json.RawMessage, emit func(mcp.SSEEvent)) (*mcp.ToolResult, error) {
  // Emit progress events whenever you want.
  emit(mcp.SSEEvent{Data: map[string]any{"status": "started"}})

  // ... do work ...

  emit(mcp.SSEEvent{Data: map[string]any{"status": "done"}})
  return &mcp.ToolResult{Content: []mcp.ContentBlock{{Type: "text", Text: "ok"}}}, nil
})
```

### Call it with SSE

```bash
curl -N \
  -X POST "https://YOUR_ENDPOINT/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -H "mcp-session-id: ${MCP_SESSION_ID}" \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc":"2.0",
    "id":4,
    "method":"tools/call",
    "params":{"name":"long_task","arguments":{"steps":3}}
  }'
```

---

## Security checklist (don’t ship an open tool endpoint)

`AppTheoryMcpServer` creates a public HTTP endpoint by default. You should intentionally secure it.

Common approaches:

- **Enforce auth in your handler** (e.g., require a shared secret header or JWT verification).
- **Put the endpoint on a custom domain** and front it with CloudFront/WAF (if that matches your platform).
- **Use a private network path** if your AgentCore integration supports it.

AppTheory is a framework — if you need a different domain/auth story, wire it the way your platform requires.

---

## Testing locally (no AWS required)

Use the deterministic MCP test client:

```go
import (
  "context"
  "testing"

  mcptest "github.com/theory-cloud/apptheory/v4/testkit/mcp"
  "github.com/theory-cloud/apptheory/v4/testkit"
)

func TestMcpServer(t *testing.T) {
  env := testkit.New()
  client := mcptest.NewClient(buildMcpServer(), env)

  _, _ = client.Initialize(context.Background())

  tools, _ := client.ListTools(context.Background())
  mcptest.AssertHasTools(t, tools, "echo")

  out, _ := client.CallTool(context.Background(), "echo", map[string]any{"message": "hi"})
  _ = out
}
```

---

## Troubleshooting

These checks cover the most common deployment and protocol mismatches when AgentCore cannot call the AppTheory MCP
server successfully.

### 404 / “not found”

- Ensure the construct selects `routeFamily: { patterns: ["/mcp"] }` and the application registers
  `app.Post("/mcp", ...)`.
- If you’re not using a custom domain and your stage name is not `$default`, the URL is:
  - `https://{apiId}.execute-api.{region}.amazonaws.com/{stageName}/mcp`

### JSON-RPC “Parse error” / “Invalid request”

- `jsonrpc` must be `"2.0"`.
- `id` is required.
- for the tools-only surface, `method` must be one of `server/discover`, `initialize`, `tools/list`, or `tools/call`
- a `2026-07-28` request must include matching `Mcp-Method` and, for `tools/call`, matching `Mcp-Name`

### “tool not found”

- Confirm the tool is registered on `srv.Registry()`.
- Confirm the `params.name` matches exactly.
