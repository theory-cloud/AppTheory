# theory-mcp implementation notes — Streamable HTTP Remote MCP (Claude-first)

This document describes how `theory-mcp` should adopt AppTheory’s **Streamable HTTP** MCP support to become compatible with **Claude Custom Connectors** (Remote MCP), while preserving the existing WebSocket + async-processing architecture.

---

## 1) Goals

- Provide a **Claude-compatible** `/mcp` endpoint using MCP **Streamable HTTP** (POST/GET/DELETE on one path).
- Support true incremental streaming on AWS using **API Gateway REST + Lambda response streaming** (no HTTP API v2 on this path).
- Preserve the “hours-long logical session” model using async workers + durable event logs, not a single long-lived connection.
- Use **Autheory** as the OAuth Authorization Server with **DCR day‑1**.

---

## 2) Recommended delivery model (matches existing async design)

### Separate concerns

1) **Ingress Lambda (Streamable HTTP)**
   - Validates `Authorization: Bearer ...` (Autheory token)
   - Handles MCP lifecycle + session creation (`Mcp-Session-Id`)
   - For long tool calls, enqueues async work and returns an SSE stream that “pumps” events from a durable log

2) **Worker Lambdas (async processing)**
   - Run the long task (existing processor model)
   - Append progress + final response into the stream event log

3) **Resume Lambda (GET /mcp)**
   - Supports `Last-Event-ID` replay for interrupted streams
   - Can optionally carry server-initiated notifications/requests (if theory-mcp needs them later)

### Why this maps well to AWS limits

- API Gateway REST response streaming is time-bounded; connections will end.
- The event log + resumability makes a session behave “long-lived” even though each SSE connection is short-lived.

---

## 3) Protocol requirements to implement (do not improvise)

theory-mcp must follow AppTheory’s compatibility contract exactly:

- JSON-RPC notifications without `id` (notably `notifications/initialized`) must be accepted and return `202`.
- Notifications/responses sent to `POST /mcp` return `202` with no body when accepted.
- Requests can return JSON or SSE; if SSE, the response must eventually include the JSON-RPC response to the originating request.
- `MCP-Protocol-Version` must be validated (assume `2025-03-26` when absent).
- Session id behavior must follow `Mcp-Session-Id` header semantics.
- Origin validation must be enabled with an allow-list appropriate to the deployment.

---

## 4) Auth integration (Autheory)

### Resource server behavior (theory-mcp)

- On unauthenticated requests, return `401` with `WWW-Authenticate` pointing to protected resource metadata.
- Host `/.well-known/oauth-protected-resource` (resource metadata) and list Autheory as the authorization server.
- Validate Bearer tokens on every request (including GET SSE stream connections).

### Authorization server behavior (Autheory)

See: `docs/development/planning/apptheory/remote-mcp/autheory.md`.

---

## 5) Migration plan (minimal disruption)

1) Add a **new** REST-streaming `/mcp` deployment path in theory-mcp CDK, separate from the current HTTP API v2 MCP endpoint.
2) Ship the Streamable HTTP handler behind that new path.
3) Add contract-test coverage and run it in CI.
4) Enable in staging, then production; keep the old MCP endpoint only as an internal/testing fallback until fully migrated.

---

## 6) Testing + “Claude smoke test”

theory-mcp should adopt AppTheory’s testkit fixtures and add one live smoke test per environment:

- “Create connector → login → list tools → call tool with streaming → reconnect mid-stream → complete”

The definition of done is that this smoke test is stable on AWS with real response streaming (not buffered).
