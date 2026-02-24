# Public API surface sketch — AppTheory Remote MCP (Streamable HTTP + OAuth/DCR)

This document proposes **public surfaces** AppTheory should provide so that:

- a protected MCP server can be built with minimal glue
- Autheory can implement OAuth + DCR with minimal bespoke code
- theory-mcp can reuse the existing async-processing model while becoming Claude-compatible

This is a sketch for M0 and is expected to evolve during implementation, but names and responsibilities should remain stable.

---

## 1) Go runtime (core)

### 1.1 MCP server (protocol)

Existing:
- `runtime/mcp.Server` + registries for tools/resources/prompts

Target additions:
- A **Streamable HTTP transport wrapper** that:
  - parses JSON-RPC requests/notifications/responses
  - applies Streamable HTTP semantics (202 vs JSON/SSE)
  - supports GET SSE + DELETE session termination
  - frames outbound messages as SSE `event: message` with JSON-RPC payload

Proposed surface (illustrative):

- `mcp.NewServer(name, version, opts...) *mcp.Server` (existing)
- `(*mcp.Server).StreamableHTTP(opts...) apptheory.Handler`
  - mounts on `/mcp` and handles POST/GET/DELETE with correct semantics
- `mcp.WithOriginValidator(v mcp.OriginValidator)` (new option)
- `mcp.WithSessionStore(store mcp.SessionStore)` (existing option stays)
- `mcp.WithStreamStore(store mcp.StreamStore)` (new; resumability/event log)

### 1.2 Stores

Proposed interfaces:

- `type SessionStore interface { Get/Put/Delete/Touch(...) }`
- `type StreamStore interface { Append(event), Replay(fromID), Close(streamID) }`

Opinionated implementations:
- in-memory store for tests/local
- Dynamo-backed stores for production (tables defined via CDK constructs)

### 1.3 OAuth (resource server helpers)

Provide a small, composable package for protected resources:

- `oauthresource.Challenge(w http-ish) -> 401 + WWW-Authenticate(resource_metadata=...)`
- `oauthresource.Metadata(authorizationServers, resource) -> JSON document`
- `oauthresource.BearerMiddleware(validator, requiredScopes...)`

Token validation should be pluggable:
- JWKS (JWT validation)
- optional introspection hook (if Autheory chooses)

---

## 2) CDK (jsii) constructs

### 2.1 Remote MCP Streamable HTTP API (AWS)

Construct responsibilities:
- API Gateway **REST** API resources for `/mcp` with:
  - POST (request/notification ingress)
  - GET (SSE stream/resume)
  - DELETE (session termination; optional)
- Lambda integration configured for **response streaming**
- optional Dynamo tables for sessions + streams (and grants)

Proposed construct names (illustrative):
- `RemoteMcpStreamableHttpApi`
- `McpSessionTable` / `McpStreamTable` (or nested props on the main construct)

### 2.2 Protected resource metadata

Construct responsibilities:
- Add `/.well-known/oauth-protected-resource` route
- Support multi-AS configuration (for future) but default to a single Autheory issuer

Proposed:
- `McpProtectedResourceMetadata`

### 2.3 OAuth Authorization Server building blocks (for Autheory)

AppTheory should ship building blocks so Autheory can assemble:
- `/.well-known/oauth-authorization-server`
- `/register` (DCR)
- `/authorize`
- `/token`
- `jwks_uri`

Do not hardcode Autheory policy; expose policy hooks and default validators.

Proposed:
- `OAuthAuthorizationServer` (construct + runtime helpers)

---

## 3) Testkit + contract tests

### 3.1 Streamable HTTP MCP client (Go)

Needed features:
- POST JSON + POST SSE modes
- GET SSE open + parse
- disconnect + resume using `Last-Event-ID`
- header assertions (Mcp-Session-Id, MCP-Protocol-Version, status codes)

Proposed package:
- `testkit/mcpstream` (name TBD)

### 3.2 OAuth/DCR harness (Claude-like)

Needed features:
- RFC9728 challenge parsing (WWW-Authenticate)
- resource metadata fetch + validation
- AS metadata fetch + validation
- DCR POST + policy assertions (redirect URI allowlist)
- PKCE + auth code exchange (can be simulated for tests)
- refresh token flow

Proposed package:
- `testkit/oauth` (DCR + PKCE helpers)

### 3.3 Contract tests (cross-language gates)

Add a contract runner that:
- runs the transcripts in `HTTP_TRANSCRIPTS.md` as executable tests
- validates both “library runtime only” (local) and “AWS shape” (optional integration)

---

## 4) Backwards-compat strategy (explicit)

AppTheory should treat current `runtime/mcp.Server.Handler()` behavior as **legacy** and:
- either replace it with Streamable HTTP semantics, or
- add a new handler and clearly deprecate the legacy path in docs

The objective is “Claude-first correctness”, not preserving a non-standard transport.

