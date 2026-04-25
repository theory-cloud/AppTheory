# AppTheory v1.0 Security Migration Guide

This guide consolidates the security-hardening changes that intentionally move AppTheory to the v1.0 fail-closed
baseline.

Read this guide before promoting a pre-v1 deployment that relied on previous permissive behavior in AppTheory’s
runtime, MCP transport, or CDK constructs. Not every hardening item needs a migration action, but the ones below are
the surfaces most likely to affect operator configuration, dashboards, tests, or integration expectations.

## Auth hooks now reject empty principal identities

Affected surface:

- Go runtime `WithAuthPrincipalHook(...)` + protected routes using `RequireAuth()`

What changed:

- Returning a non-nil principal with an empty `Identity` no longer satisfies `RequireAuth()`.
- Empty or whitespace-only identities are now treated as unauthenticated and return `401`.

What you need to do:

1. Ensure your principal hook returns:
   - `nil` / unauthenticated when identity cannot be established, or
   - a principal with a non-empty `Identity` when authentication succeeds.
2. If you previously used an empty identity as a sentinel value, replace that with explicit hook-local state instead.

Why this changed:

- Empty identities were a fail-open ambiguity in the protected-route contract.

## Remote MCP bearer protection now fails closed

Affected surface:

- `runtime/oauth.RequireBearerTokenMiddleware(...)`
- `runtime/mcp.Server` initial `GET /mcp` listener behavior
- `runtime/mcp` session lifecycle on durable stores

What changed:

- You must provide a `Validator`. If you omit it, the middleware now rejects every request with `401` instead of
  accepting any syntactically valid `Authorization: Bearer ...` token.
- The `WWW-Authenticate` `resource_metadata` challenge is derived only from an explicit `ResourceMetadataURL` or from
  `MCP_ENDPOINT`. It is no longer derived from `Host` / `X-Forwarded-Proto` request headers.
- `GET /mcp` without `Last-Event-ID` now emits a short-lived keepalive SSE response and closes by default instead of
  staying open indefinitely.
- Expired MCP sessions now fail closed instead of being refreshed back to life when a durable session record still
  exists.
- Panics in streaming tool execution are recovered into internal-error output instead of terminating the Go process.

What you need to do:

1. Provide a real token validator (JWT verification, introspection, or equivalent) whenever you use
   `RequireBearerTokenMiddleware(...)`.
2. Ensure the middleware has an explicit metadata source:
   - set `ResourceMetadataURL`, or
   - deploy through `AppTheoryRemoteMcpServer` so `MCP_ENDPOINT` is injected.
3. If you previously depended on request-header-derived metadata discovery, replace that with explicit configuration.
4. If your client depended on an indefinitely open initial `GET /mcp` listener with no `Last-Event-ID`, either:
   - move to resumable stream replay, or
   - opt in explicitly with `mcp.WithInitialSessionListenerBudget(...)` for a bounded open-listener window.
5. Do not rely on expired session IDs remaining usable until DynamoDB TTL cleanup eventually runs; expired sessions now
   return `404`.

Why this changed:

- Accepting arbitrary Bearer tokens when no validator was configured was not fail-closed.
- Deriving protected-resource metadata from request headers trusted attacker-influenced inputs in proxy setups.
- Indefinitely open initial listeners and session resurrection both undermined the intended MCP transport and session
  boundaries.

## Credentialed CORS now requires an explicit allowlist

Affected surface:

- portable CORS config in Go / TypeScript / Python when `allow_credentials` / `allowCredentials` is enabled

What changed:

- Non-credentialed CORS still treats an omitted allowlist as allow-all.
- Credentialed CORS now fails closed unless you configure explicit `allowed_origins`.
- When credentials are enabled and no allowlist is configured, AppTheory no longer reflects the request origin or emits
  `Access-Control-Allow-Credentials`.

What you need to do:

1. Whenever you enable credentialed CORS, set an explicit allowlist for the exact origins that should receive browser
   credentials.
2. Update tests that previously expected origin reflection with `AllowCredentials` but no allowlist.

Why this changed:

- Credentialed origin reflection without an allowlist is a browser-facing fail-open footgun.

## Streamed responses now honor `max_response_bytes`

Affected surface:

- Go / TypeScript / Python response streaming when `max_response_bytes` / `maxResponseBytes` is configured

What changed:

- Streamed responses are now subject to the same response-size guardrail as buffered responses.
- Once a stream would exceed the configured limit, the already-committed status and headers stay intact and the stream
  terminates with `app.too_large`.

What you need to do:

1. Review any streaming endpoints that relied on `max_response_bytes` being ignored for streamed bodies.
2. Increase the configured limit, split the stream into smaller responses, or remove the limit for that handler if the
   larger output is intentional.

Why this changed:

- Streaming previously bypassed the configured response-size guardrail entirely.

## AppSync unexpected exceptions now mask to `internal error`

Affected surface:

- Go / TypeScript / Python AppSync resolver adapters when handlers throw non-portable exceptions

What changed:

- Non-portable AppSync exceptions no longer echo raw exception text to clients.
- AppTheory/AppError values still preserve their intended portable messages and metadata.

What you need to do:

1. If you want a client-visible AppSync message, throw a portable AppTheory/AppError instead of a generic exception.
2. Update tests that previously matched raw exception strings in AppSync responses.

Why this changed:

- Leaking raw exception text from AppSync created an avoidable information-disclosure path.

## Timeout middleware is cooperative cancellation, not hard preemption

Affected surface:

- Go / TypeScript / Python timeout middleware

What changed:

- Timeout middleware now documents and tests a cooperative cancellation contract across runtimes.
- A timed-out request returns `app.timeout`, but user code must observe cancellation (`ctx.Done()`, `AbortSignal`, or
  equivalent cooperative checks) if it needs to stop work before side effects commit.

What you need to do:

1. Update long-running handlers to observe cancellation rather than assuming the middleware can forcibly stop execution.
2. Treat timeout middleware as a response contract plus cancellation signal, not as a hard kill switch.

Why this changed:

- Force-killing goroutines, promises, or threads is not portable across the three runtimes; the contract needed to make
  the cooperative model explicit and deterministic.

## Go rate-limit middleware now fingerprints credential-derived identifiers by default

Affected surface:

- `runtime.RateLimitMiddleware(...)` when you rely on the default `ExtractIdentifier`

What changed:

- The Go runtime no longer stores raw credential material as the default limiter identifier.
- Requests identified by `x-api-key` now use `api_key:hmac-sha256:<hex>`.
- Requests identified by `Authorization: Bearer ...` now use `bearer:hmac-sha256:<hex>`.
- `AuthIdentity`, `TenantID`, and explicit `ExtractIdentifier` overrides are unchanged.

What you need to do:

1. Expect a one-time bucket reset for any deployment that previously keyed limits directly on API keys or Bearer tokens.
2. Update dashboards, operational tooling, or table inspection workflows that expected raw credential values in limiter
   keys.
3. If you need a different identifier shape, provide an explicit `ExtractIdentifier` instead of depending on the
   default.

Why this changed:

- Raw API keys and Bearer tokens should not be stored in rate-limit tables by default.
- HMAC fingerprinting keeps default limiter behavior deterministic while reducing credential exposure in storage and
  diagnostics.

## Sanitization once again redacts token-like keys by default

Affected surface:

- Go / TypeScript / Python sanitization helpers

What changed:

- Segment-based secret redaction heuristics were restored for token-like field names.
- `authorization_id` is no longer treated as an allowlisted clear-text identifier; it now redacts as a secret alias.
- Business keys that merely contain those substrings as part of a larger identifier (for example
  `authorizationCode` or `tokenization_method`) remain readable.

What you need to do:

1. Expect some log fields to become redacted again, including `authorization_id`.
2. Update dashboards or support tooling that depended on reading those values directly from logs.

Why this changed:

- The previous allowlist/substring behavior let token-like fields fall through to clear-text logging too easily.

## AppTheorySsrSite now fails closed on Function URL access and tenant-header trust

Affected surface:

- `cdk/lib/AppTheorySsrSite`

What changed:

- Omitted `ssrUrlAuthType` now defaults to `AWS_IAM` for all SSR site topologies. CloudFront signs the Lambda Function
  URL origin with lambda Origin Access Control by default.
- Public direct Function URL access now requires an explicit compatibility opt-in:
  `ssrUrlAuthType: lambda.FunctionUrlAuthType.NONE`.
- Viewer-supplied tenant headers are no longer trusted by default:
  - `x-tenant-id` is stripped at the edge
  - tenant-like entries in `ssrForwardHeaders` are rejected unless you explicitly set
    `allowViewerTenantHeaders: true`
- The default `ssg-isr` HTML cache key no longer varies on tenant-like viewer headers unless compatibility passthrough
  is explicitly enabled.

What you need to do:

1. If you depended on public direct Function URL access, set `ssrUrlAuthType: lambda.FunctionUrlAuthType.NONE`
   explicitly.
2. If you previously forwarded `x-tenant-id` or headers such as `x-facetheory-tenant` from the viewer, migrate to a
   trusted derivation model:
   - derive tenant from `x-apptheory-original-host` / `x-facetheory-original-host` inside the SSR function using your
     allowlisted host mapping, or
   - inject a trusted tenant header upstream before the request reaches the AppTheory origin contract.
3. If you need temporary backwards compatibility while you migrate, set:

   ```ts
   allowViewerTenantHeaders: true,
   ssrForwardHeaders: ["x-facetheory-tenant"],
   ```

   This restores legacy passthrough, but those tenant headers remain viewer-controlled.

Why this changed:

- Public Function URL defaults bypass CloudFront-only controls such as WAF, geo/IP restrictions, and signed-origin
  enforcement.
- Forwarding viewer-supplied tenant headers without a trust contract let clients influence origin tenant context and
  `ssg-isr` HTML cache partitioning.

## WAF `ipWhitelist` now behaves like a real allowlist

Affected surface:

- `AppTheoryEnhancedSecurity` with `wafConfig.ipWhitelist`

What changed:

- Configuring `ipWhitelist` now synthesizes default-deny WebACL behavior instead of an allow rule layered on top of a
  default-allow ACL.

What you need to do:

1. Re-check any smoke tests or operational expectations that assumed non-whitelisted traffic would still pass through.
2. If you were relying on the previous ineffective behavior, replace it with an intentional blacklist or no whitelist
   at all.

Why this changed:

- An allowlist that does not deny non-matching traffic is not an allowlist.

## Jobs and EventBus hardening now reject permissive edge cases earlier

Affected surface:

- Go / TypeScript / Python jobs semaphore acquisition
- Go EventBus publish/query behavior
- Go batch event middleware context usage

What changed:

- Semaphore acquisition now rejects pathological `limit` values above `256` before entering the per-slot storage loop.
- EventBus publish always derives persisted partition/sort keys from validated event data instead of honoring
  caller-supplied storage keys.
- Batch event handlers receive isolated per-record `EventContext` values so `ctx.Set(...)` state does not leak across
  records.

What you need to do:

1. Clamp any user-facing semaphore limit knobs to `256` or below.
2. Do not rely on caller-supplied EventBus storage keys; only `TenantID`, `EventType`, `PublishedAt`, and `ID` define
   persisted keys now.
3. If you intentionally shared per-record batch state through `EventContext`, move that state into your own batch-level
   coordinator instead of `ctx.Set(...)`.

Why this changed:

- These edge cases created avoidable write amplification, tenant-boundary confusion, or cross-record state leakage.

## Internal-only hardening with no operator migration action

The v1.0 foundation also included low-level fixes that should not require configuration changes:

- prototype-safe TypeScript header canonicalization for `constructor` / `__proto__`
- earlier oversized base64 request rejection before full decode allocation
- explicit preservation of legacy `queueProps` security settings in `AppTheoryQueueProcessor`

You should not need to change configuration for these items, but they are part of the same fail-closed baseline reset.
