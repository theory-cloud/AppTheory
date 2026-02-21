# Bedrock AgentCore + AppTheory (MCP Gateway)

This guide explains how to expose an **MCP (Model Context Protocol)** server from an AppTheory Lambda so **Bedrock AgentCore** can call your tools.

AppTheory provides two building blocks:

- **Runtime (Go):** `github.com/theory-cloud/apptheory/runtime/mcp` — an MCP JSON-RPC handler (`initialize`, `tools/*`, plus optional `resources/*` and `prompts/*`), registries, sessions, and optional SSE progress streaming.
- **CDK (TypeScript/Python):** `AppTheoryMcpServer` — an API Gateway v2 HTTP API with `POST /mcp` → Lambda, optional session table, optional custom domain, and optional stage logging/throttling.

For the full MCP method surface (including `resources/*` and `prompts/*`), see `docs/mcp.md`.

If you’re trying to answer “what do I deploy and what code do I write?”, start with **Quick Start** below.

---

## What you deploy (high level)

```
Bedrock AgentCore  ──HTTP POST /mcp──>  API Gateway (HTTP API)  ──>  Lambda (Go)
                                                              └──>  AppTheory route POST /mcp
                                                                   └──> MCP server (tools registry)
```

Key details:

- The MCP endpoint is **`POST /mcp`**.
- The payload is **JSON-RPC 2.0** (`jsonrpc: "2.0"`) with an `id`, `method`, and optional `params`.
- Session state is tracked via the **`mcp-session-id`** header (server issues one if you don’t send it).
- MCP errors are returned as JSON-RPC errors (HTTP status is still `200`).

---

## Quick start (Go runtime)

Deploy an HTTP API with `POST /mcp` and point AgentCore at the resulting `/mcp` URL.

```go
package main

import (
  "context"
  "encoding/json"
  "fmt"
  "os"

  "github.com/aws/aws-lambda-go/events"
  "github.com/aws/aws-lambda-go/lambda"

  apptheory "github.com/theory-cloud/apptheory/runtime"
  "github.com/theory-cloud/apptheory/runtime/mcp"
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

Use the CDK construct to provision the HTTP API + `POST /mcp` route + optional session table and domain.

See: `cdk/docs/mcp-server-agentcore.md`.

---

## MCP protocol surface (what AgentCore calls)

AppTheory’s MCP server implements these JSON-RPC methods:

- `initialize`
- `tools/list`
- `tools/call`

AgentCore typically uses only the tools surface. AppTheory also supports additional MCP methods for non-AgentCore clients (`resources/*`, `prompts/*`) — see `docs/mcp.md`.

### Example: initialize

```bash
curl -sS -i \
  -X POST "https://YOUR_ENDPOINT/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

- The response includes a `mcp-session-id` header.
- Send that header on subsequent calls to keep a session.

### Example: list tools

```bash
curl -sS \
  -X POST "https://YOUR_ENDPOINT/mcp" \
  -H 'content-type: application/json' \
  -H "mcp-session-id: ${MCP_SESSION_ID}" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

### Example: call a tool

```bash
curl -sS \
  -X POST "https://YOUR_ENDPOINT/mcp" \
  -H 'content-type: application/json' \
  -H "mcp-session-id: ${MCP_SESSION_ID}" \
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

---

## Sessions (stateless HTTP with a session header)

MCP calls are plain HTTP requests. AppTheory adds a lightweight session mechanism:

- Clients send **`mcp-session-id`**.
- If missing/unknown/expired, the server issues a new session ID and returns it in the response headers.
- TTL is controlled by `MCP_SESSION_TTL_MINUTES` (default: `60` minutes).

### Persistence options

By default, sessions are stored in-memory (fine for local/dev; not shared across cold starts).

For persistent session storage, use the DynamoDB-backed store:

```go
import (
  "os"

  "github.com/theory-cloud/tabletheory"
  "github.com/theory-cloud/tabletheory/pkg/session"
  "github.com/theory-cloud/apptheory/runtime/mcp"
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

- If you deploy the CDK `enableSessionTable` option, the construct sets `MCP_SESSION_TABLE` and grants read/write permissions.
- Your code still needs to choose the Dynamo-backed store (`NewDynamoSessionStore`) to actually persist sessions.

---

## Streaming progress (SSE) for long-running tools

If the client sets `Accept: text/event-stream` on a `tools/call`, AppTheory formats the response as SSE:

- `event: progress` for intermediate events emitted by your tool
- `event: message` for the final JSON-RPC response

Important adapter note:

- True incremental SSE streaming requires a response-streaming adapter.
  AppTheory’s streaming response (`SSEStreamResponse`) is supported by the API Gateway **REST API v1** adapter (`ServeAPIGatewayProxy` via `HandleLambda`).
  If you deploy behind an adapter that buffers (common with HTTP API v2), clients may only receive progress once the tool finishes.

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

  mcptest "github.com/theory-cloud/apptheory/testkit/mcp"
  "github.com/theory-cloud/apptheory/testkit"
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

### 404 / “not found”

- Ensure the deployed route is **`POST /mcp`**.
- If you’re not using a custom domain and your stage name is not `$default`, the URL is:
  - `https://{apiId}.execute-api.{region}.amazonaws.com/{stageName}/mcp`

### JSON-RPC “Parse error” / “Invalid request”

- `jsonrpc` must be `"2.0"`.
- `id` is required.
- `method` must be one of `initialize`, `tools/list`, `tools/call`.

### “tool not found”

- Confirm the tool is registered on `srv.Registry()`.
- Confirm the `params.name` matches exactly.
