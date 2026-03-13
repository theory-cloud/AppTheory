# MCP (Model Context Protocol) Server (Go runtime)

This document describes AppTheory's MCP server implementation (`github.com/theory-cloud/apptheory/runtime/mcp`) for
the Go runtime: transport behavior, JSON-RPC surface, registries, sessions, streaming, and test helpers.

If you're specifically integrating with Bedrock AgentCore, start with `docs/agentcore-mcp.md`.

For the Claude-first Remote MCP deployment guide, see:

- `docs/remote-mcp.md`

OAuth helper surfaces used by Remote MCP deployments and Autheory are in:

- `github.com/theory-cloud/apptheory/runtime/oauth`

---

## Transport + endpoint

AppTheory implements MCP Streamable HTTP on a single path:

- `POST /mcp`: JSON-RPC requests, notifications, and client responses
- `GET /mcp`: resumable SSE replay via `Last-Event-ID`, or a keepalive listener when `Last-Event-ID` is absent
- `DELETE /mcp`: session termination

Header names are case-insensitive on the wire. The examples in this doc use lowercase HTTP headers.

- Session header: `mcp-session-id`
- Protocol header: `mcp-protocol-version`
- Resume header: `last-event-id`

Important transport behavior:

- `initialize` is the only request that creates a session and returns `mcp-session-id`
- subsequent `POST /mcp`, `GET /mcp`, and `DELETE /mcp` calls require `mcp-session-id`
- missing session header returns `400`
- unknown or expired sessions return `404`
- `mcp-protocol-version` is optional after initialization; when present it must be supported and must match the
  session's negotiated protocol version
- JSON-RPC success and error payloads return HTTP `200`; transport-level failures such as missing sessions, bad
  protocol headers, rejected origins, or missing replay events return HTTP `4xx` / `5xx`

Supported protocol versions negotiated on `initialize`:

- `2025-11-25` (latest)
- `2025-06-18`
- `2025-03-26` (legacy compatibility / batch mode)

If the client requests an unsupported protocol version during `initialize`, AppTheory counter-proposes the latest
supported version instead of failing the request.

If a request includes an `Origin` header, AppTheory validates it fail-closed. The default allowlist is:

- `https://claude.ai`
- `https://claude.com`

Use `mcp.WithOriginValidator(...)` to replace that policy for other browser-based callers.

Mounting the handler is still just normal AppTheory routing:

```go
srv := mcp.NewServer("my-mcp-server", "dev")

app := apptheory.New()
h := srv.Handler()
app.Post("/mcp", h)
app.Get("/mcp", h)
app.Delete("/mcp", h)
```

---

## Supported JSON-RPC surface

AppTheory currently dispatches these MCP request methods:

- `initialize`
- `ping`
- `tools/list`
- `tools/call`
- `resources/list`
- `resources/read`
- `prompts/list`
- `prompts/get`

Accepted notification methods:

- `notifications/initialized`
- `notifications/cancelled`

Other transport notes:

- posted client responses are accepted for Streamable HTTP compliance and return `202 Accepted` with no body
- notifications also return `202 Accepted` with no body
- JSON-RPC batch requests are only supported for legacy `2025-03-26` callers

### Capabilities advertisement (`initialize`)

The `initialize` result always advertises `tools`.

It advertises `resources` and `prompts` only when something is registered:

- if `srv.Resources().Len() > 0` -> `"resources": {}`
- if `srv.Prompts().Len() > 0` -> `"prompts": {}`

This keeps tools-only clients stable while still exposing the broader MCP surface when you opt in.

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

`ToolDef` exposes more than the minimal name + schema shape:

- required: `Name`, `InputSchema`
- optional: `Title`, `Description`, `OutputSchema`
- optional annotations: `Title`, `ReadOnlyHint`, `DestructiveHint`, `IdempotentHint`, `OpenWorldHint`
- optional icons: `Src`, `MimeType`, `Sizes`, `Theme`
- optional execution metadata: `TaskSupport` (`"forbidden"`, `"optional"`, `"required"`)

### Tool results

`ToolResult` supports:

- `Content`: ordered `[]ContentBlock`
- `StructuredContent`: serialized as `structuredContent`
- `IsError`: serialized as `isError`

`ContentBlock` shapes:

- text: `{ "type": "text", "text": "..." }`
- image: `{ "type": "image", "data": "<base64>", "mimeType": "image/png" }`
- audio: `{ "type": "audio", "data": "<base64>", "mimeType": "audio/wav" }`
- resource link:
  `{ "type": "resource_link", "uri": "file://...", "name": "...", "title": "...", "description": "...", "size": 123 }`
- embedded resource:
  `{ "type": "resource", "resource": { "uri": "file://...", "text": "...", "mimeType": "text/plain" } }`

### Streaming tool progress (SSE)

If the client includes `Accept: text/event-stream` on `tools/call`, AppTheory may respond as SSE:

- every SSE frame is `event: message`
- the frame `data:` is always a single JSON-RPC message
- progress is emitted as JSON-RPC `notifications/progress`
- the progress notification is correlated with `params._meta.progressToken` from the original `tools/call`
- `progressToken` may be a string or an integer

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

- true incremental SSE delivery requires a response-streaming adapter
- AppTheory's `SSEStreamResponse` is supported by the API Gateway REST API v1 adapter (`ServeAPIGatewayProxy` via
  `HandleLambda`)
- if you're behind an adapter that buffers responses, clients may receive progress only after completion

### Resumability

For streaming tool calls, AppTheory assigns SSE event ids and persists them in the active `StreamStore`.

- `GET /mcp` with `last-event-id: <id>` resumes or replays that stream
- clients must reuse the same `mcp-session-id`
- `GET /mcp` without `last-event-id` opens a session listener that stays alive with keepalive comments so reconnecting
  clients do not hit immediate EOF loops

---

## Resources

Resources are URI-addressable things the server can read.

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

`ResourceDef` fields:

- required: `URI`, `Name`
- optional: `Title`, `Description`, `MimeType`, `Size`

`ResourceContent` fields:

- required: `URI`
- optional: `MimeType`
- exactly one of `Text` or `Blob`
- `Blob` is expected to be base64-encoded content

Supported methods:

- `resources/list` -> `{ "resources": []ResourceDef }`
- `resources/read` -> `{ "contents": []ResourceContent }`

---

## Prompts

Prompts are named templates that return a sequence of messages for the client or LLM.

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

`PromptDef` fields:

- `Name`, `Title`, `Description`
- `Arguments` as `[]PromptArgument`

`PromptArgument` fields:

- `Name`
- optional `Title`, `Description`
- optional `Required`

`PromptResult` fields:

- optional `Description`
- required `Messages`

Supported methods:

- `prompts/list` -> `{ "prompts": []PromptDef }`
- `prompts/get` -> `PromptResult`

---

## Sessions + persistence

Sessions are tracked with the `mcp-session-id` header.

- `initialize` creates the session and returns `mcp-session-id` on the HTTP response
- session TTL is controlled by `MCP_SESSION_TTL_MINUTES` (default `60`)
- session TTL is refreshed on access (sliding window)
- `notifications/initialized` persists an `"initialized": "true"` marker in the session data
- `DELETE /mcp` returns `202 Accepted` and deletes the session plus best-effort stream state for that session

Persistence options:

- default session store: in-memory
- persistent sessions: `mcp.WithSessionStore(mcp.NewDynamoSessionStore(db))`
- default Dynamo table name: `MCP_SESSION_TABLE` when set, otherwise `mcp-sessions`

Stream persistence note:

- the built-in runtime ships `MemoryStreamStore`
- durable replay across cold starts requires your own `StreamStore` wired with `mcp.WithStreamStore(...)`
- the CDK Remote MCP stream table is infrastructure only until the application provides a matching `StreamStore`

---

## Local testing (no AWS required)

Use the deterministic `testkit/mcp` client for in-process tests:

```go
env := testkit.New()
client := mcptest.NewClient(buildMcpServer(), env)

_, _ = client.Initialize(context.Background())

tools, _ := client.ListTools(context.Background())
_ = tools
```

High-level helpers on `Client`:

- `Initialize`
- `ListTools`
- `CallTool`
- `ListResources`
- `ReadResource`
- `ListPrompts`
- `GetPrompt`
- `Raw`
- `RawStream`
- `ResumeStream`

Low-level JSON-RPC request builders:

- `InitializeRequest`
- `ListToolsRequest`
- `CallToolRequest`
- `ListResourcesRequest`
- `ReadResourceRequest`
- `ListPromptsRequest`
- `GetPromptRequest`

SSE helpers and assertions:

- `Stream.Response`
- `Stream.Cancel`
- `Stream.Next`
- `Stream.ReadAll`
- `ReadSSEMessage`
- `AssertError`
- `AssertHasTools`
- `AssertToolResult`

Use `Stream.Response()` to assert the initial HTTP status, headers, and negotiated `mcp-session-id`.
Use `Stream.Cancel()` to simulate a client disconnect before calling `ResumeStream(...)`.
