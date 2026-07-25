# MCP example — resumable SSE tool call (Streamable HTTP)

This example demonstrates a streaming tool call where:
- the server emits `notifications/progress` (as JSON-RPC, framed as SSE)
- the client can disconnect and later resume via `GET /mcp` + `Last-Event-ID`
- the server opts into Lambda-aware budgeting for the initial `GET /mcp` keepalive listener

This is intentionally the session-ful `2025-11-25` path. The `2026-07-28` shape uses buffered stateless POST responses
and does not route GET/listen/subscriptions.

In production (AWS), ensure:
- API Gateway **REST API v1** is used for `/mcp` streaming
- long tasks append progress/results into a durable event log for replay
- if you want the initial keepalive listener to close before the Lambda deadline, configure
  `mcp.WithInitialSessionListenerBudget(...)`; replay/resume `GET /mcp` requests with `Last-Event-ID` are unchanged

See `docs/integrations/remote-mcp.md`.
