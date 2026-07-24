---
title: MCP Method Surface
render_with_liquid: false
---

# MCP (Model Context Protocol) Method Surface

This document describes AppTheory's fixture-backed MCP server method surface: transport behavior, JSON-RPC methods,
registries, sessions, streaming, and test helpers. Go implementation package paths such as
`github.com/theory-cloud/apptheory/v2/runtime/mcp` are listed where operators need source-level details; TypeScript and
Python expose the matching runtime/test surfaces through their package API snapshots.

If you're specifically integrating with Bedrock AgentCore, start with `docs/integrations/agentcore-mcp.md`.

For the Claude-first Remote MCP deployment guide, see:

- `docs/integrations/remote-mcp.md`

For v1.0 fail-closed migration notes that affect MCP transport and session behavior, see:

- `docs/migration/v1-security.md`

OAuth helper surfaces used by Remote MCP deployments and Autheory are in:

- `github.com/theory-cloud/apptheory/v2/runtime/oauth`

---

## Transport + endpoint

AppTheory implements MCP Streamable HTTP on a single path:

- `POST /mcp`: JSON-RPC requests, notifications, and client responses
- `GET /mcp`: resumable SSE replay via `Last-Event-ID`, or a short-lived keepalive SSE response when `Last-Event-ID`
  is absent
- `DELETE /mcp`: session termination

Header names are case-insensitive on the wire. The examples in this doc use lowercase HTTP headers.

- Session header: `mcp-session-id`
- Protocol header: `mcp-protocol-version`
- Resume header: `last-event-id`

Important transport behavior:

- `POST /mcp` requires `content-type: application/json`
- `POST /mcp` requires `accept` support for both `application/json` and `text/event-stream`
- `GET /mcp` requires `accept` support for `text/event-stream`
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

### Strict transport compatibility rollout

Roll strict Streamable HTTP behavior out with a client canary before making it the only production path:

1. Canary clients must send `content-type: application/json` on every `POST /mcp`.
2. Canary clients must send `accept: application/json, text/event-stream` on every `POST /mcp`.
3. Canary clients must send `accept: text/event-stream` on every `GET /mcp`.
4. After initialization, clients should either omit `mcp-protocol-version` or send the exact negotiated version.
5. Streaming clients must tolerate the initial empty-data priming SSE event and store its `id` for reconnect.
6. Reconnect with `GET /mcp` plus the latest `last-event-id`; do not assume dropped TCP connections cancel work.

Compatibility risks to check during canary:

- older clients that send `Accept: application/json` only on `POST /mcp` now receive HTTP `400`
- clients that omit `Content-Type` or send non-JSON content types now receive HTTP `400`
- clients that pin a protocol header different from the negotiated session version now receive HTTP `400`
- SSE parsers that assume the first frame is JSON-RPC must skip or record the empty priming frame
- replay clients that reuse a `Last-Event-ID` from another stream now fail closed instead of receiving unrelated events

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
- `resources/subscribe`
- `resources/unsubscribe`
- `logging/setLevel`
- `completion/complete`
- `tasks/get`
- `tasks/result`
- `tasks/list`
- `tasks/cancel`
- `prompts/list`
- `prompts/get`

Accepted notification methods:

- `notifications/initialized`
- `notifications/cancelled`

Other transport notes:

- posted client responses are accepted for Streamable HTTP compliance and return `202 Accepted` with no body
- notifications also return `202 Accepted` with no body
- JSON-RPC batch requests are only supported for legacy `2025-03-26` callers; after a session is established, batch
  dispatch uses the session's negotiated protocol version when the request omits `mcp-protocol-version`

### Runtime hardening guarantees

The MCP runtime fails closed around tool execution and durable replay:

- buffered and streaming `tools/call` panics are recovered as sanitized JSON-RPC internal errors; panic values are logged
  server-side and are not returned to clients
- `DynamoSessionStore.Put` is an upsert, so sliding-session refreshes update the existing session data and TTL instead
  of failing when a session row already exists
- S3-spilled stream events are read through AppTheory's private object-store helper with bounded reads before replay
  validation; the read cap uses the recorded event byte count and the configured maximum event size before size/hash
  validation

### Capabilities advertisement (`initialize`)

The `initialize` result advertises only surfaces that are both enabled in `mcp.CapabilityConfig` and actually registered
on the server:

- if `srv.Registry().Len() > 0` and tools are enabled -> `"tools": {}`
- if `srv.Resources().Len() > 0` and resources are enabled -> `"resources": {}`
- if `srv.Prompts().Len() > 0` and prompts are enabled -> `"prompts": {}`
- if `mcp.WithCompletionHooks(...)` has at least one hook and completions are enabled -> `"completions": {}`
- if `mcp.WithTaskRuntime(...)` supplies a store, at least one registered tool declares task support, and tasks are
  enabled -> `"tasks": {...}` for protocol `2025-11-25` sessions

The default capability policy enables the implemented surfaces, but registration is still required before they are
advertised. Use `mcp.WithCapabilityConfig(...)` to withhold an implemented surface for a product rollout.

Optional MCP utility capabilities are fail-closed:

- resource subscription hooks are accepted only when both hooks are configured with
  `mcp.WithResourceSubscriptionHooks(...)`, but `resources.subscribe` is not advertised until AppTheory has a
  first-class outbound `notifications/resources/updated` contract
- `logging/setLevel` is accepted only when `mcp.WithLoggingLevelHook(...)` is configured, but `logging` is not
  advertised until AppTheory has a first-class outbound `notifications/message` contract
- `completions` is advertised only when `mcp.WithCompletionHooks(...)` has at least one prompt or resource hook
- `tasks` is advertised only when `mcp.WithTaskRuntime(...)` supplies a store and a tool explicitly opts into task
  execution
- `notifications/cancelled` is accepted for every initialized session, but it only cancels AppTheory-tracked in-flight
  requests for that session and safely ignores unknown or completed request ids
- unsupported utility surfaces such as `listChanged` remain omitted until their concrete AppTheory contract exists

Capability construction is also protocol-aware; if a future supported protocol version removes or changes a capability,
AppTheory omits that capability for sessions negotiated to that version.

Products should not advertise these optional utility capabilities outside AppTheory's initialize response and should not
enable the hooks for downstream services until product authorization, tenant policy, audit logging, and abuse controls
are wired. The single path is: configure the AppTheory hook, let AppTheory advertise only capabilities it can deliver
end-to-end, and handle the request through the hook. Do not hard-code capabilities in a product-specific wrapper.

### Task runtime

MCP task support is explicit opt-in. AppTheory does not advertise `tasks` just because a product has long-running tools.
All three conditions must hold:

1. the session negotiates protocol `2025-11-25`
2. the server is created with `mcp.WithTaskRuntime(...)` and a concrete `TaskStore`
3. at least one registered tool declares `ToolExecution.TaskSupport` as `optional` or `required`

Example:

```go
type slowReportArgs struct {
  ReportID string `json:"reportId"`
}

srv := mcp.NewServer("my-mcp-server", "dev",
  mcp.WithTaskRuntime(mcp.TaskRuntimeOptions{
    Store: mcp.NewDynamoTaskStore(db),
  }),
)

_ = srv.Registry().RegisterTool(mcp.ToolDef{
  Name:        "slow-report",
  Description: "Generate a report asynchronously.",
  Execution:   &mcp.ToolExecution{TaskSupport: mcp.TaskSupportOptional},
  InputSchema: json.RawMessage(`{
    "type":"object",
    "properties":{"reportId":{"type":"string"}},
    "required":["reportId"]
  }`),
}, mcp.WrapTool(mcp.ToolLifecycleOptions[slowReportArgs]{
  Name:       "slow-report",
  StrictJSON: true,
}, runSlowReport))
```

Tool support is fail-closed:

- `TaskSupportForbidden` (or omitted) rejects task-augmented `tools/call`
- `TaskSupportOptional` allows both synchronous and task-augmented `tools/call`
- `TaskSupportRequired` rejects synchronous `tools/call` and requires task augmentation

When a task-capable `tools/call` includes a `task` parameter, AppTheory creates a session-scoped task record, returns a
`CreateTaskResult`, and runs the tool on a background context detached from the request connection. The final tool
result or JSON-RPC error is stored in the configured `TaskStore`. Clients then use:

- `tasks/get` to inspect status
- `tasks/list` to list tasks for the current MCP session
- `tasks/result` to retrieve terminal results, with related-task metadata injected into `_meta`
- `tasks/cancel` to mark the task canceled and cancel the in-flight tool context when it is still running

Task state is always bound to the active MCP session id. A store must never broaden lookup, list, cancel, or delete
operations outside the supplied session scope. Product deployments should bind that session to the same principal,
tenant, route bundle, and entitlement policy used by their OAuth/token validation layer; missing or ambiguous policy
must withhold task capability rather than falling back to broader access.

TTL is part of the task contract. `TaskRuntimeOptions.DefaultTTL` defaults to `MCP_TASK_TTL_MINUTES` when that
environment variable is set, otherwise 10 minutes. `TaskRuntimeOptions.MaxTTL` defaults to 1 hour. Client-supplied
`task.ttl` values are milliseconds, must be positive, and fail closed when they exceed the configured maximum. DynamoDB
TTL and table cleanup are storage backstops; the runtime checks task expiry before returning stored task state.

Products should not enable or advertise task support until authorization, tenant policy, quota/rate limits, audit
logging, and abuse controls are wired for asynchronous work. If a rollout needs to provision storage before exposing
tasks, keep `WithTaskRuntime` unset or disable the `Tasks` capability in `mcp.WithCapabilityConfig(...)` until the
policy path is ready. Do not hard-code `tasks` in a wrapper around AppTheory's initialize response.

### Rate limiting stance

MCP rate limiting is product wiring over AppTheory's existing HTTP middleware and `pkg/limited` primitives. AppTheory
does not expose a separate `mcp.WithRateLimiter(...)`, task-rate limiter, or Remote MCP construct flag, because that
would create a second rate-limit path outside the normal middleware contract.

The single path is:

- validate auth and tenant/actor policy first when the limiter key depends on those claims
- mount `runtime.RateLimitMiddleware(...)` in the normal `app.Use(...)` chain that protects `POST /mcp`, `GET /mcp`,
  and `DELETE /mcp`
- back the middleware with `pkg/limited` when rate-limit state must survive Lambda concurrency and cold starts
- use `RateLimitConfig.ExtractIdentifier`, `ExtractResource`, and `ExtractOperation` to build product-specific buckets
  such as principal, tenant, actor route, JSON-RPC method, or tool name

If a product cannot derive the required principal, tenant, actor, method, or tool bucket, it should reject the request or
withhold the affected tool/task capability rather than broaden to a shared bucket. AppTheory does not advertise rate
limits in `initialize`; rate-limit policy is enforced by the HTTP middleware around the MCP handler.

### Optional utility hooks

Resource subscription hooks:

```go
srv := mcp.NewServer("my-mcp-server", "dev",
  mcp.WithResourceSubscriptionHooks(
    func(ctx context.Context, sub mcp.ResourceSubscription) error {
      // Persist session-scoped interest in sub.URI.
      return nil
    },
    func(ctx context.Context, sub mcp.ResourceSubscription) error {
      // Remove session-scoped interest in sub.URI.
      return nil
    },
  ),
)
```

`resources/subscribe` and `resources/unsubscribe` fail closed with JSON-RPC `method not found` unless both hooks are
configured. The hook receives the negotiated MCP session id and the target resource URI.

Logging hooks:

```go
srv := mcp.NewServer("my-mcp-server", "dev",
  mcp.WithLoggingLevelHook(func(ctx context.Context, req mcp.LoggingLevelRequest) error {
    // Store the per-session logging threshold.
    return nil
  }),
)
```

`logging/setLevel` validates MCP logging levels (`debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`,
`emergency`) before invoking the hook.

Completion hooks:

```go
srv := mcp.NewServer("my-mcp-server", "dev",
  mcp.WithCompletionHooks(
    func(ctx context.Context, req mcp.CompletionRequest) (*mcp.CompletionResult, error) {
      return &mcp.CompletionResult{
        Completion: mcp.Completion{Values: []string{"python"}},
      }, nil
    },
    nil,
  ),
)
```

`completion/complete` routes prompt references to the first hook and resource references to the second hook. If a
specific reference type has no configured hook, AppTheory returns JSON-RPC invalid params instead of broadening to a
fallback hook.

---

## Tools

Register tools on the tool registry. Production tools should use the lifecycle wrapper and then register the wrapped
handler; the wrapper is not a second registry or dispatcher.

```go
type echoArgs struct {
  Message string `json:"message"`
}

_ = srv.Registry().RegisterTool(mcp.ToolDef{
  Name:        "echo",
  Description: "Echo back the provided message.",
  InputSchema: json.RawMessage(`{
    "type":"object",
    "properties": { "message": { "type":"string" } },
    "required": ["message"]
  }`),
}, mcp.WrapTool(mcp.ToolLifecycleOptions[echoArgs]{
  Name:       "echo",
  StrictJSON: true,
  Validate: func(ctx context.Context, in echoArgs) error {
    if strings.TrimSpace(in.Message) == "" {
      return errors.New("message is required")
    }
    return nil
  },
}, func(ctx context.Context, in echoArgs) (*mcp.ToolResult, error) {
  return &mcp.ToolResult{
    Content: []mcp.ContentBlock{{Type: "text", Text: in.Message}},
  }, nil
}))
```

### Tool lifecycle wrapper

`mcp.WrapTool[Args]` and `mcp.WrapStreamingTool[Args]` are the blessed lifecycle adapters for product MCP tools. They
compose over `RegisterTool` and `RegisterStreamingTool`; buffered JSON calls, Streamable HTTP SSE calls, and task
execution still route through `ToolRegistry.Call` / `ToolRegistry.CallStreaming`.

Use `mcp.ToolLifecycleOptions[Args]` to keep lifecycle behavior in one place:

- `Name`: safe tool name used in lifecycle telemetry
- `NoArgs`: accepts omitted, `null`, or `{}` arguments and rejects extra fields
- `StrictJSON`: rejects unknown fields and trailing JSON values for typed tool arguments
- `Validate`: maps validation failures to JSON-RPC invalid params with a sanitized message
- `HandleError`: maps expected product errors to a safe `ToolResult{IsError:true}` when appropriate
- `Timeout`: derives a per-tool context timeout and maps deadline expiry to AppTheory's existing safe timeout error
- `Telemetry`: emits start/finish hooks with name, timestamps, duration, outcome, JSON-RPC code, and `isError` status
- `Clock`: supplies deterministic time for telemetry tests

Telemetry payloads intentionally exclude raw arguments, bearer tokens, raw unhandled errors, and panic values. Validation
and no-arg failures return JSON-RPC `CodeInvalidParams`; unhandled errors and panics return sanitized internal errors.
Handled product failures should be converted to safe tool results through `HandleError`.

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

Strict Streamable HTTP clients send `Accept: application/json, text/event-stream` on every `POST /mcp`.
AppTheory still returns SSE only for a `tools/call` targeting a tool registered with `RegisterStreamingTool`;
ordinary tools return buffered JSON even though the client advertises SSE support.

For streaming tools, AppTheory responds as SSE:

- the first frame is a replay priming event with an `id` and an empty `data:` field
- after the priming event, each application frame is `event: message`
- application frame `data:` values are always a single JSON-RPC message
- progress is emitted as JSON-RPC `notifications/progress`
- the progress notification is correlated with `params._meta.progressToken` from the original `tools/call`
- `progressToken` may be a string or an integer

Register a streaming tool with `RegisterStreamingTool`:

```go
type longTaskArgs struct {
  Steps int `json:"steps"`
}

_ = srv.Registry().RegisterStreamingTool(mcp.ToolDef{
  Name:        "long_task",
  Description: "Example long-running task with progress.",
  InputSchema: json.RawMessage(`{"type":"object"}`),
}, mcp.WrapStreamingTool(mcp.ToolLifecycleOptions[longTaskArgs]{
  Name:       "long_task",
  StrictJSON: true,
}, func(ctx context.Context, args longTaskArgs, emit func(mcp.SSEEvent)) (*mcp.ToolResult, error) {
  emit(mcp.SSEEvent{Data: map[string]any{"progress": 1, "total": 10, "message": "started"}})
  // ... do work ...
  emit(mcp.SSEEvent{Data: map[string]any{"progress": 10, "total": 10, "message": "done"}})
  return &mcp.ToolResult{Content: []mcp.ContentBlock{{Type: "text", Text: "ok"}}}, nil
}))
```

Important deployment note:

- true incremental SSE delivery requires a response-streaming adapter
- AppTheory's `SSEStreamResponse` is supported by the API Gateway REST API v1 adapter (`ServeAPIGatewayProxy` via
  `HandleLambda`)
- if you're behind an adapter that buffers responses, clients may receive progress only after completion

### Resumability

For streaming tool calls, AppTheory assigns SSE event ids and persists them in the active `StreamStore`.

- each SSE stream starts with a persisted empty-data priming event so a client can reconnect before any JSON-RPC
  progress or result message has been produced
- `GET /mcp` with `last-event-id: <id>` resumes or replays that stream
- `last-event-id` must belong to the stream being resumed; AppTheory fails closed instead of replaying events from a
  different stream
- clients must reuse the same `mcp-session-id`
- clients should store the latest SSE `id`, reconnect with `GET /mcp` and `last-event-id` after any disconnect, and
  treat disconnect as transport loss rather than tool cancellation
- cancellation remains explicit: send `notifications/cancelled` instead of relying on a dropped connection
- `GET /mcp` without `last-event-id` emits one keepalive comment and closes by default so idle callers do not hold
  Lambda concurrency indefinitely
- if you want that path to stay open for a bounded window before EOF, opt in with
  `WithInitialSessionListenerBudget(...)`

### Keeping the initial keepalive path open for a bounded window on Lambda

If you want that initial `GET /mcp` keepalive path to stay open for a bounded window before the Lambda deadline, opt in
explicitly:

```go
srv := mcp.NewServer("my-mcp-server", "dev",
  mcp.WithInitialSessionListenerBudget(mcp.InitialSessionListenerBudgetOptions{
    SafetyBuffer: 5 * time.Second,
    MaxDuration:  25 * time.Second,
  }),
)
```

Important scope notes:

- this is explicit opt-in; without the option, AppTheory emits one keepalive comment and closes
- it applies only to `GET /mcp` without `last-event-id`
- replay/resume `GET /mcp` requests with `last-event-id` keep their existing behavior
- when Lambda `RemainingMS` is available, AppTheory subtracts `SafetyBuffer` from the remaining time and caps the
  listener with `MaxDuration`
- when `RemainingMS` is unavailable, the configured budget does not cap the listener; use this option only on
  Lambda-backed deployments where `RemainingMS` is available
- early termination simply ends the listener; AppTheory does not emit a special final SSE event or comment

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

- default stream store: in-memory
- persistent stream replay: `mcp.WithStreamStore(mcp.NewDynamoStreamStore(db))`
- default Dynamo table name: `MCP_STREAM_TABLE` when set, otherwise `mcp-streams`
- stream/event retention is controlled by `MCP_STREAM_TTL_MINUTES` (default `60`); event records get per-append TTLs
  and stream metadata is refreshed on create, append, and close so replay state survives reconnects within the
  configured retention window
- `MCP_STREAM_TTL_MINUTES` is the runtime replay window. `DynamoStreamStore` treats event records with
  `expiresAt <= now` as unreplayable even if DynamoDB TTL has not physically removed the item yet.
- large logical stream events use the same MCP client contract: when `MCP_STREAM_SPILL_BUCKET` is set, events larger
  than `MCP_STREAM_SPILL_INLINE_MAX_BYTES` (default `32768`, clamped to the DynamoDB-safe inline ceiling of `358400`)
  are stored as S3-managed encrypted private S3 objects through AppTheory's object-store helper while DynamoDB keeps the
  logical event id, stream id, object pointer, byte count, and SHA-256 hash; replay rehydrates the payload before
  emitting the same JSON-RPC SSE message
- S3 lifecycle expiration is a best-effort cleanup backstop for spilled payload objects, not minute-level replay access
  enforcement; the runtime enforces replay access from the DynamoDB `expiresAt` value before reading inline or spilled
  event data.
- `DynamoStreamStore` gets its strongest `DeleteSession`/`Append` race protection from a TableTheory DB that implements
  `TransactWrite`; the standard production TableTheory DB provides that path. Test doubles or custom `tablecore.DB`
  implementations without `TransactWrite` still get active-session guards, but they cannot make the final event create
  atomic with session deletion.
- `MCP_STREAM_MAX_EVENT_BYTES` (default `10485760`) is the hard maximum for one logical stream event. Events over that
  limit fail closed with a stable JSON-RPC stream delivery error instead of timing out after a failed append.
- the CDK Remote MCP stream table only provisions storage and env vars; the application still must wire
  `mcp.WithStreamStore(...)`

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
