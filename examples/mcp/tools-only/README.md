# MCP example — tools only (Streamable HTTP)

This example builds a minimal MCP server that exposes only tools.

- Transport: dual-version Streamable HTTP (`2025-11-25` POST/GET/DELETE plus stateless `2026-07-28` POST)
- Runtime: Go (`runtime/mcp`)

The same handler answers `server/discover` for both shapes. See the parent `examples/mcp/README.md` for a stateless
request.

For Claude Remote MCP deployment on AWS (REST streaming), see `docs/integrations/remote-mcp.md`.
