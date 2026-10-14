# Named threat model — proxy facade (M0, item 5)

Status: threat model for review (M0); T8/T9 control text revised to as-built in M2.1; T1/T2/T3/T4/T6/T7/T10 controls
as-built in M3b-ii (Go/TS/Py); T5 (DCR) as-built in M3c-1a (Go/TS/Py), with the ADV-1144-5/-6 residuals recorded
below; the brokered-refresh half of T2/T6/T7 as-built in M3c-1b (Go/TS/Py), with the operator rulings R1-R4 of
DESIGN §8.4.
Last updated: 2026-10-14
Owner: AppTheory

ADV-P110-2 requires a **named** threat model for the proxy facade. Each row names the attack class, the
framework control, and the conformance test / fixture that pins it. "Pin" means a test that fails if the
control is removed — a fixture with an `expect`, an assertion in the CDK/Go suites, or a validation-only
contract fixture. Controls marked *(policy)* depend on an app-supplied input; the framework still provides the
fail-closed seam.

## Scope and assumptions

- The facade fronts an upstream authorization provider (Autheory first) on one domain.
- Access tokens are minted by the upstream and returned to clients **unmodified**; upstream codes, refresh
  tokens, and `id_token` never reach clients.
- The store SPI provides atomic consume-once and compare-and-swap; a store that cannot do so is a
  misconfiguration the framework cannot paper over (stated as a store contract, not an assumed property).

## Threat table

| # | Threat | Framework control | Pinning test / fixture |
| --- | --- | --- | --- |
| T1 | **`/authorize` open redirect.** An attacker crafts an authorize request whose `redirect_uri` is attacker-controlled, turning the facade into an open redirector (or exfiltrating the code). | Validate the client and the **exact registered redirect URI** (loopback port flexibility only, RFC 8252 §7.3) **before any redirect**. Errors raised before redirect-URI validation render an error page and **never** redirect. An unknown `client_id` returns 400 `invalid_client` with a fixed description and no redirect. | Contract fixture `facade-journey` step `authorize-unregistered-client` (400, no `location`) and `authorize-unmatched-redirect` (error page, no `location`); Go/TS/Py facade fixtures. |
| T2 | **Authorization-code replay.** A captured facade code is exchanged twice; or the upstream code is replayed. | Facade codes are **single-use** (atomic consume); a replay returns 400 `invalid_grant` **and revokes the broker record that code minted**. The upstream `state`/code is consumed single-use, so a replayed upstream code is never re-exchanged. The code record is retained after consume so replay is distinguishable from an unknown code. The same single-use discipline covers refresh **reuse**: a rotated handle re-presented after its grace window revokes the whole grant — the presented record *and every successor it minted* — and answers the same `invalid_grant` an unknown handle gets. | `facade-journey` step `token-replay-code` (400 `invalid_grant`, and a following `refresh` with the revoked handle fails `invalid_grant`); the shared `facade-conformance.v1.json` `refresh` rows `reuse_after_grace_revokes`, `replayed_code_revokes_handle` and `handle_at_another_route_refused` executed in Go/TS/Py, each failing if its control is removed; store contract fixtures for consume-once. |
| T3 | **PKCE downgrade.** A client omits PKCE, or requests `plain`, or a verifier is reused, weakening the code-binding. | `code_challenge` is **required**; `code_challenge_method` must be exactly `S256`; an absent or `plain` request is refused rather than silently treated as S256. The verifier is bound to the code and re-checked at exchange. | `facade-journey` steps `authorize-missing-challenge` and `authorize-plain-challenge` (error redirect, no code) and `token-wrong-verifier` (400 `invalid_grant`). |
| T4 | **Mix-up / confused deputy.** The client is tricked into sending its code to the wrong AS, or an attacker's AS response is accepted; or the facade is confused about which upstream/client it is talking to. | The facade uses its **own upstream client**, a **fresh upstream `state` distinct from the client's `state`**, and its **own PKCE verifier**; the callback verifies the upstream RFC 9207 **`iss`** against the configured upstream issuer **before consuming the `state` or exchanging the code** and rejects a mismatch or an absent `iss`; per-route issuer (`IssuerMode: route`) keeps the client-facing `iss` unambiguous; the upstream state is single-use so a confused response cannot be replayed. | `facade-journey` step `callback-iss-mismatch` (the precondition authorize mints a fresh upstream state **and a valid upstream code**, and the callback presents that minted code + minted state + a mismatched upstream `iss` with no client redirect — the state is valid and the exchange would otherwise succeed, so only the `iss` check, which runs before the transaction is consumed or the code exchanged, can reject) and `callback-absent-iss` (the same minted state and code presented with **no** `iss` parameter: 400 with no client redirect, the transaction is not consumed, and no upstream exchange is attempted — an absent `iss` is rejected in the same class as a mismatch) and `callback-replayed-state` (terminal "already completed", no re-exchange). |
| T5 | **DCR abuse.** An attacker mass-registers clients to exhaust resources, register a malicious redirect URI, or obtain a client bound to another route. | Public clients only (`token_endpoint_auth_method=none`); redirect URIs restricted to **https or loopback**; server-assigned ids ≥128 bits, hash-stored; registration **bound to the advertising route and enforced at both client lookups** — `/authorize` and `/token` accept a DCR-registered client **only at the route it registered at** and refuse it anywhere else with the same non-oracle `400 invalid_client` (no `Location`, and no route named in the response) an unknown client gets, while a pre-registered client whose record carries no bound route stays valid at every route; **per-route rate limit** before work. Unknown JSON members are ignored (RFC 7591). | `facade-journey` steps `register-disallowed-redirect` (400), `register-public-client` (201, its `bound_route` pins the advertising route), and `register-rate-limited` (429 `temporarily_unavailable` + `Retry-After`), re-executed as the shared `facade-conformance.v1.json` `dcr` rows in Go, TypeScript, and Python, whose `bound_route` rows drive the real mounted `/register`, `/authorize`, and `/token` handlers in all three runtimes (`bound_route.dcr_client_at_another_route_is_refused` and `bound_route.dcr_client_at_another_token_route_is_refused` fail if the comparison is removed, `bound_route.pre_registered_client_at_any_route_is_accepted` fails if pre-registered clients are refused); rate-limit store contract fixture. |
| T6 | **Refresh-material leakage.** The upstream refresh token (or `id_token`) leaks to the client, in a response, a log, or an error body. *(Counterpart: deliberate access-token passthrough, which must be preserved.)* | Upstream material is stored **encrypted only**: the durable upstream refresh token in the broker record, and any upstream token material transiently carried in the code record (the encrypted token response) — nothing upstream is stored in the clear; the client receives a framework-minted **opaque handle**; the token response **drops `id_token`** and never forwards raw upstream error bodies (they may echo hidden material); the access token is returned **byte-for-byte unmodified** (the deliberate passthrough, asserted as a positive). As built in M3c-1b, **refresh** upholds the same rule: the rotated successor response carries the upstream access token byte-for-byte plus the framework's own successor handle, and neither the upstream refresh token nor any `id_token` appears in it, in the grace replay, in any error body, or in any redirect; the successor response is held only in the broker record's `encrypted_grace_refresh_response` field, which a conforming store encrypts at rest (DESIGN §7 — the framework performs no sealing, and the in-memory reference stores are non-durable and non-encrypting). That stored response is **retained for the life of the broker record** — until the store's record TTL expires it or a revoke removes it — and is deliberately **not** cleared when the grace window closes, because it is the only link the post-expiry reuse revoke of R1.4 can follow to the successor handle (ADV-1146-1); a durable store encrypts it at rest across that whole lifetime and expires it with the record, never at the grace deadline. | `facade-journey` steps `token-code-exchange` and `token-refresh` assert the presence of `refresh_token` **handle** and the **absence** of `id_token` and any upstream-token shape; the contract `negative_assertions` mirror SAN-110-1 (upstream codes/refresh/`id_token` absent from token and callback responses); the shared `facade-conformance.v1.json` `refresh` rows plus each runtime's capture-and-scan refresh test assert the upstream refresh token and `id_token` never appear in any response, header, redirect, or error body; store contract fixtures pin that no upstream field is persisted unencrypted. |
| T7 | **Audience / resource confusion.** A token minted for one route is accepted at another; `resource` is spoofed; the audience check is loose. | **RFC 8707**: `resource` accepted at authorize and token, canonicalized, and required to equal the route resource; the resulting `aud` must **exactly** equal the route URL (single-entry exact match, no substring/wildcard); audience is validated before any broker mutation and at bearer time. As built in M3c-1b, **refresh** applies the same binding: a present `resource` must equal the bound resource and a present `scope` must be *exactly* the granted set (a wider set and a subset, including a present-but-empty `scope`, are refused), and a handle presented at a route other than the one it was minted for is refused in the same non-oracle `invalid_grant` class an unknown handle gets — so the route binding cannot be bypassed by omitting `resource` and cannot be turned into a handle-existence oracle. | `facade-journey` steps `authorize-wrong-resource` (`invalid_target`) and `transport-wrong-audience` (403); the shared `facade-conformance.v1.json` `refresh` rows `resource_mismatch_refused`, `resource_exact_accepted`, `scope_subset_refused`, `scope_exact_accepted`, and `handle_at_another_route_refused` executed in Go/TS/Py; `oauth`-style bearer fixture already pins audience exact-match. |
| T8 | **SSRF in OIDC discovery / JWKS bootstrap.** The facade is induced to fetch attacker-controlled metadata or keys (open redirect on discovery, hostile `jwks_uri`, non-HTTPS, internal host). | Bootstrap requires **HTTPS**, verifies the discovery document's **`issuer` equals the configured upstream issuer** (canonicalized) before trusting any endpoint, and rejects any discovery/JWKS fetch whose endpoint host is **not a public address**: loopback, link-local (including the `169.254.169.254` metadata address), private, unspecified, and multicast addresses are refused for literal IPs **and** for the addresses a name resolves to **at connect time**, so there is no DNS-rebinding window between the check and the connection. Every fetch is additionally bounded by a 10-second framework timeout. A documented `allowPrivateHosts` override (off by default, never enabled by the framework) exists for local development and the loopback test suites. Endpoints are pinned to the verified issuer. Fail closed on mismatch. | A discovery-bootstrap contract fixture (issuer mismatch → rejected; non-HTTPS → rejected; cross-origin redirect → rejected) plus the shared `host_guard` classification table (loopback, link-local/metadata, private, unspecified, and multicast refused; public addresses allowed) executed in Go, TypeScript, and Python. |
| T9 | **JWKS alg-confusion / cache poisoning.** A key or token using a non-RSA algorithm, `alg: none`, or a poisoned/expired key entry is accepted; a stale key survives rotation; or attacker-chosen `kid` values exhaust memory or amplify key-set fetches. | RS256 **only**; `alg: none` and HMAC algorithms rejected; key type must match an RSA signing key; keys cached by `kid`; unknown `kid` triggers a **bounded** refresh with a **cooldown** under a **global unknown-kid fetch budget** (32 fetches per 60 s by default), so distinct attacker kids cannot amplify token traffic into key-set traffic; kid strings are length-capped (256) and never enter a cache above the cap; the kid-window map and the key cache are bounded (1024 / 128 entries) and evict, so state cannot grow without bound; cache entries expire; issuer is checked before and after signature verification. | JWKS validator fixtures: `alg-none rejected`, `HS256 rejected`, `unknown-kid triggers one refresh`, `expired-key refresh`, `issuer-mismatch rejected`, `oversized-kid refused without a fetch`, `distinct attacker kids are globally bounded`, `evicted kid window allows one refetch`; plus per-runtime assertions that the window map and key cache never exceed their bounds. |
| T10 | **Facade-callback CSRF / session-swap.** An attacker delivers their own upstream `code`/`state` pair to a victim (or to the victim's client), attempting to bind the victim's session to the attacker's upstream authorization (login CSRF), or to have the victim's client redeem the attacker's code. | The facade's upstream `state` is **minted by the facade** and **single-use**, keyed by `hash(upstream state)` in the transaction store: a `state` the facade never minted is rejected (400, no client redirect) and a replayed one is terminal. The callback correlates the transaction to the **registered client** + the client's own `state` + `redirect_uri` + the S256 challenge; the upstream code is exchanged **server-side only** and the facade code is bound to the client's PKCE verifier at `/token`; upstream RFC 9207 `iss` is verified. | `facade-journey` steps `callback-iss-mismatch` (400, no redirect), `callback-replayed-state` (terminal, no re-exchange), `callback-forged-state` (upstream state the facade never minted → 400, no client redirect), and `token-wrong-verifier` (400). The facade's own callback rejections are all `400` with no `Location`, whereas an upstream-code-exchange failure maps to a distinct **502 `upstream_error`** (DESIGN §8.2), so an implementation that skips the `iss` or `state` check reaches the exchange and changes the pinned result instead of coincidentally reproducing `400`. **Residual (client-side):** the standard client `state` + PKCE-verifier binding — an attacker-supplied code cannot be redeemed without the client's verifier, but a client that ignores its own `state` cannot *detect* the swap. Named as a non-claim below. |
| T11 | **Metadata caching / cross-route cache poisoning.** A shared cache or client serves one route's PRM/discovery document for another route, or serves a stale document after the issuer/endpoint set changes; a route-derived document is cached under a family/global key. | Route-derived documents (PRM and RFC 8414 discovery) carry **`cache-control: no-store`**, so a route-specific `issuer`/`resource` is never cached and replayed for another route; in `family` issuer mode a bounded `public, max-age` may be configured instead (that document is not route-specific). The facade **emits its own route-derived document**; it does not proxy the upstream's cacheable discovery verbatim in `route` mode. | `facade-journey` steps `protected-resource-metadata` and `authorization-server-metadata` assert `cache-control: no-store`; the conformance kit Layer B asserts it per route. **Residual:** a client or shared cache that ignores `no-store` is out of framework scope (client/cache behavior); a `family`-mode deployment that overrides `no-store` accepts the standard shared-cache staleness risk. |

## As-built (M3b-ii)

The framework-owned front channel is implemented in Go, TypeScript, and Python and mounts when the front-channel
`FacadeConfig` field set is declared. The controls for **T1, T2, T3, T4, T6, T7, and T10** are now **IMPLEMENTED and
executed** in all three runtimes by the front-channel suites (`runtime/mcpfacade/front_channel_test.go`,
`ts/test/mcpfacade-front-channel.test.mjs`, `py/tests/test_mcpfacade_front_channel.py`), each driving the real provider
adapter over a loopback fake provider with real RSA keys and an injected clock:

- **T1** — the authorize handler validates the registered client and the exact redirect URI before any redirect; an
  unknown `client_id` is `400 invalid_client` and an unmatched `redirect_uri` is `400 invalid_request`, both with no
  `Location`.
- **T2** — facade codes are consumed single-use; a replay returns `400 invalid_grant` **and revokes the broker record
  the code minted** (pinned by the replay and concurrent-redemption tests), and the expired-burn-then-replay path
  revokes it too.
- **T3** — S256 PKCE is required (an absent or `plain` challenge is refused); the verifier is bound to the code and
  re-checked at exchange (`400 invalid_grant`).
- **T4** — the callback verifies the upstream RFC 9207 `iss` **before** consuming the transaction or exchanging the
  code; an absent or mismatched `iss` is rejected without consuming state and without an upstream call.
- **T6** — the token response drops `id_token` and returns the framework-minted opaque handle, never upstream refresh
  material; the callback and token responses are scanned for the upstream code and refresh token. **Residual:** the
  store **MUST** encrypt the `Encrypted*` fields at rest (the framework performs no sealing, and the in-memory
  reference stores neither persist nor encrypt), and the framework never writes upstream material to a log, a redirect,
  a response, or an error body.
- **T7** — `resource` is canonicalized and required to equal the route resource at authorize (`invalid_target`) and the
  code's resource at token.
- **T10** — the upstream `state` is minted by the facade and single-use; a forged state and a replayed state are both
  rejected (`400`, no client redirect), and the callback correlates the transaction to the registered client, the
  client's own `state`, the redirect URI, and the S256 challenge.

**As-built residuals recorded by the M3c-1a paired review (unchanged behavior, deliberately retained).** Both are
consequences of the burn-on-first-consume ordering that keeps a replayed `state`/code indistinguishable from a forged
one (T2, T10), and neither is redeemable by an attacker:

- **Expired-first-consume leaves the broker record alive until its TTL (ADV-1144-5).** In all three runtimes an
  **expired first consume** of a facade code burns the code (`400 invalid_grant`) but does **not** revoke the broker
  record that code minted — only the *replay* path revokes it. Nothing redeemable ever reaches a client on that path
  (the expired consume never returns a code-exchange response, so the framework-minted handle is never disclosed), so
  the only effect is that a broker record whose handle was never handed out lingers to its TTL. Retained as-built:
  revoking on expiry would make the expired path distinguishable from the replay path and weaken the T10 non-oracle
  property.
- **A hostile callback burns a victim's pending transaction (ADV-1144-6).** A callback that presents a **victim's
  valid upstream `state`** together with an attacker's `code` consumes (burns) the victim's pending transaction on the
  first consume — the same first-consume ordering T10 relies on. The attacker gains nothing redeemable: the upstream
  exchange either fails or returns a code the facade binds to the **victim client's** PKCE verifier, which the
  attacker cannot present at `/token`; but the victim's in-flight authorization is burned and must be restarted.
  Recorded as the documented client-side trade-off of T10, not a framework defect.

**Retention residual recorded by the M3c-1b paired review (deliberate, T2/T6/T7).** The broker record's
`encrypted_grace_refresh_response` — the successor token response a rotation produced — is retained for the
**life of the record** rather than cleared when the 30-second grace window closes. This is load-bearing, not a
leak: the record carries no successor-handle field, so that stored response is the only link the whole-grant
revoke of the T2 reuse rule can follow to the successor handle, and clearing it at grace expiry would leave a
live successor behind after a post-expiry reuse. Its content is exactly the successor handle and the upstream
access token that were already returned to that client — never an `id_token` or upstream refresh material — so
retaining it adds no value the store is not already obliged to encrypt at rest (T6): a durable store encrypts it
for the whole lifetime and expires it with the record's TTL, never at the grace deadline. No response path
serves the body once the window has closed (a past-window presentation is refused as reuse before the grace
response is considered), so the retention exists only so the revoke can work.

**T5 (DCR) is implemented and executed in all three runtimes as of M3c-1a**: the per-endpoint-kind `POST …/register`
route is mounted with the front channel, and the shared `facade-conformance.v1.json` `dcr` group drives it through the
real handler — public-client-only metadata, https-or-loopback redirect URIs with no fragment, a server-assigned
≥128-bit client id bound to the advertising route and hash-stored, a per-route rate limit that fails closed, and
unknown JSON members ignored. **The bound route is enforced, not merely stored (M3c-1b):** both client lookups compare
a record's `BoundRoute` with the advertising route resource of the request being served — the same derivation the
registration handler bound the record with — so a client registered through DCR is accepted at `/authorize` and
`/token` **only at the route it registered at**, and anywhere else it is refused with the same non-oracle
`400 invalid_client` (no `Location`, no route named) an unknown client gets; a record that carries no bound route was
pre-registered by the application and is unaffected, staying valid at every route. The shared
`facade-conformance.v1.json` `bound_route` group executes that comparison through the real mounted handlers in all
three runtimes. **T8/T9** carry their as-built M2.1 controls, and **T11** is unchanged.

**The brokered refresh grant is implemented and executed in all three runtimes as of M3c-1b**, completing the
`refresh_token` half of T2/T6/T7 with all of its controls from the first commit that enables it: the token endpoint's
`refresh_token` grant redeems a handle the code exchange minted, rotates it to a fresh opaque handle, and is
single-flighted under a broker-store lock (exactly one upstream refresh call per rotation however many callers
present the same handle); a caller that loses the lock race waits a bounded time and is served the winner's successor
tokens or a `503 temporarily_unavailable` with `Retry-After`; a 30-second grace window replays the *same* successor
tokens byte-for-byte so a lost response does not cost the client its grant; a previous handle re-presented after that
window is reuse and revokes the whole grant (the presented record and every successor it minted); a missing,
locally-expired, revoked, wrong-client, or wrong-route handle is one and the same `invalid_grant`, and a scope or
resource that is not exactly the recorded/bound value is refused; the upstream access token is returned
byte-for-byte while the upstream refresh token and any `id_token` reach neither the client nor any response, header,
redirect, or error body (capture-and-scan tests); and upstream, store, lock, and clock failures all deny with a
defined typed response rather than falling back to a default. Validation order, coalescing and grace, the constant
values (lock TTL 15 s, grace 30 s, wait cap 3 s, handle bound 512 bytes), and the scope/resource rule are the
operator rulings R1-R4 recorded as-built in DESIGN §8.4. Every one of these controls is executed as the shared
`facade-conformance.v1.json` `refresh` rows in Go/TS/Py plus each runtime's concurrency, injected-clock, and
capture-and-scan tests, and each fails when its control is removed (the mutation tables in the M3c-1b PR).

## Cross-cutting controls

- **Fail closed everywhere:** every rejection path above returns a defined status/error and never degrades to
  a success or to "no challenge".
- **No oracle:** unknown client/code/handle cases use fixed descriptions and do not distinguish "unknown" from
  "used" where that distinction would leak (the code record is retained only to make replay handling correct,
  not to widen the response vocabulary).
- **Bounded vocabularies:** error descriptions are fixed strings; upstream error bodies are never forwarded
  verbatim.
- **No secret in logs/metrics:** bearer material, upstream tokens, and PKCE verifiers never appear in logs,
  metrics, or error bodies (see `DEFENSE_IN_DEPTH.md` DD-3 for the bounded denial dimensions).

## What this model does not claim

- It does not claim the upstream is trusted unconditionally; the facade verifies `iss`, audience, and
  signature on every upstream token before it affects broker state.
- It does not claim protection against a compromised upstream or a compromised store (out of framework
  scope; recorded as an assumption).
- It does not claim to protect a client that ignores its own `state` or leaks its PKCE verifier (T10 residual);
  the facade binds the code, but detecting a callback swap is a client control.
- It does not claim protection against a client or a shared cache that ignores the emitted `cache-control`
  (T11 residual).
- It does not claim that repeated denied requests are rate-limited by the facade itself beyond the DCR bucket;
  that is DD-1/DD-5.
