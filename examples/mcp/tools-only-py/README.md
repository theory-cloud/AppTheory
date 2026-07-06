# MCP example — tools only (Python runtime)

This example builds a minimal MCP server with the Python AppTheory runtime and tests it with the deterministic MCP testkit.

- Transport: Streamable HTTP (`POST/GET/DELETE /mcp`)
- Runtime: Python package (`py/src` in this repository)
- Validation: `python3 server_test.py`

No AWS account is required for the test; the harness invokes the AppTheory app in memory.
