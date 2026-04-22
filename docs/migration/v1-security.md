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

## Go rate-limit middleware now hashes credential-derived identifiers by default

Affected surface:

- `runtime.RateLimitMiddleware(...)` when you rely on the default `ExtractIdentifier`

What changed:

- The Go runtime no longer stores raw credential material as the default limiter identifier.
- Requests identified by `x-api-key` now use `api_key:sha256:<hex>`.
- Requests identified by `Authorization: Bearer ...` now use `bearer:sha256:<hex>`.
- `AuthIdentity`, `TenantID`, and explicit `ExtractIdentifier` overrides are unchanged.

What you need to do:

1. Expect a one-time bucket reset for any deployment that previously keyed limits directly on API keys or Bearer tokens.
2. Update dashboards, operational tooling, or table inspection workflows that expected raw credential values in limiter
   keys.
3. If you need a different identifier shape, provide an explicit `ExtractIdentifier` instead of depending on the
   default.

Why this changed:

- Raw API keys and Bearer tokens should not be stored in rate-limit tables by default.
- Hashing keeps default limiter behavior deterministic while reducing credential exposure in storage and diagnostics.
