# SR-REMOTE-MCP — Claude-first Remote MCP (Streamable HTTP + OAuth/DCR)

This sub-roadmap defines the work required for **AppTheory (library)** to support **Claude Custom Connectors** using **Remote MCP**, with:

- MCP **Streamable HTTP** transport only (protocol `2025-06-18`)
- OAuth authorization (MCP `2025-06-18`) with **Dynamic Client Registration day‑1**
- AWS deployment path using API Gateway **REST API + Lambda response streaming**
- Long-lived logical sessions via **resumable SSE** + durable event logs (not a single long-lived connection)

## Start here

- `docs/development/planning/apptheory/remote-mcp/README.md`
- `docs/development/planning/apptheory/remote-mcp/M0.md`

## Roadmap + contract

- `docs/development/planning/apptheory/remote-mcp/ROADMAP.md`
- `docs/development/planning/apptheory/remote-mcp/COMPATIBILITY_CONTRACT.md`

