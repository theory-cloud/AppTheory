# Issue 144 AppTheory MCP runtime prerequisites — enumerated changes

Source: mcpserver email `delivery-6058382f37ef3134`, AppTheory reply `delivery-bffbdb45430b008b`, and theory-mcp-server issue #144 audit enumeration.

Scope: AppTheory-owned framework/runtime prerequisites only. Product-specific wiring for theory-mcp-server rate limiting, auditing, tool enablement, and dependency bump remains outside this AppTheory change list.

## Enumerated changes

### 1. Recover non-streaming tool panics

- **Paths**: `runtime/mcp/server.go`, `runtime/mcp/tool.go`, `runtime/mcp/*_test.go`
- **Runtime scope**: go
- **Contract impact**: public MCP behavior; Go runtime tests are the executable contract for `runtime/mcp`
- **Acceptance**: A panic from a buffered/non-streaming `tools/call` handler returns a sanitized JSON-RPC internal error, does not leak panic text, and leaves the server reusable.
- **Validation**: `go test ./runtime/mcp`
- **Conventional Commit subject**: `fix(mcp): recover non-streaming tool panics`

### 2. Upsert Dynamo-backed MCP sessions on Put

- **Paths**: `runtime/mcp/session_dynamo.go`, `runtime/mcp/session_dynamo_test.go`, `docs/integrations/mcp.md`, `docs/integrations/remote-mcp.md`
- **Runtime scope**: go
- **Contract impact**: public MCP session-store behavior; Go runtime tests
- **Acceptance**: `DynamoSessionStore.Put` overwrites/upserts an existing session and refreshes TTL without failing the server's sliding-session access path.
- **Validation**: `go test ./runtime/mcp`
- **Conventional Commit subject**: `fix(mcp): upsert dynamo sessions`

### 3. Bound S3 stream-spill reads

- **Paths**: `runtime/mcp/stream_store_dynamo_spill.go`, `runtime/mcp/stream_store_dynamo.go`, `runtime/mcp/stream_store_dynamo_test.go`, `docs/integrations/mcp.md`, `docs/integrations/remote-mcp.md`
- **Runtime scope**: go
- **Contract impact**: public MCP stream-store behavior; Go runtime tests
- **Acceptance**: S3-spilled stream events are read through a bounded reader using record metadata and configured maximum event bytes before size/hash validation.
- **Validation**: `go test ./runtime/mcp`
- **Conventional Commit subject**: `fix(mcp): bound stream spill reads`

### 4. Add MCP hardening release guidance

- **Paths**: `docs/integrations/mcp.md`, `docs/integrations/remote-mcp.md`, `docs/core-patterns.md`, `cdk/docs/mcp-server-remote-mcp.md`
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: Documentation calls out panic recovery, Dynamo session upsert/TTL semantics, and bounded spill reads as the expected AppTheory runtime behavior.
- **Validation**: `./scripts/verify-docs-standard.sh`
- **Conventional Commit subject**: `docs(mcp): document runtime hardening guarantees`

### 5. Add explicit MCP capability configuration

- **Paths**: `runtime/mcp/server.go`, `runtime/mcp/tool.go`, `runtime/mcp/resource.go`, `runtime/mcp/prompt.go`, `runtime/mcp/*_test.go`, `api-snapshots/go.txt`
- **Runtime scope**: go
- **Contract impact**: exported Go MCP API plus public initialize result behavior; api-snapshot-update
- **Acceptance**: Server capability declarations are driven by explicit runtime configuration and actual registered surfaces, with no default `listChanged`, `tasks`, `logging`, `completions`, or resource subscription overclaim.
- **Validation**: `go test ./runtime/mcp && ./scripts/update-api-snapshots.sh && ./scripts/verify-api-snapshots.sh`
- **Conventional Commit subject**: `feat(mcp): add explicit capability configuration`

### 6. Gate MCP capabilities by negotiated protocol version

- **Paths**: `runtime/mcp/server.go`, `runtime/mcp/*_test.go`, `docs/integrations/mcp.md`, `api-snapshots/go.txt` if public helpers move
- **Runtime scope**: go
- **Contract impact**: public MCP initialize and dispatch behavior; api-snapshot-update if exported helpers are added
- **Acceptance**: Initialize responses and subsequent dispatch respect the negotiated protocol version, advertising and accepting only capabilities valid for that version.
- **Validation**: `go test ./runtime/mcp && ./scripts/verify-api-snapshots.sh`
- **Conventional Commit subject**: `feat(mcp): gate capabilities by protocol version`

### 7. Enforce Streamable HTTP request headers

- **Paths**: `runtime/mcp/server.go`, `runtime/mcp/server_property_test.go`, `runtime/mcp/*_test.go`, `docs/integrations/mcp.md`
- **Runtime scope**: go
- **Contract impact**: public MCP transport behavior; Go runtime tests
- **Acceptance**: POST requests enforce JSON content type and required Accept support, GET requests enforce `text/event-stream` Accept support, and unsupported or mismatched protocol-version headers fail with controlled HTTP errors.
- **Validation**: `go test ./runtime/mcp`
- **Conventional Commit subject**: `fix(mcp): enforce streamable http headers`

### 8. Prime and replay Streamable HTTP SSE streams correctly

- **Paths**: `runtime/mcp/server.go`, `runtime/mcp/stream_store.go`, `runtime/mcp/stream_store_dynamo.go`, `runtime/mcp/streaming_test.go`, `runtime/mcp/stream_store_dynamo_test.go`, `docs/integrations/mcp.md`
- **Runtime scope**: go
- **Contract impact**: public MCP transport/resumability behavior; Go runtime tests
- **Acceptance**: SSE responses begin with a replay-safe event ID and empty data field where required, reconnect guidance is explicit, and Last-Event-ID replay never emits events from a different stream.
- **Validation**: `go test ./runtime/mcp`
- **Conventional Commit subject**: `fix(mcp): prime streamable http replay`

### 9. Document strict transport compatibility rollout

- **Paths**: `docs/integrations/mcp.md`, `docs/integrations/remote-mcp.md`, `docs/cdk/mcp-server-remote-mcp.md`, `cdk/docs/mcp-server-remote-mcp.md`
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: Documentation gives client canary guidance and names the compatibility risks for stricter Accept, Content-Type, protocol-version, and SSE replay behavior.
- **Validation**: `./scripts/verify-docs-standard.sh`
- **Conventional Commit subject**: `docs(mcp): document strict transport rollout`

### 10. Add resource subscription hooks

- **Paths**: `runtime/mcp/resource.go`, `runtime/mcp/resources_handlers.go`, `runtime/mcp/server.go`, `runtime/mcp/resources_prompts_test.go`, `api-snapshots/go.txt`
- **Runtime scope**: go
- **Contract impact**: exported Go MCP API and public MCP methods; api-snapshot-update
- **Acceptance**: `resources/subscribe` and `resources/unsubscribe` dispatch through explicit server hooks and are advertised only when configured.
- **Validation**: `go test ./runtime/mcp && ./scripts/update-api-snapshots.sh && ./scripts/verify-api-snapshots.sh`
- **Conventional Commit subject**: `feat(mcp): add resource subscription hooks`

### 11. Add logging level hooks

- **Paths**: `runtime/mcp/server.go`, `runtime/mcp/logging.go`, `runtime/mcp/*_test.go`, `api-snapshots/go.txt`
- **Runtime scope**: go
- **Contract impact**: exported Go MCP API and public MCP method; api-snapshot-update
- **Acceptance**: `logging/setLevel` dispatches through an explicit hook, validates known levels, and the `logging` capability is omitted unless the hook is configured.
- **Validation**: `go test ./runtime/mcp && ./scripts/update-api-snapshots.sh && ./scripts/verify-api-snapshots.sh`
- **Conventional Commit subject**: `feat(mcp): add logging level hook`

### 12. Add completion hooks

- **Paths**: `runtime/mcp/server.go`, `runtime/mcp/completion.go`, `runtime/mcp/prompt.go`, `runtime/mcp/resource.go`, `runtime/mcp/*_test.go`, `api-snapshots/go.txt`
- **Runtime scope**: go
- **Contract impact**: exported Go MCP API and public MCP method; api-snapshot-update
- **Acceptance**: `completion/complete` dispatches through explicit prompt/resource completion hooks and the `completions` capability is omitted unless at least one hook is configured.
- **Validation**: `go test ./runtime/mcp && ./scripts/update-api-snapshots.sh && ./scripts/verify-api-snapshots.sh`
- **Conventional Commit subject**: `feat(mcp): add completion hook`

### 13. Propagate cancellation notifications to in-flight requests

- **Paths**: `runtime/mcp/server.go`, `runtime/mcp/cancel.go`, `runtime/mcp/streaming.go`, `runtime/mcp/*_test.go`, `api-snapshots/go.txt` if exported hooks are added
- **Runtime scope**: go
- **Contract impact**: public MCP notification and request lifecycle behavior; api-snapshot-update if exported hooks are added
- **Acceptance**: `notifications/cancelled` locates matching in-flight non-task requests for the session, cancels their contexts, and ignores unknown/completed request IDs safely.
- **Validation**: `go test ./runtime/mcp && ./scripts/verify-api-snapshots.sh`
- **Conventional Commit subject**: `feat(mcp): propagate cancellation notifications`

### 14. Document optional utility capability wiring

- **Paths**: `docs/integrations/mcp.md`, `docs/integrations/remote-mcp.md`, `docs/core-patterns.md`, `api-snapshots/go.txt` only if docs reference generated public surface
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: Documentation states that resource subscriptions, logging, completions, and cancellation hooks are capability-gated and must not be advertised by products until product policy is wired.
- **Validation**: `./scripts/verify-docs-standard.sh`
- **Conventional Commit subject**: `docs(mcp): document optional utility hooks`

### 15. Add MCP task runtime contract

- **Paths**: `runtime/mcp/task.go`, `runtime/mcp/server.go`, `runtime/mcp/tool.go`, `runtime/mcp/*_test.go`, `api-snapshots/go.txt`
- **Runtime scope**: go
- **Contract impact**: exported Go MCP API and public MCP capability shape; api-snapshot-update
- **Acceptance**: AppTheory exposes task types, task store interfaces, task capability options, and task-augmented request parsing without advertising tasks unless explicitly configured.
- **Validation**: `go test ./runtime/mcp && ./scripts/update-api-snapshots.sh && ./scripts/verify-api-snapshots.sh`
- **Conventional Commit subject**: `feat(mcp): add task runtime contract`

### 16. Implement task-backed tool execution

- **Paths**: `runtime/mcp/task.go`, `runtime/mcp/task_memory.go`, `runtime/mcp/server.go`, `runtime/mcp/tool.go`, `runtime/mcp/*_test.go`
- **Runtime scope**: go
- **Contract impact**: public MCP task method and `tools/call` behavior; Go runtime tests
- **Acceptance**: Task-augmented `tools/call`, `tasks/get`, `tasks/result`, `tasks/list`, and `tasks/cancel` work against the memory task store with terminal-state, polling, result, and cancellation semantics covered by tests.
- **Validation**: `go test ./runtime/mcp`
- **Conventional Commit subject**: `feat(mcp): implement task-backed tool calls`

### 17. Add durable MCP task storage and CDK wiring

- **Paths**: `runtime/mcp/task_dynamo.go`, `runtime/mcp/task_dynamo_test.go`, `cdk/lib/remote-mcp-server.ts`, `cdk/lib/remote-mcp-server.js`, `cdk/lib/remote-mcp-server.d.ts`, `cdk/.jsii`, `cdk-go/`, `api-snapshots/go.txt`
- **Runtime scope**: go
- **Contract impact**: exported Go runtime and deployment-visible CDK surface; api-snapshot-update
- **Acceptance**: AppTheory provides a TableTheory-backed task store and `AppTheoryRemoteMcpServer` can provision and grant a task table with task TTL environment wiring.
- **Validation**: `go test ./runtime/mcp && cd cdk && npm test && cd .. && ./scripts/update-cdk-generated.sh && go test ./cdk-go/apptheorycdk && ./scripts/update-api-snapshots.sh && ./scripts/verify-api-snapshots.sh`
- **Conventional Commit subject**: `feat(cdk): provision mcp task storage`

### 18. Document task runtime adoption and security boundaries

- **Paths**: `docs/integrations/mcp.md`, `docs/integrations/remote-mcp.md`, `docs/cdk/mcp-server-remote-mcp.md`, `cdk/docs/mcp-server-remote-mcp.md`, `docs/core-patterns.md`
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: Documentation explains task capability opt-in, session/principal binding expectations, TTL limits, cancellation behavior, and how products should withhold task capability until policy is wired.
- **Validation**: `./scripts/verify-docs-standard.sh`
- **Conventional Commit subject**: `docs(mcp): document task runtime adoption`

### 19. Document MCP rate-limit integration stance

- **Paths**: `docs/integrations/mcp.md`, `docs/integrations/remote-mcp.md`, `docs/core-patterns.md`, `runtime/rate_limit_middleware.go` comments only if needed
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: Documentation states that route/principal/tool-aware MCP rate limiting is product wiring over existing `RateLimitMiddleware` and `pkg/limited`, not a separate MCP framework feature.
- **Validation**: `./scripts/verify-docs-standard.sh`
- **Conventional Commit subject**: `docs(mcp): document rate-limit integration stance`
