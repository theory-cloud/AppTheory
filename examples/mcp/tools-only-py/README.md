# MCP example — tools only (Python runtime)

This example builds a minimal MCP server with the Python AppTheory runtime and tests it with the deterministic MCP testkit.

- Transport: dual-version Streamable HTTP (`2025-11-25` POST/GET/DELETE plus stateless `2026-07-28` POST)
- Runtime: Python package (`py/src` in this repository)
- Validation: `python3 server_test.py`

The same handler answers `server/discover` for both shapes. See the parent `examples/mcp/README.md` for a stateless
request.

No AWS account is required for the test; the harness invokes the AppTheory app in memory.
