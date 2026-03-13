# MCP example — resumable SSE tool call (Streamable HTTP)

This example demonstrates a streaming tool call where:
- the server emits `notifications/progress` (as JSON-RPC, framed as SSE)
- the client can disconnect and later resume via `GET /mcp` + `Last-Event-ID`

In production (AWS), ensure:
- API Gateway **REST API v1** is used for `/mcp` streaming
- long tasks append progress/results into a durable event log for replay

See `docs/integrations/remote-mcp.md`.
