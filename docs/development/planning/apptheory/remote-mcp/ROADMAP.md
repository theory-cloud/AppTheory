# AppTheory Roadmap — Claude-first Remote MCP (Streamable HTTP + DCR)

This roadmap defines how **AppTheory (library)** should support cloud MCP servers that are **100% compatible with Claude Custom Connectors** using **Remote MCP**.

It is written to be directly actionable as a set of work orders that can be split across agents.

---

## 1) Compatibility contract (definition of done)

### “100% compatible with Claude connectors” means

A Claude connector can be created with only a server URL and completes these flows reliably:

1) **Discovery + Auth**
   - On first MCP call without a token, the MCP server returns `401` with a `WWW-Authenticate` header that points to protected resource metadata (`/.well-known/oauth-protected-resource`) (MCP auth 2025-06-18).
   - Claude performs Authorization Server discovery using protected resource metadata + OAuth AS metadata (RFC8414).
   - Claude performs **Dynamic Client Registration** (RFC7591) successfully without manual client secrets.
   - Claude completes Authorization Code + PKCE, receives an **access token** and **refresh token**, and refresh works.

2) **MCP protocol**
   - Claude can complete the MCP lifecycle (`initialize` then `notifications/initialized`).
   - `notifications/initialized` (a JSON-RPC notification with no `id`) is accepted and returns `202 Accepted`.

3) **Streaming**
   - Claude can call tools and receive incremental progress when the server chooses SSE streaming (via Streamable HTTP).
   - Disconnect + reconnect does **not** lose the tool result when resumability is enabled (`Last-Event-ID`).

4) **Operational**
   - Token refresh does not break long-running sessions.
   - The deployment path works on AWS (API Gateway REST + Lambda response streaming) without buffering.

### Explicit non-goals for “Claude-first”

- No support for deprecated MCP **HTTP+SSE transport** endpoints (2024-11-05 era).
- No reliance on API Gateway **HTTP API v2** for streaming responses.
- No requirement that a single TCP connection lasts “hours”; instead, the **logical session** lasts hours and connections are resumable.

---

## 2) Target architecture (library-first)

### Roles

- **Resource Server (Protected MCP Server)**: the MCP endpoint (`/mcp`) that enforces Bearer auth and implements Streamable HTTP.
- **Authorization Server**: Autheory (built from AppTheory) providing OAuth + DCR + refresh tokens.

### Core patterns AppTheory must support

1) **Streamable HTTP transport** (POST/GET/DELETE on one path)
2) **Durable sessions** (`Mcp-Session-Id`) with pluggable storage (in-memory for local tests; Dynamo for production)
3) **Resumable SSE**
   - SSE event IDs and replay via `Last-Event-ID`
   - A per-stream event log, so disconnections/timeouts do not lose messages
4) **Async execution as first-class**
   - Long-running work executes in async Lambdas (SQS/streams), while “stream pump” Lambdas only read and stream events

---

## 3) AppTheory deliverables (what the library ships)

### 3.1 Go runtime (primary)

Add/replace runtime surfaces so consumers can mount a spec-correct server:

- **Streamable HTTP MCP handler**:
  - Accept JSON-RPC requests, notifications, responses.
  - Return `202` for accepted notifications/responses.
  - Support response as `application/json` or `text/event-stream` (SSE).
  - Support `MCP-Protocol-Version` header parsing and validation.
  - Session management via `Mcp-Session-Id` header.
  - `Origin` validation helpers (configurable allow-list).
- **Streaming semantics**:
  - All server messages are JSON-RPC objects sent as SSE “message” events.
  - Tool progress uses `notifications/progress` (not custom SSE event names).
  - Resumability uses SSE `id:` + GET with `Last-Event-ID`.
- **Stores (interfaces + opinionated Dynamo implementation)**:
  - `SessionStore` (by session id)
  - `StreamStore` / `EventLog` (by session + stream id; append + replay)
- **Async integration points**:
  - A canonical “enqueue work + append progress/results” helper surface that fits SQS + worker Lambdas.

### 3.2 CDK constructs (the “easy button”)

Provide constructs that create resources but remain configurable and composable:

- `RemoteMcpStreamableHttpApi` (name TBD)
  - API Gateway **REST** resources for `/mcp` with methods POST/GET/DELETE
  - Lambda integration configured for **response streaming**
  - Sensible defaults for timeouts, logging, CORS, throttling, and alarms
  - Optional creation/wiring of Dynamo tables needed for sessions/event log
  - Outputs needed by consumers (URL, resource identifiers)

- `McpProtectedResource` (name TBD)
  - Adds `/.well-known/oauth-protected-resource` endpoint
  - Adds standard `401` + `WWW-Authenticate` behavior helper for MCP routes
  - Connects the protected resource to one or more OAuth AS issuers (Autheory)

- `OAuthAuthorizationServer` building blocks (for Autheory)
  - High-level construct(s) to expose:
    - `/.well-known/oauth-authorization-server`
    - `/authorize`, `/token`, `/register`
    - `jwks_uri`
  - Hooks for Autheory policy decisions (tenant model, consent UX, risk controls)

#### Monorepo + cross-language requirements

AppTheory CDK is jsii-based. Any new constructs must:

- be added in `cdk/` in TypeScript
- keep `cdk/lib/` (build output) updated in-repo
- keep generated bindings updated (e.g. `cdk-go/`)
- include stable public APIs (update `api-snapshots/` when required)

### 3.3 Testkit + contract tests

AppTheory should ship deterministic tests that validate “Claude-first” behavior without requiring Claude:

- A **Streamable HTTP MCP test client** that can:
  - open POST SSE streams, parse events, and support disconnect/reconnect
  - open GET SSE streams with `Last-Event-ID`
  - validate status codes/headers (202/401/404/405) precisely
- An **OAuth + DCR test harness** that simulates a Claude-like public client:
  - DCR → PKCE auth code → token exchange → refresh
  - Enforces the “resource indicator” (`resource=`) behavior from MCP 2025-06-18
- Contract fixtures that can be reused in Autheory and theory-mcp CI.

---

## 4) Milestones (AppTheory-centric)

### Milestone M0 — Spec lock + “Claude-first” acceptance suite design

Goal: convert “compatibility” into executable assertions and stable library APIs.

Deliverables (AppTheory)
- A written compatibility spec (headers, status codes, event framing, required endpoints).
- A golden set of HTTP transcripts:
  - initialize + session id issuance
  - initialized notification (202)
  - tool call streaming with progress + final response
  - forced disconnect + resume via `Last-Event-ID`
  - auth challenge and metadata discovery
- Public API sketch for runtime + CDK surfaces (names, options, extension points).

Acceptance criteria
- A reviewer can implement from the doc without guessing.
- Every Claude doc requirement we depend on is captured explicitly (redirect URIs, DCR required, refresh required).

---

### Milestone M1 — Streamable HTTP runtime (Go)

Goal: make AppTheory’s MCP server spec-correct for Streamable HTTP.

Deliverables (AppTheory)
- JSON-RPC parsing accepts notifications (no `id`) and responses (server side).
- HTTP semantics:
  - 202 for accepted notifications/responses
  - request handling returns JSON or SSE
  - `MCP-Protocol-Version` validation and fallback behavior
  - `Mcp-Session-Id` issuance + validation + 404-on-terminated semantics
  - `DELETE /mcp` termination behavior
- SSE framing:
  - JSON-RPC messages delivered as “message” events
  - progress delivered as `notifications/progress`
  - resumability primitives (event id, replay, `Last-Event-ID`)
- “Origin validator” helper and safe defaults.

Acceptance criteria
- A local integration test can run the full lifecycle and streaming tool call without AWS.

---

### Milestone M2 — AWS streaming edge + CDK construct

Goal: make the “Claude path” deployment easy and correct on AWS.

Deliverables (AppTheory)
- CDK construct that provisions API Gateway **REST** + Lambda response streaming for `/mcp`.
- Default keepalive behavior guidance (idle timeout avoidance).
- Optional Dynamo tables + IAM grants for session + event log stores.

Acceptance criteria
- A reference app can deploy and demonstrate incremental SSE delivery (not buffered).

---

### Milestone M3 — OAuth primitives + Autheory enablement (DCR day‑1)

Goal: make it trivial for Autheory to be a spec-compliant OAuth AS for Claude connectors.

Deliverables (AppTheory)
- Protected Resource helpers:
  - `WWW-Authenticate` header builder for RFC9728 resource metadata discovery
  - `/.well-known/oauth-protected-resource` document generation
  - middleware helpers for token extraction/validation
- Authorization Server helpers (for Autheory):
  - RFC8414 metadata generation
  - RFC7591 DCR request/response types + validation helpers
  - PKCE utilities, authorization code issuance helpers, refresh token helpers
  - “Claude policy” hooks: redirect URI allowlist + public-client enforcement

Acceptance criteria
- A test harness (in AppTheory) can complete DCR + PKCE + refresh against a reference Autheory-built server.

---

### Milestone M4 — Contract tests + docs + examples

Goal: prevent regression and make adoption fast.

Deliverables (AppTheory)
- Contract tests that run in CI and assert protocol + auth behavior.
- Docs:
  - “Build a Remote MCP server with AppTheory” (Streamable HTTP only)
  - “Deploy on AWS (REST streaming)”
  - “Use Autheory as OAuth AS (DCR day‑1)”
- Examples (minimal) for:
  - tools-only server
  - tools+resources+prompts server
  - async tool with resumable SSE

Acceptance criteria
- A consumer repo can adopt by following docs with no missing pieces.

---

## 5) Cross-repo handoff points (what AppTheory should enable)

### Autheory (Authorization Server)

Autheory is responsible for:
- hosting OAuth endpoints and UX (login/consent)
- DCR policy enforcement and abuse prevention
- token issuance and refresh

AppTheory must provide:
- CDK + runtime primitives that make Autheory mostly configuration + policy wiring

See: `docs/development/planning/apptheory/remote-mcp/autheory.md`.

### theory-mcp (Protected MCP Resource Server)

theory-mcp is responsible for:
- tool surface, authz rules, and async execution engine
- mapping long-running work to resumable SSE streams

AppTheory must provide:
- Streamable HTTP MCP runtime + REST streaming CDK + store primitives

See: `docs/development/planning/apptheory/remote-mcp/theory-mcp.md`.

---

## 6) Risks and mitigations

- **API Gateway streaming limits** (max connection duration, idle timeouts): mitigate with keepalives + resumable SSE + async worker model.
- **DCR abuse** (open registration endpoint): mitigate with strict redirect URI allowlists, rate limiting, and “public client only” enforcement.
- **Token refresh during long sessions**: require token validation per request/stream connect; support refresh without invalidating session state.
- **Client quirks** (Claude implementation details): mitigate with contract tests that emulate Claude flows and pin spec versions explicitly.

---

## 7) Workstream map (where changes land in AppTheory)

This is a directory-level map to make delegation easier:

- `runtime/mcp/` — Streamable HTTP transport, JSON-RPC parsing, SSE framing, sessions.
- `runtime/oauth/` (new) — protected-resource helpers + auth-server primitives (for Autheory).
- `cdk/` — REST streaming MCP construct + protected-resource construct + auth-server building blocks.
- `testkit/` — Streamable HTTP client + OAuth/DCR harness.
- `contract-tests/` — end-to-end “Claude-first” contract runners/fixtures.
- `docs/` — end-user docs + migration guides after implementation stabilizes.
