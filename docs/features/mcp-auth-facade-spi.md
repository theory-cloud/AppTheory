---
title: MCP auth facade SPI (provider and store)
description: The provider SPI, the Autheory adapter, the five store SPIs, the in-memory reference stores, and the conformance suites shipped by the MCP auth facade program.
---

# MCP auth facade SPI — provider and store

The MCP auth facade lets an application front an upstream auth provider (Autheory is the first adapter) on one
domain while the upstream stays the sole authorization server and token authority. This page documents the two
service-provider interfaces the facade is built on and what ships today.

**Status: the SPI layer exists and is consumed by the framework-owned front channel.** The provider SPI, the five
store SPIs, the conformance suites, and the fake provider are implemented in Go, TypeScript, and Python. When the
front-channel field set below is declared, the three registrars (`RegisterMCPFacade` / `registerMcpFacade` /
`register_mcp_facade`) **mount the client-facing front channel** and drive the provider and the stores from a request:
the per-endpoint-kind `GET …/authorize` terminator, the one stage-global `GET /_oauth/mcp/callback`, and the
per-endpoint-kind `POST …/token` `authorization_code` grant. Nothing outside that field set becomes reachable, and with
`Provider` absent the facade owns no OAuth surface — the application either supplies its own handler factories or
registers none, exactly as before.

Mounted: the per-endpoint-kind `POST …/register` RFC 7591 dynamic-client-registration route. Not mounted or answered
yet: the `refresh_token` grant at `/token` (the code-exchange response already carries a framework-minted opaque
refresh handle, but that handle cannot be redeemed yet), and the CDK `facade` wiring. See "What the front channel does"
below.

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
| DCR mechanics (RFC 7591 validation, https-or-loopback redirect enforcement, server-assigned ≥128-bit client ids, per-route rate limit, bound-route binding, hash-stored record) | Framework |
| DCR redirect allow-list policy **beyond** the framework's https-or-loopback floor, legacy-client adoption | Application |

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

**The JWKS key-set fetch is coalesced in Go and TypeScript, but not in Python.** The Go and TypeScript validators
single-flight concurrent key-set fetches for one validator, so validations that miss the key cache at the same moment
share a single upstream fetch. The Python validator does not coalesce: every concurrent unknown-`kid` validation
performs its own key-set fetch. Each of those fetches is still independently bounded by the same 10-second deadline and
still charges the same global unknown-`kid` fetch budget, so the difference is upstream request volume, not the bound
and not the accept/reject decision.

**`Refresh` must honor the deadline.** The framework's own adapter calls `Refresh` through that hardened stack, so
the 10-second deadline bounds the upstream call it makes. An implementer's `Refresh` (or a durable store that backs
the lock) must not ignore it: the broker refresh lock's TTL is 15 seconds — the 10-second deadline plus a 5-second
margin, a relationship a pin test enforces — so an upstream call that runs past the deadline lets the lock expire and
a second caller acquire it, admitting a second concurrent upstream refresh. The rotation stays safe even then: it
completes with a versioned compare-and-swap on the broker record, so exactly one winner lands and the loser discards
the successor it minted (or answers `503`), and no success is ever returned for state that was not persisted. The
obligation is nonetheless real — honor the deadline so the single-flight guarantee holds at the store and not only at
the compare-and-swap.

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

**At the callback the class table above collapses to one outcome.** When the framework-owned front channel's
callback calls the provider, **any** failure — the server-side `ExchangeCode`, and the `ValidateAccessToken` that
follows it — is mapped to the gateway-class **`502 upstream_error`**, **over** the `ProviderError` class's own HTTP
status: an `ExchangeCode` failure is `502` even when its class table row would say `400`. The class table describes
the typed errors the SPI *produces*; the callback deliberately does not translate an upstream failure into the
facade's own `400` request-class vocabulary (DESIGN §8.2). This is what keeps the callback's RFC 9207 `iss` and
upstream `state` pins non-vacuous: an implementation that skipped either pin would reach the provider call and
change the pinned result instead of coincidentally reproducing a `400`, and the two classes stay distinguishable to
a client.

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

**The grace body is retained for the record's lifetime, not for the grace window.** The broker record's
`EncryptedGraceRefreshResponse` field holds the successor token response a rotation produced — the successor
handle plus the upstream access token that was already returned to that client — and it is the only link the
reuse walk can follow to revoke that successor, because the record carries no separate successor-handle field.
A store must therefore **not** clear the field when the 30-second grace window closes: doing so would truncate
a post-expiry whole-grant revoke to the single presented record and leave the successor live. The field expires
with the record, under the record's own TTL (the broker TTL in the table above), never at the grace deadline,
and a durable store **must** encrypt it at rest for that whole lifetime like every other `Encrypted*` field.
Nothing extra is exposed by keeping it: it adds no material that is not already covered by the encryption
obligation (the successor handle and an access token the client already received).

## Front-channel configuration

The framework-owned front channel — the `/authorize` terminator, the stage-global upstream callback, the
`/token` authorization-code grant, and the `/register` dynamic-client-registration route of DESIGN §8 — is declared by
one `FacadeConfig` field set. **Declaring the set is what mounts the front channel:** with `Provider` set,
registration validates the rest of the set, fails closed on an incomplete or contradictory set, and mounts the four
route shapes driven by the provider and the five stores; with `Provider` absent the front channel stays unowned and no
front-channel field may be set (the `/register` and callback routes then mount only through the application-owned
`RegisterHandler` / `CallbackHandler`).

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

## What the front channel does

When the front-channel field set is declared, the registrars mount three route shapes, and the mechanics behind them
belong to the framework rather than the application.

- **`GET …/authorize` (per endpoint kind) — front-channel termination.** Validation order is client, redirect URI,
  `response_type`, S256 PKCE, `state`, `resource`, scope. A failure before the redirect URI is validated — an unknown
  `client_id` (`400 invalid_client`) or a `redirect_uri` that does not exactly match a registered value (`400
  invalid_request`) — renders a JSON error page and **never** sends a `Location`. Once the redirect URI is validated, a
  later failure (`response_type` other than `code`, absent/`plain`/non-S256 PKCE, a `resource` that is not the route
  resource → `invalid_target`, or a scope request that clamps to nothing) redirects the browser **back to that
  validated redirect
  URI** as `302` carrying the fixed `error`, `error_description`, the client's own `state`, and the client-facing
  RFC 9207 `iss`. On success it records a single-use transaction keyed by `hash(upstream state)` and sends the browser
  upstream with the facade's own client, callback URL, S256 challenge, fresh upstream state, `resource`, hints, and
  clamped scope set.
- **`GET /_oauth/mcp/callback` (one stage-global route).** The callback pins the upstream RFC 9207 `iss` against the
  configured `UpstreamIssuer` **before** consuming the transaction or exchanging the code; an absent or mismatched
  `iss` is `400 invalid_request` with no `Location`. It then consumes the upstream `state` single-use, exchanges the
  code server-side with the facade's own client and PKCE verifier, validates the upstream access token, seeds the
  route-refresh broker with the framework-minted opaque handle and the encrypted upstream refresh material, mints a
  single-use facade code (durable in the code record with the encrypted token response), and redirects the client to
  its registered redirect URI with `code`, the client's own `state`, and `iss` (the route URL in route issuer mode,
  else the configured family issuer). Upstream codes, refresh tokens, and `id_token` never reach the client.
- **`POST …/token` — the `authorization_code` grant.** The grant requires `client_id`, `code`, `redirect_uri`, and
  `code_verifier`; only a registered public client (`token_endpoint_auth_method` empty or `none`) may redeem. The code
  is single-use and bound to that client, that redirect URI, the route kind, and the S256 challenge; a mismatch is
  `400 invalid_grant`. A **replay** returns `400 invalid_grant` **and revokes the broker record the code minted**, so
  the refresh handle from that authorization dies with the replay. An **expired** code burns on its first consume
  (`400 invalid_grant`) and the following attempt is then a replay that revokes the broker record. A `resource` that is
  not the code's resource is `400 invalid_target`. On success the response is `200` carrying the upstream access token
  **byte-for-byte unmodified**, the upstream `token_type`/`expires_in`/`scope`, and the framework-minted **opaque
  refresh handle** as `refresh_token`; it never carries an `id_token` or upstream refresh material.
- **`POST …/token` — the `refresh_token` grant.** The client presents the opaque handle the code exchange returned and
  the same `client_id`. A handle that is unknown, locally expired, revoked, bound to another client, or presented at
  another route's token endpoint is one and the same `400 invalid_grant` (no oracle). A successful refresh rotates the
  handle to a **fresh opaque handle** and answers `200` with the upstream access token **byte-for-byte** plus the
  successor handle; an `id_token` and upstream refresh material never appear in the response, a header, a redirect, or
  an error body. A **present** `resource` must equal the bound resource (`400 invalid_target` otherwise) and a
  **present** `scope` must be *exactly* the granted scope set — a wider set and a subset, including a present-but-empty
  `scope`, are `400 invalid_scope`, because the upstream access token is returned unmodified and cannot be narrowed. A
  missing or over-512-byte handle is `400 invalid_request`. Refresh is **single-flighted** under the broker store's
  lock, so concurrent callers of one handle cause exactly **one** upstream refresh call: a caller that loses that race
  waits up to 3 seconds, then receives the winner's successor tokens or `503 temporarily_unavailable` with
  `Retry-After`. For **30 seconds** after a rotation the **previous** handle replays the same successor tokens
  byte-for-byte (an idempotent lost-response path); after that window the previous handle is **reuse**, which revokes
  the whole grant and answers the same `invalid_grant`. A terminal upstream rejection is `400 invalid_grant` (the
  record is revoked), an upstream gateway failure is `502 upstream_error`, and a transient upstream, store, lock, or
  contention failure is `503 temporarily_unavailable` with `Retry-After`. The grace window, the 3-second coalesce wait
  cap, the 512-byte handle bound, and the broker store's 15-second lock TTL are framework constants — no
  `FacadeConfig` field and no environment variable. The endpoint still answers `400 unsupported_grant_type` for every
  other grant and `400 invalid_request` for an absent grant type.
- **`POST …/register` — RFC 7591 dynamic client registration.** The framework-owned handler bounds and validates the
  client metadata, mints a server-assigned opaque `client_id` (≥128 bits), and stores the record through the
  `ClientStore`, hash-keyed and bound to the advertising route. Only **public clients** are accepted
  (`token_endpoint_auth_method` absent or `none`); `grant_types` (if present) must include `authorization_code` and
  `response_types` (if present) must include `code`; every `redirect_uri` must be an absolute URL with no fragment that
  is either `https` or loopback `http`; unknown JSON members are ignored. Both the raw body and the metadata are
  bounded, and the route is **per-route rate limited** through the `RateLimitStore`, keyed by the advertising route
  kind plus the provider-derived source identity (a shared per-route bucket when no source identity is available, so it
  fails closed to the stricter bucket), with a store or bucket error failing closed too. A refusal is `400` with a
  fixed RFC 7591 error code (`invalid_client_metadata` or `invalid_redirect_uri`); a rate-limited or store-failed
  request is `429` with the fixed code `temporarily_unavailable` and a `Retry-After` header. The `201` response carries
  `client_id`, `client_id_issued_at`, the normalized metadata, and **no `client_secret`** (a public client has none),
  with `cache-control: no-store`.

**Provider failures are their own class.** A provider `AuthorizationURL` / `ExchangeCode` / `ValidateAccessToken`
failure is never returned in the facade's `400` vocabulary: it is a distinct **`502`** carrying the fixed error code
`upstream_error` (error page, no client redirect), so the facade's own request-class rejections and a gateway-class
upstream failure stay distinguishable. The client-facing error vocabulary is closed and fixed — every rejection of one
error code carries the same `error_description` — so the response never distinguishes an unknown key from a used one.

**Encryption is still a store obligation.** The front channel hands each store the upstream material it must protect
and relies on the store to seal it: a durable store **must** encrypt every `Encrypted*` field at rest, and the
framework never writes upstream material to a log, a redirect, a response, or an error body.

**The JSON bodies are semantically identical across runtimes, not byte-identical.** The token and error bodies are
JSON encoded by each runtime's own encoder: Go's `encoding/json` HTML-escapes `&`, `<`, and `>` as `\u0026`,
`\u003c`, and `\u003e`, while the TypeScript (`JSON.stringify`) and Python (`json.dumps(..., ensure_ascii=False)`)
runtimes emit those characters raw. Every form decodes to the same values, and the grace replay is byte-identical
**within** one runtime (which is what the 30-second replay requires); no cross-runtime byte equality is promised, so
a cross-language golden comparison must normalize or compare decoded values, never raw bodies.

## Conformance suites and the fake provider

Three shared conformance tables drive all three runtimes from one source (`contract-tests/fixtures/routing/mcp-auth-facade/`):

- `facade-provider-conformance.v1.json` — discovery, authorize-URL construction, code exchange, refresh and token
  validation rows, run against the Autheory adapter and a tiny second adapter (provider-neutrality) over a **real
  local HTTP fake upstream with real RSA keys**.
- `facade-store-conformance.v1.json` — the atomicity rows (single-use consume, replay vs unknown, rotation/CAS, lock
  with expiry, idempotent revoke, rate-limit window) including concurrent-consume/rotate/revoke rows, run against the
  in-memory reference stores.
- `facade-conformance.v1.json` — the front-channel behavior rows executed through the real mounted handlers: the RFC
  9207 `iss` pin, the loopback redirect match, the bounded strict `/token` form parse, the method-mismatch rule, the
  RFC 7591 DCR (`dcr`) rows, the DCR route binding (`bound_route`) rows, and the brokered refresh (`refresh`) rows
  (rotation, the grace replay, reuse-after-grace revocation, the byte-identical refusal set, the scope/resource rule,
  the handle bound, replayed-code revocation, and the upstream terminal/transient failures).

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
| Framework-owned front channel | `runtime/mcpfacade/front_channel.go`, `runtime/mcpfacade/front_channel_config.go`, `runtime/mcpfacade/dcr.go` | `ts/src/mcpfacade.ts` (front-channel section) | `apptheory.mcpfacade` (front-channel section) |
| Store key derivation | `oauthstore.HashKey` | `hashKey` | `hash_key` |
| Fake provider (test support) | `testkit/oauthprovider` | `ts/src/testkit/oauthprovider.ts` | `apptheory.oauth.fake_provider` |

The Store SPI is a separate Go package because the package `oauth` already declares the older, narrower
`AuthorizationCodeStore`/`RefreshTokenStore` types. The TypeScript rate-limit key type is exported as
`RateLimitBucketKey` because the TypeScript SDK already exports `limited.RateLimitKey`.

**The store-key helper is intended public API.** `oauthstore.HashKey` / `hashKey` / `hash_key` — the unpadded
base64url SHA-256 of the protected value — is ratified as supported public surface, not an internal detail. Every
store SPI is keyed by the hash of the value it protects and never by the value itself, so this helper is the seam
an application uses to **pre-register a client** while DCR is unmounted (and, once DCR lands, to reconcile a client
it already knows through another path). It is a pure, authority-free derivation: it only reproduces the key the
facade itself derives when it looks a record up, and it grants no access of its own.

## Non-goals today

Still absent, by milestone:

- **CDK wiring:** no `cdk/**` change; the construct's `facade` attach prop does not yet wire the provider and stores or
  the callback-path override (Wired by the follow-on milestone M3c-2).
- **A subset-accepting refresh scope:** not built and not planned. A present `scope` on a refresh must be exactly the
  granted set (ruling R4); the facade cannot narrow an upstream access token it returns byte-for-byte.
- **A durable store:** the framework still ships none. The in-memory reference stores are non-durable and do not
  encrypt; a deployment supplies a durable store that discharges the encryption obligation above.
- **Transport-route bearer enforcement** is unchanged (M1/M2).
