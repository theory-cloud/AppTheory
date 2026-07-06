# MCP example — tools only (TypeScript runtime)

This example builds a minimal MCP server with the TypeScript AppTheory runtime and tests it with the deterministic MCP testkit.

- Transport: Streamable HTTP (`POST/GET/DELETE /mcp`)
- Runtime: TypeScript package (`ts/dist` in this repository)
- Validation: `node server.test.mjs`

No AWS account is required for the test; the harness invokes the AppTheory app in memory.
