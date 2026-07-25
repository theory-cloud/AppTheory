# MCP examples

These examples cover the Go MCP runtime (`runtime/mcp`), the TypeScript MCP runtime (`ts/src/mcp`), and the Python MCP
runtime (`py/src/apptheory/mcp`) with Streamable HTTP behavior.

- `tools-only` — Go tools-only MCP server.
- `tools-only-ts` — TypeScript tools-only MCP server with deterministic testkit proof.
- `tools-only-py` — Python tools-only MCP server with deterministic testkit proof.
- `tools-resources-prompts` — Go MCP server with tools, resources, and prompts.
- `resumable-sse` — Go resumable SSE streaming example.

For Claude Remote MCP deployment on AWS, start with `docs/integrations/remote-mcp.md`.

## One handler, two protocol shapes

Every example server uses the same AppTheory handler for both:

- `2025-11-25`: initialize, retain `Mcp-Session-Id`, then use POST/GET/DELETE
- final `2026-07-28`: stateless POST, no initialize or session id

The example code does not need a mode switch. A modern client can discover the shared server surface with:

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

For modern tool calls, set `Mcp-Method: tools/call` and `Mcp-Name` to the exact tool name. Successful stateless
responses carry `resultType: "complete"` or `resultType: "input_required"`. GET/listen/subscriptions remain outside the
stateless shape; the resumable SSE example is intentionally session-ful.

See `docs/migration/mcp-2026-07-28.md` for routing headers, multi-round input, and the `-32020`/`-32021`/`-32022`
validation contract.
