# Autheory implementation notes — OAuth AS for Claude Remote MCP (DCR day‑1)

This document describes how **Autheory** should implement an OAuth Authorization Server that is compatible with **Claude Custom Connectors** and the MCP authorization specs (2025-06-18 first, 2025-03-26 compatibility).

Autheory is built from **AppTheory primitives**; AppTheory should make this implementation *easy and consistent*.

---

## 1) What Claude will do (high-level)

When the user configures a connector, Claude behaves like a public OAuth client:

1) Call MCP without token → receive `401` with `WWW-Authenticate: Bearer resource_metadata="..."`
2) Fetch `/.well-known/oauth-protected-resource` from the MCP server (resource server)
3) Discover authorization server(s) and fetch `/.well-known/oauth-authorization-server`
4) Perform **DCR** (RFC7591) to obtain a `client_id` (no client secret)
5) Run Authorization Code + PKCE in a browser
6) Exchange code for tokens at `/token` (expects refresh token support)
7) Call MCP with `Authorization: Bearer ...` on every request

---

## 2) Autheory requirements (day‑1)

### Protocol support

- OAuth 2.1 semantics for Authorization Code + PKCE (public clients)
- OAuth Authorization Server Metadata (RFC8414): `/.well-known/oauth-authorization-server`
- Dynamic Client Registration (RFC7591): `POST /register`
- Refresh tokens supported at `/token`
- Resource Indicators (RFC8707): accept `resource=` in authorize + token requests (MCP 2025-06-18)

### DCR policy for Claude (recommended defaults)

Autheory should enforce a strict registration policy:

- `redirect_uris` must be exactly one of:
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`
- `token_endpoint_auth_method` must be `none`
- PKCE required (reject auth code exchange without `code_verifier`)
- Registration rate limiting + abuse controls
- Stable `client_name` handling (record it, don’t trust it for policy)

### Network allowlisting (Claude connectors)

If deployments require IP allowlisting, Claude documents that connectors may originate from:

- `147.75.62.217`
- `147.75.78.11`
- `147.75.110.74`

Treat this as a **doc-dependent operational detail** (verify periodically).

### Known client quirks (plan for robustness)

Claude documents a known issue (at least for Claude Code) around parsing `scopes_supported` and constructing `scope` during DCR, which can surface as `invalid_client`.

Autheory should:
- tolerate unexpected/extra scope fields in DCR requests
- fail with clear error messages when rejecting DCR, to aid debugging

---

## 3) Endpoint checklist (Autheory)

Autheory should expose, at minimum:

- `GET /.well-known/oauth-authorization-server` (RFC8414 metadata)
- `POST /register` (RFC7591 DCR)
- `GET /authorize` (authorization endpoint)
- `POST /token` (token + refresh endpoint)
- `GET <jwks_uri>` (JWKS for JWT validation by resource servers)

Notes:
- MCP 2025-03-26 clients may fall back to default root endpoints (`/authorize`, `/token`, `/register`) when metadata is missing; Autheory should provide metadata so fallbacks are rarely used.

---

## 4) Token semantics (make resource servers easy)

To keep protected MCP servers simple and safe:

- Prefer **JWT access tokens** with a stable `iss` (Autheory issuer) and verifiable signature via JWKS.
- Enforce audience/resource:
  - If `resource=` is provided, mint tokens scoped to that resource (audience claim and/or resource indicator claim).
  - Validate `resource=` consistently on refresh flows (refresh must not silently broaden access).
- Encode authorization context needed by protected MCP servers:
  - subject/user identity
  - tenant/org identity (if applicable)
  - scopes/permissions
  - optional “allowed KBs” / entitlements where applicable (or provide an introspection API).

AppTheory should provide helpers to:
- generate metadata documents
- validate DCR requests
- implement code + refresh token storage safely

---

## 5) Storage model (suggested)

Autheory needs durable storage for:

- Registered OAuth clients (from DCR)
- Authorization codes (short TTL)
- Refresh tokens (revocable, rotated)
- User sessions/consent (Autheory UX/policy)

AppTheory should provide CDK primitives to make this “one construct away”:
- tables + TTL attributes
- IAM policies for least privilege
- optional encryption-at-rest knobs

---

## 6) Testing strategy (Autheory CI)

Autheory should adopt AppTheory’s contract fixtures so that:

- DCR succeeds against real Autheory endpoints
- PKCE auth code flow succeeds end-to-end
- refresh token works and preserves resource binding
- metadata documents validate and are compatible with Claude’s client behavior

Autheory should also include a “Claude callback allowlist” unit test so that changes to redirect URI policy cannot regress.
