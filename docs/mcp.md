# MCP (Model Context Protocol) Server (Go runtime)

This document describes AppTheory’s **MCP server implementation** (`github.com/theory-cloud/apptheory/runtime/mcp`) — the JSON-RPC method surface, registries, payload shapes, sessions, and streaming behavior.

If you’re specifically integrating with **Bedrock AgentCore**, start with `docs/agentcore-mcp.md` (it focuses on what to deploy and how AgentCore calls tools).

For the Claude-first Remote MCP roadmap (Streamable HTTP + OAuth/DCR), see:
- `docs/remote-mcp.md` (implementation guide) and `docs/development/planning/apptheory/remote-mcp/README.md` (roadmap + contract)

OAuth helper surfaces used by Remote MCP deployments and Autheory are in:
- `github.com/theory-cloud/apptheory/runtime/oauth`

---

## Transport + endpoint

AppTheory’s MCP server implements **MCP Streamable HTTP** on a single endpoint path:

- `POST /mcp`
- `GET /mcp` (resume/replay via `Last-Event-ID`)
- `DELETE /mcp` (terminate session)

- Request body: JSON-RPC `{ "jsonrpc": "2.0", "id": ..., "method": "...", "params": { ... } }`
- Session header: `Mcp-Session-Id` (issued by the server on `initialize`)
- Protocol header: `MCP-Protocol-Version` (required after initialization)

It is not a stdio transport — you mount it on AppTheory routes:

```go
srv := mcp.NewServer("my-mcp-server", "dev")

app := apptheory.New()
h := srv.Handler()
app.Post("/mcp", h)
app.Get("/mcp", h)
app.Delete("/mcp", h)
```

Supported protocol versions (negotiated on `initialize`): `2025-11-25` (latest), `2025-06-18`, `2025-03-26` (legacy).

---

## Supported JSON-RPC methods

AppTheory currently dispatches these MCP JSON-RPC methods:

- `initialize`
- `tools/list`
- `tools/call`
- `resources/list`
- `resources/read`
- `prompts/list`
- `prompts/get`

### Capabilities advertisement (`initialize`)

The `initialize` result always advertises `tools`.

It advertises `resources` and `prompts` **only when something is registered**:

- if `srv.Resources().Len() > 0` → `"resources": {}`
- if `srv.Prompts().Len() > 0` → `"prompts": {}`

This keeps “tools-only” clients stable while still exposing the full MCP surface when you opt in.

---

## Tools

Register tools on the tool registry:

```go
_ = srv.Registry().RegisterTool(mcp.ToolDef{
  Name:        "echo",
  Description: "Echo back the provided message.",
  InputSchema: json.RawMessage(`{
    "type":"object",
    "properties": { "message": { "type":"string" } },
    "required": ["message"]
  }`),
}, func(ctx context.Context, args json.RawMessage) (*mcp.ToolResult, error) {
  var in struct{ Message string `json:"message"` }
  if err := json.Unmarshal(args, &in); err != nil {
    return nil, err
  }
  return &mcp.ToolResult{
    Content: []mcp.ContentBlock{{Type: "text", Text: in.Message}},
  }, nil
})
```

### Tool results: `ContentBlock` shapes

Tool results return `content: []ContentBlock` where each content block is one of:

- **Text**: `{ "type": "text", "text": "..." }`
- **Image**: `{ "type": "image", "data": "<base64>", "mimeType": "image/png" }`
- **Audio**: `{ "type": "audio", "data": "<base64>", "mimeType": "audio/wav" }`
- **Resource link**: `{ "type": "resource_link", "uri": "file://...", "name": "..." }`
- **Embedded resource**:
  `{ "type": "resource", "resource": { "uri": "file://...", "text": "..." } }`

If you want to include structured output in addition to the `content` blocks, set:

- `ToolResult.StructuredContent` (encoded into `structuredContent`)

### Streaming tool progress (SSE)

If the client includes `Accept: text/event-stream` on a `tools/call`, AppTheory may format the response as SSE:

- Every server message is delivered as an SSE event:
  - `event: message`
  - `data: <single JSON-RPC message>`
- Progress is delivered as JSON-RPC notifications:
  - `method: "notifications/progress"`
  - correlated via `params._meta.progressToken` from the original request

Register a streaming tool with `RegisterStreamingTool`:

```go
_ = srv.Registry().RegisterStreamingTool(mcp.ToolDef{
  Name:        "long_task",
  Description: "Example long-running task with progress.",
  InputSchema: json.RawMessage(`{"type":"object"}`),
}, func(ctx context.Context, args json.RawMessage, emit func(mcp.SSEEvent)) (*mcp.ToolResult, error) {
  emit(mcp.SSEEvent{Data: map[string]any{"progress": 1, "total": 10, "message": "started"}})
  // ... do work ...
  emit(mcp.SSEEvent{Data: map[string]any{"progress": 10, "total": 10, "message": "done"}})
  return &mcp.ToolResult{Content: []mcp.ContentBlock{{Type: "text", Text: "ok"}}}, nil
})
```

Important deployment note:

- **True incremental SSE streaming requires a response-streaming adapter**.
  AppTheory’s `SSEStreamResponse` is supported by the API Gateway **REST API v1** adapter (`ServeAPIGatewayProxy` via `HandleLambda`).
  If you’re behind an adapter that buffers (common with HTTP API v2), clients may receive progress only after completion.

### Resumability (GET + `Last-Event-ID`)

For streaming tool calls, the server includes `id: <id>` on SSE events.

If the client disconnects, it can resume by calling:

- `GET /mcp` with `Last-Event-ID: <id>`
- plus the same `Mcp-Session-Id` (and usually `MCP-Protocol-Version`)

---

## Resources

Resources are “things the server can read” by URI.

Register resources on the resource registry:

```go
_ = srv.Resources().RegisterResource(mcp.ResourceDef{
  URI:      "file://hello.txt",
  Name:     "hello",
  MimeType: "text/plain",
}, func(ctx context.Context) ([]mcp.ResourceContent, error) {
  return []mcp.ResourceContent{
    {URI: "file://hello.txt", MimeType: "text/plain", Text: "hello world"},
  }, nil
})
```

Handlers return one or more `ResourceContent` items:

- Text content: `{ "uri": "...", "text": "..." }`
- Binary content: `{ "uri": "...", "blob": "<base64>" }`
- Optional: `mimeType`

Supported methods:

- `resources/list` → `{ "resources": []ResourceDef }`
- `resources/read` → `{ "contents": []ResourceContent }`

---

## Prompts

Prompts are named templates that return a sequence of messages for the client/LLM.

Register prompts on the prompt registry:

```go
_ = srv.Prompts().RegisterPrompt(mcp.PromptDef{
  Name:        "greet",
  Description: "Return a greeting message.",
  Arguments: []mcp.PromptArgument{
    {Name: "name", Required: true},
  },
}, func(ctx context.Context, args json.RawMessage) (*mcp.PromptResult, error) {
  var in struct{ Name string `json:"name"` }
  _ = json.Unmarshal(args, &in)
  return &mcp.PromptResult{
    Messages: []mcp.PromptMessage{
      {Role: "user", Content: mcp.ContentBlock{Type: "text", Text: "hello " + in.Name}},
    },
  }, nil
})
```

Supported methods:

- `prompts/list` → `{ "prompts": []PromptDef }`
- `prompts/get` → `PromptResult` (`{ "description": "...", "messages": [...] }`)

---

## Sessions

Sessions are tracked via the `Mcp-Session-Id` HTTP header:

- The server issues a session id on the **`initialize`** HTTP response.
- After initialization, clients must send:
  - `Mcp-Session-Id: ...`
  - `MCP-Protocol-Version: 2025-06-18` (or `2025-03-26` for legacy/batch compatibility)
- TTL is controlled by `MCP_SESSION_TTL_MINUTES` (default: `60`).

The default store is in-memory. For persistent storage across cold starts, use the Dynamo-backed store (see `docs/agentcore-mcp.md`).

---

## Local testing (no AWS required)

Use the deterministic testkit client in `testkit/mcp`:

```go
env := testkit.New()
client := mcptest.NewClient(buildMcpServer(), env)

_, _ = client.Initialize(context.Background())

tools, _ := client.ListTools(context.Background())
_ = tools
```

For Streamable HTTP SSE streaming, use:
- `Client.RawStream(...)` (POST stream)
- `Client.ResumeStream(...)` (GET replay/resume with `Last-Event-ID`)
