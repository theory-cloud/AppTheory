# AppTheory v1.0 Security Migration Guide

This guide tracks security-hardening changes that are intentionally moving AppTheory toward the v1.0 fail-closed
baseline.

## Remote MCP bearer protection now fails closed

Affected surface:

- `runtime/oauth.RequireBearerTokenMiddleware(...)`

What changed:

- You must provide a `Validator`. If you omit it, the middleware now rejects every request with `401` instead of
  accepting any syntactically valid `Authorization: Bearer ...` token.
- The `WWW-Authenticate` `resource_metadata` challenge is derived only from an explicit `ResourceMetadataURL` or from
  `MCP_ENDPOINT`. It is no longer derived from `Host` / `X-Forwarded-Proto` request headers.

What you need to do:

1. Provide a real token validator (JWT verification, introspection, or equivalent) whenever you use
   `RequireBearerTokenMiddleware(...)`.
2. Ensure the middleware has an explicit metadata source:
   - set `ResourceMetadataURL`, or
   - deploy through `AppTheoryRemoteMcpServer` so `MCP_ENDPOINT` is injected.
3. If you previously depended on request-header-derived metadata discovery, replace that with explicit configuration.

Why this changed:

- Accepting arbitrary Bearer tokens when no validator was configured was not fail-closed.
- Deriving protected-resource metadata from request headers trusted attacker-influenced inputs in proxy setups.
