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
refresh handlers land in the follow-on milestones. No store or provider is reachable from a request today. The
front-channel field set below is declared and validated at registration time, and is validation-only: it mounts
nothing.

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

An upstream OAuth `invalid_request` maps onto the terminal `invalid_grant` (a client-facing 400, not a 502): a
facade request bug that reaches the upstream surfaces as a request-class error, and every other non-2xx —
including an unrecognized upstream error code — is an `upstream_error`.

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
reference stores are **non-durable and do not encrypt**: they are for **tests and local development only**.

**Encryption is a store obligation.** The facade performs no sealing and the framework adds no encryption surface
or key management: it hands the store the upstream material exactly as the provider returned it, which is why one
durable upstream refresh token lives in the broker record and one upstream token response lives in the code record.
A durable store implementation **must** encrypt every `Encrypted*` field **at rest** (for example with
persistence-layer `theorydb:"encrypted"` tags on a TableTheory-backed store), so nothing upstream is persisted in
the clear. The code record keeping the (encrypted) upstream token response is deliberate: it is what lets the code
exchange return the upstream access token byte-for-byte unmodified. The in-memory reference stores above neither
persist nor encrypt and must not be used as a durable store.

## Front-channel configuration

The framework-owned front channel — the `/authorize` terminator, the stage-global upstream callback, and the
`/token` authorization-code grant of DESIGN §8 — is declared by one new `FacadeConfig` field set. **Declaring and
validating that set is all this change does**: registration fails closed on an incomplete or contradictory set, but
nothing reads the fields yet — no front-channel route is mounted and no provider or store method is invoked from a
request. The routes and the mechanics land later in this same program.

| Field (Go / TS / Python) | Purpose | Default | Validation | Fail-closed rule | Demanded by |
| --- | --- | --- | --- | --- | --- |
| `Provider` / `provider` / `provider` | Anchors the framework-owned front channel: with it set AppTheory owns `/authorize`, the stage-global callback, and the `/token` authorization-code grant | absent — the front channel stays unowned, and the app either supplies its own handler factories or registers no OAuth surface | none (an interface value) | **All-or-none set:** setting any other front-channel field while `Provider` is absent is a registration error naming that field | DESIGN §8; DESIGN §8.1 |
| `Stores` / `stores` / `stores` | The five store SPIs the front channel persists through: transaction, authorization code, client, route-refresh broker, rate limit | absent | all five must be non-nil; a missing store fails closed rather than degrading | Registration error naming every missing store (`… requires all five stores; missing Transaction, RateLimit`) | DESIGN §7 |
| `UpstreamClientID` / `upstreamClientID` / `upstream_client_id` | The facade's own upstream client registration: sent on the upstream authorize request and presented on the server-side code exchange, **and** the expected `azp`/`client_id` of a validated upstream access token | empty | non-blank, well-formed Unicode, no NUL | Registration error (`… upstream client id is required and must be well-formed`) | DESIGN §8.1; DESIGN §5.2, §6 |
| `UpstreamIssuer` / `upstreamIssuer` / `upstream_issuer` | The expected upstream issuer: the RFC 9207 `iss` the callback pins before consuming the transaction or exchanging the code, and the issuer `Discovery` must verify before any published endpoint is trusted | empty | absolute HTTPS URL, no query, no fragment, normalized like `IssuerURL` | Registration error (`… upstream issuer must be an absolute HTTPS URL without query or fragment`) | DESIGN §8.2; DESIGN §5.2, §6 |
| `LifecycleScopes` / `lifecycleScopes` / `lifecycle_scopes` | Scope values added to every upstream authorize request but never required from the MCP client (for example `offline_access`) | absent — adds none | each value trimmed, non-empty, and well-formed Unicode; duplicates collapse | Registration error (`lifecycle scope values cannot be empty` / `… must be well-formed Unicode`) | FRAMEWORK_VS_POLICY row 7 |
| `ProviderHints` / `providerHints` / `provider_hints` | The opaque per-request hint seam for one authorize request (for example `account_id`); a hint carries **no authority** | absent — contributes no hints | none at registration (the function is opaque); a returned error is a request-class rejection, never a redirect | Registration error when set without `Provider` | DESIGN §6 |

Every rejection uses the runtime's existing configuration-error prefix and the same message body (`mcpfacade: …`
in Go, `AppTheoryMcpFacade: …` in TypeScript and Python).

The reasoning behind the shape, because each of these was a reviewer question:

- **`Provider` is the anchor.** The front-channel field set is all-or-none: a `Provider` without the rest is
  incomplete (fail closed), and the rest without a `Provider` is dead configuration (fail closed). There is no
  "partially owned" front channel that half-registers.
- **The five stores carry no TTL here.** Each store owns its own TTL — ≤10 min for a transaction, ≤600 s for an
  authorization code, age-out (not TTL) for a client, `min(upstream refresh lifetime, session lifetime, local
  policy)` for the broker, and a window for the rate limiter — so the facade configures none (DESIGN §7 TTL
  column). The injected clock that makes those TTLs deterministic is the store's own concern.
- **`UpstreamClientID` is both identities on purpose.** It is the client the facade presents upstream *and* the
  expected `azp`/`client_id` of an upstream access token the facade validates (DESIGN §5.2, §6), so there is no
  separate audience/`azp` field: a token minted for another client is refused against the same value.
- **`UpstreamIssuer` is the upstream issuer, not the client-facing one.** It is the RFC 9207 `iss` the callback
  pins and the issuer `Discovery` verifies (DESIGN §5.2, §8.2). The client-facing issuer is a different value —
  `IssuerURL` in family mode, the route URL in route mode — and the two are deliberately distinct.
- **There is no upstream callback-URL field.** The callback URL is derived from `URLMode`/`PublicBaseURL` plus
  `UpstreamCallbackPath` (DESIGN §3.2), so an absolute callback URL is never configured and the derived URL cannot
  drift from the mounted stage-global callback route.
- **`LifecycleScopes` is the injectable lifecycle scope** of FRAMEWORK_VS_POLICY row 7 (the `offline_access`
  injection): the framework exposes it as configuration rather than hard-coding the literal, so the scope
  vocabulary stays application policy.
- **`ProviderHints` is the DESIGN §6 opaque hint seam** (the `account_id` hint). It carries no authority: the
  provider derives authentication account context from its own validated binding, never from the hint.
- **The application-owned factories are mutually exclusive with a `Provider`.** `Provider` owns the authorize,
  token, and callback routes, so configuring `AuthorizeHandler`/`TokenHandler` or `CallbackHandler` alongside it is
  a registration error rather than a silently dropped or double-mounted route. (A lone one of the
  authorize/token pair is already rejected by the pre-existing all-or-none factory rule.)

**The framework issues no facade token and needs no signing key.** The access token a client receives is the
upstream token returned byte-for-byte unmodified, and the facade's own authorization code is an opaque value — not
a signed or self-describing artifact (DESIGN §8.4, §10). So there is no signing-key configuration anywhere in this
field set: there is nothing for the framework to mint or verify with a key of its own.

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

No mounted route, no behavior behind the declared front-channel field set, no authorize/callback/token/DCR/refresh
handlers, no CDK change, and no durable store. The front-channel fields are declared and validated at registration
time, but no route reads them yet; the routes and mechanics land later in the facade milestones.
