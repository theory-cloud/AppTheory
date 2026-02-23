# Remote MCP (Claude connectors) — Planning

This folder contains the **planning and delivery roadmap** for making **AppTheory (library)** first-class for **Claude Custom Connectors via Remote MCP**.

## Locked decisions

- **Transport:** MCP **Streamable HTTP** only (no deprecated HTTP+SSE transport endpoints).
- **Auth:** **OAuth + Dynamic Client Registration (DCR) day‑1**.
- **Auth implementation:** `autheory` is the in-house Authorization Server, built using AppTheory primitives.
- **AWS edge:** API Gateway **REST API + Lambda response streaming** (HTTP API v2 is not viable for SSE streaming).
- **Long sessions:** durable **MCP session state** + **resumable SSE** (reconnect + `Last-Event-ID`) rather than a single long-lived connection.

## Documents

- `docs/development/planning/apptheory/remote-mcp/ROADMAP.md` — AppTheory roadmap, milestones, and acceptance criteria.
- `docs/development/planning/apptheory/remote-mcp/COMPATIBILITY_CONTRACT.md` — Wire-level contract (headers/status/SSE framing) for Claude compatibility.
- `docs/development/planning/apptheory/remote-mcp/HTTP_TRANSCRIPTS.md` — Golden HTTP transcripts used as future contract-test vectors.
- `docs/development/planning/apptheory/remote-mcp/API_SURFACE_SKETCH.md` — Proposed runtime + CDK + testkit public surfaces.
- `docs/development/planning/apptheory/remote-mcp/autheory.md` — Implementation notes for Autheory (OAuth AS + DCR + token semantics).
- `docs/development/planning/apptheory/remote-mcp/theory-mcp.md` — Implementation notes for theory-mcp (migrate to Streamable HTTP + async/resume model).

## Milestone records

- `docs/development/planning/apptheory/remote-mcp/M0.md`
- `docs/development/planning/apptheory/remote-mcp/M1.md`
- `docs/development/planning/apptheory/remote-mcp/M2.md`
- `docs/development/planning/apptheory/remote-mcp/M3.md`
