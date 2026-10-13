---
title: MCP auth facade SPI (provider and store)
description: The provider SPI, the Autheory adapter, the five store SPIs, the in-memory reference stores, and the conformance suites shipped by the MCP auth facade program.
---

# MCP auth facade SPI — provider and store

The MCP auth facade lets an application front an upstream auth provider (Autheory is the first adapter) on one
domain while the upstream stays the sole authorization server and token authority. This page documents the two
service-provider interfaces the facade is built on and what ships today.

**Status: the SPI layer exists; nothing is mounted.** The provider SPI, the store SPIs, the in-memory reference
stores, the conformance suites, and the fake provider are **inert packages**. No facade route is registered and
`FacadeConfig` does not consume them yet — the front channel, upstream callback, code exchange, DCR and brokered
refresh handlers land in the follow-on milestones. No store or provider is reachable from a request today.

## What the framework owns, and what the application owns

The framework owns **composition and mechanics**; the application owns **policy**. The full per-mechanic verdict is
in `docs/development/planning/apptheory/mcp-auth-facade/FRAMEWORK_VS_POLICY.md`. In short:

| Concern | Owner |
| --- | --- |
| Provider SPI shape, Autheory adapter, hardened upstream HTTP (deadline, size cap, SSRF guard) | Framework |
| Store SPI shape, atomic consume/CAS/lock/revoke semantics, in-memory reference stores | Framework |
| Conformance suites (provider + store) and the fake upstream provider | Framework |
| Scope vocabulary, `offline_access` lifecycle scope, `account_id` hint semantics | Application |
| Durable store backend (e.g. TableTheory/DynamoDB), encryption key/ARN, table shapes | Application |
| DCR entropy/prefix, redirect allow-list policy, legacy-client adoption | Application |

## Provider SPI

One interface per runtime, implemented once per provider. It is deliberately the minimum needed to derive the
facade from the requirements; Autheory is the first and only adapter in this program.

| Operation | Purpose | Fails closed on |
| --- | --- | --- |
| `Discovery` | RFC 8414/OIDC discovery bootstrap; verifies the document `issuer` equals the configured issuer before any endpoint is trusted | non-HTTPS, issuer mismatch, cross-origin redirect, missing required fields |
| `AuthorizationURL` | Builds the upstream authorize URL the browser is redirected to | missing upstream client, callback, PKCE challenge, state, resource, or a non-`S256` method |
| `ExchangeCode` | Server-side upstream code exchange with the facade's own client and PKCE verifier | non-2xx, missing `access_token`; the upstream error body is never forwarded |
| `Refresh` | Upstream refresh presenting the OAuth client that owns the recorded material | non-2xx, secret-bearing error body never forwarded |
| `ValidateAccessToken` | Reuses the RFC 9728 JWKS/RS256 validator; never mutates the token | issuer/audience/azp/signature/expiry/scope failure |

Every upstream call goes through the same hardened HTTP stack the OIDC discovery and JWKS bootstraps use: a bounded
deadline (10 s default), a 1 MiB response cap, a connect-time SSRF guard that refuses non-public addresses, and a
redirect refusal. There is no separate, unbounded fetch path.

Typed errors map to a closed client-facing vocabulary, so a caller never has to string-match an upstream body:

| `ProviderError` class | Facade HTTP class |
| --- | --- |
| `upstream_error` | 502 |
| `temporarily_unavailable` | 503 (retryable; `Retry-After`) |
| `invalid_grant` | 400 (terminal) |
| `invalid_request` | 400 (adapter-side; never reaches the upstream) |
| `reauth_required` | 400 (terminal; only an explicit upstream stale/replaced signal) |

### Autheory adapter (first adapter)

The adapter is discovery-driven: it takes `authorization_endpoint`, `token_endpoint` and `jwks_uri` from the
verified RFC 8414 document rather than hard-coding them. Two Autheory facts are load-bearing:

- **`resource` is required upstream.** Autheory's authorize endpoint refuses a request without it, so the adapter
  always sends the route's `resource`.
- **Refresh material is bound to the issuing client.** The refresh leg presents the client that owns the recorded
  upstream material (the facade's own client for facade-opened records; the store is the discriminator).

The adapter does not relax Autheory's own policy. In particular `token_endpoint_auth_method=none` public clients
only, and Autheory's application-type-specific DCR redirect policy is stricter than the framework's https-or-loopback
floor — the framework keeps the stricter upstream behavior.

### UNVERIFIED (carried to the lab milestone)

- Whether discovery-driven clients' authorize requests reach Autheory's enforcing Go path (`/auth/authorize`) or only
  the published, render-only `/oauth/authorize` used as the discovery `authorization_endpoint`.
- The exact deployed `AUTHEORY_OAUTH_ISSUER`/`AUTHEORY_JWT_ISSUER` values per stage.

## Store SPI

Five stores, each with an in-memory reference implementation. **Consume-once and compare-and-swap are required
atomic operations, not conventions**: replay handling and single-flight refresh depend on them. Production needs a
**durable** store; the framework does not ship one — durable implementations are application-owned.

| Store | Key | Atomic operations | TTL |
| --- | --- | --- | --- |
| `TransactionStore` | hash(upstream state) | `Put`, `Consume` (single-use) | ≤ 10 min |
| `AuthorizationCodeStore` | hash(facade code) | `Put`, `Consume` (single-use, **retained** after consume so a replay is distinguishable from an unknown code) | ≤ 600 s (60 s recommended) |
| `ClientStore` | hash(client id) | `Put`, `Get`, `Update` (compare-and-swap on version) | none (age-out policy) |
| `RouteRefreshBrokerStore` | hash(route handle) | `Get`, `AcquireLock` (exclusive, expiring), `CompareAndSwap` (versioned), `Revoke` (idempotent, terminal) | ≤ min(upstream refresh lifetime, session lifetime, local policy) |
| `RateLimitStore` | (identifier, resource, operation) | `CheckAndIncrement` (atomic) | window |

Every store takes an injected clock, so TTL expiry and lock expiry are deterministic in tests. The in-memory
reference stores are for **tests and local development only**.

Nothing upstream is persisted unencrypted: the durable upstream refresh token lives in the broker record, and the
code record may hold only the **encrypted** token response, which is what lets the code exchange return the upstream
access token byte-for-byte unmodified.

## Conformance suites and the fake provider

Two shared conformance tables drive all three runtimes from one source (`contract-tests/fixtures/routing/mcp-auth-facade/`):

- `facade-provider-conformance.v1.json` — discovery, authorize-URL construction, code exchange, refresh and token
  validation rows, run against the Autheory adapter and a tiny second adapter (provider-neutrality) over a **real
  local HTTP fake upstream with real RSA keys**.
- `facade-store-conformance.v1.json` — the atomicity rows (single-use consume, replay vs unknown, rotation/CAS, lock
  with expiry, idempotent revoke, rate-limit window) including concurrent-consume/rotate/revoke rows, run against the
  in-memory reference stores.

Any store — the in-memory ones now, an application's durable store later — must pass the store conformance suite. A
fake provider (real RSA keys, real local HTTP, configurable success/error/slow/oversized-filler/oversized-valid-json/
rotated-refresh/missing-iss/bad-signature behaviours) ships in the test-support area for the executed journey tests.
The oversized-valid-json mode serves a well-formed token document whose `access_token` is itself past the cap, so the
response-size bound is observable rather than indistinguishable from a JSON parse failure.

## Where the code lives

| Surface | Go | TypeScript | Python |
| --- | --- | --- | --- |
| Provider SPI + Autheory adapter | `runtime/oauth/provider.go`, `runtime/oauth/provider_autheory.go` | `ts/src/oauth/provider.ts` | `apptheory.oauth.provider`, `apptheory.oauth.autheory` |
| Store SPI + reference stores | `runtime/oauth/store` | `ts/src/oauth/store.ts` | `apptheory.oauth.store` |
| Fake provider (test support) | `testkit/oauthprovider` | `ts/src/testkit/oauthprovider.ts` | `apptheory.oauth.fake_provider` |

The Store SPI is a separate Go package because the package `oauth` already declares the older, narrower
`AuthorizationCodeStore`/`RefreshTokenStore` types. The TypeScript rate-limit key type is exported as
`RateLimitBucketKey` because the TypeScript SDK already exports `limited.RateLimitKey`.

## Non-goals today

No mounted route, no `FacadeConfig` wiring, no authorize/callback/token/DCR/refresh handlers, no CDK change, and no
durable store. Those land in the follow-on facade milestones.
