# AppTheory Core Patterns

This document records the canonical patterns AppTheory expects across languages and documentation surfaces.

## Pattern: treat API snapshots as the external source of truth

Problem: human docs can drift from exported interfaces.

CORRECT:

- update docs and `api-snapshots/*` in the same change when an external API moves
- treat `api-snapshots/go.txt`, `api-snapshots/ts.txt`, and `api-snapshots/py.txt` as release-gated truth
- mark unconfirmed interfaces as `UNKNOWN:` or `TODO:` instead of guessing

INCORRECT:

- documenting an export that is not present in the snapshots
- inferring public stability from an internal helper or a test-only path

## Pattern: keep Lambda entrypoints thin

Problem: hand-rolled event-shape detection drifts from the runtime contract.

CORRECT:

```go
func handler(ctx context.Context, event json.RawMessage) (any, error) {
	return app.HandleLambda(ctx, event)
}
```

INCORRECT:

```go
if event.RequestContext.HTTP.Method != "" {
	return app.ServeAPIGatewayV2(ctx, parsed)
}
```

The dispatcher already knows how to route HTTP, queues, streams, WebSockets, and other supported AWS shapes.
That includes standard AppSync resolver events.

## Pattern: route AppSync resolvers through the normal router

Problem: bespoke GraphQL field switching duplicates request adaptation and bypasses the runtime's typed AppSync
context.

CORRECT:

```go
app.Get("/getThing", func(ctx *apptheory.Context) (*apptheory.Response, error) {
	appsync := ctx.AsAppSync()
	return apptheory.JSON(200, map[string]any{"field": appsync.FieldName})
})
```

Use `ServeAppSync` / `serveAppSync` / `serve_appsync` for AppSync-only Lambdas, or keep mixed-trigger Lambdas on the
universal dispatcher.

INCORRECT:

```go
switch event.Info.FieldName {
case "getThing":
	// bespoke resolver handling outside the AppTheory router
}
```

## Pattern: header handling is case-insensitive and response keys are lowercase

Problem: HTTP header names are case-insensitive, but maps and dicts are not.

CORRECT:

```go
reqID := ctx.Header("X-Request-Id")
resp.Headers["x-request-id"] = []string{reqID}
```

INCORRECT:

```go
resp.Headers["X-Request-Id"] = []string{reqID}
```

## Pattern: register more-specific routes first

If two routes are equally specific, the router prefers earlier registration order.

CORRECT:

```go
app.Get("/users/me", handleMe)
app.Get("/users/{id}", handleUser)
```

INCORRECT:

```go
app.Get("/users/{id}", handleUser)
app.Get("/users/me", handleMe)
```

## Pattern: use strict route registration in tests and CI

Default route registration preserves backwards compatibility. Invalid patterns can therefore be ignored unless you opt
into strict registration.

CORRECT:

```go
if _, err := app.GetStrict("/users/{id}", handleUser); err != nil {
	panic(err)
}
```

INCORRECT:

```go
app.Get("/{proxy+}/x", handleUser)
```

## Pattern: keep middleware pure and deterministic

CORRECT:

- store request-scoped values via `ctx.Set(...)` / `ctx.Get(...)`
- return a modified response rather than mutating global state

INCORRECT:

- caching per-request values in package globals
- depending on wall-clock time instead of the injected clock or test env

## Pattern: streaming is adapter-specific

Streaming is validated by contract fixtures for supported adapters. Do not assume every AWS integration supports the
same streaming semantics.

CORRECT:

- use runtime-provided helpers such as `htmlStream`, `sseEventStream`, `SSEResponse`, or `SSEStreamResponse`
- test streaming deterministically with the language test env

INCORRECT:

- assuming every AWS integration supports streaming the same way

## Pattern: choose the MCP deployment shape by client transport needs

Problem: Bedrock AgentCore and Claude Remote MCP do not share the same transport, streaming, or OAuth discovery
requirements.

CORRECT:

- use `AppTheoryMcpServer` for AgentCore or other POST-only MCP clients on HTTP API v2
- use `AppTheoryRemoteMcpServer` plus `AppTheoryMcpProtectedResource` for Claude Remote MCP when you need
  `POST/GET/DELETE /mcp`, OAuth protected-resource discovery, and a REST API v1 streaming edge
- wire `mcp.NewDynamoStreamStore(db)` or another persistent `StreamStore` in application code if replay must survive
  reconnects and cold starts

INCORRECT:

- assuming `AppTheoryMcpServer` is a drop-in deployment for resumable Remote MCP
- assuming `enableStreamTable` alone makes replay durable without `mcp.WithStreamStore(...)`

## Pattern: sanitize user payloads before logging

Import pipelines and event-driven workloads often process PCI/PII-heavy payloads. Treat payloads as user data and
prevent sensitive data leaks in logs.

CORRECT:

- sanitize log strings to strip control characters
- sanitize structured fields by key name
- log sanitized JSON or XML instead of raw payload dumps

INCORRECT:

- logging raw request bodies or third-party payloads directly
- assuming internal batch jobs can skip sanitization

Guide: [Sanitization](./features/sanitization.md)

## Pattern: use the jobs ledger for long-running import workflows

CORRECT:

- create a job record before fan-out starts
- use record-level status plus idempotency keys for retries
- acquire and refresh leases when work can be retried concurrently

INCORRECT:

- relying on at-least-once delivery without idempotency state
- storing job progress only in logs

Guide: [Jobs Ledger](./features/jobs-ledger.md)
