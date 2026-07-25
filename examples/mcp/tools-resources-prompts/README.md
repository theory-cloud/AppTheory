# MCP example — tools + resources + prompts (Streamable HTTP)

This example builds an MCP server that exposes:
- tools (`tools/list`, `tools/call`)
- resources (`resources/list`, `resources/read`)
- prompts (`prompts/list`, `prompts/get`)

The same handler dual-serves session-ful `2025-11-25` and stateless `2026-07-28`, including `server/discover`.
Modern `tools/call`, `resources/read`, and `prompts/get` requests send both `Mcp-Method` and the routed `Mcp-Name`.

For the full MCP wire behavior, see `docs/integrations/mcp.md`.
