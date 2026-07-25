# MCP example — tools only (TypeScript runtime)

This example builds a minimal MCP server with the TypeScript AppTheory runtime and tests it with the deterministic MCP testkit.

- Transport: dual-version Streamable HTTP (`2025-11-25` POST/GET/DELETE plus stateless `2026-07-28` POST)
- Runtime: TypeScript package (`ts/dist` in this repository)
- Validation: `node server.test.mjs`

The same handler answers `server/discover` for both shapes. See the parent `examples/mcp/README.md` for a stateless
request.

No AWS account is required for the test; the harness invokes the AppTheory app in memory.
