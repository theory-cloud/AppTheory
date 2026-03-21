# Autheory (OAuth Authorization Server) for Claude Remote MCP — AppTheory guide

Claude Custom Connectors (Remote MCP) behave like a **public OAuth client** and require:
- Dynamic Client Registration (DCR) day‑1 (RFC7591)
- Authorization Code + PKCE (public clients)
- Refresh tokens
- OAuth discovery via:
  - protected resource metadata (RFC9728) on the MCP server
  - authorization server metadata (RFC8414) on Autheory

This guide describes what Autheory must implement, and which AppTheory helpers to use.

## Required endpoints

Autheory should host:
- `GET /.well-known/oauth-authorization-server` (RFC8414 metadata)
- `POST /register` (RFC7591 DCR)
- `GET /authorize`
- `POST /token` (authorization_code + refresh_token)
- `GET <jwks_uri>` (for JWT access token verification by resource servers)

## Day‑1 DCR policy (Claude-first)

Autheory should enforce:
- `redirect_uris` allowlist:
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`
- public clients only: `token_endpoint_auth_method=none`
- PKCE required at authorization + code exchange
- refresh tokens enabled

AppTheory helpers:
- DCR request types + validation: `runtime/oauth` (`ValidateDynamicClientRegistrationRequest`, `ClaudeDynamicClientRegistrationPolicy`)
- PKCE helpers: `NewPKCECodeVerifier`, `PKCEChallengeS256`, `PKCEVerifyS256`
- In-memory stores for local/dev: `NewMemoryAuthorizationCodeStore`, `NewMemoryRefreshTokenStore`

## Resource Indicators (MCP `2025-06-18`)

Claude includes `resource=` in authorize and token requests. Autheory should:
- accept `resource=` for authorization_code and refresh_token flows
- bind refresh tokens to a resource (refresh must not broaden access)

## Testing

Use the Claude-like harness in AppTheory to pin behavior in CI:
- `testkit/oauth` (`ClaudePublicClient`)
- It exercises: discovery → DCR → PKCE auth code → token → refresh.

Example:

```go
oauthClient := oauthtest.NewClaudePublicClient(nil)

discovery, dcr, tokenResp, refreshResp, err := oauthClient.Authorize(ctx, oauthtest.AuthorizeOptions{
  McpEndpoint: "https://api.example.com/prod/mcp",
})
```

Defaults match Claude-first expectations:

- `Origin`: `https://claude.ai`
- `RedirectURI`: `https://claude.ai/api/mcp/auth_callback`
- `McpEndpoint` is normalized to the canonical `/mcp` resource URL before the discovery flow begins

## Related notes

Additional maintainer planning notes exist outside the canonical docs root and are intentionally omitted here.
