# Named threat model — proxy facade (M0, item 5)

Status: threat model for review (M0).
Last updated: 2026-10-12
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
| T2 | **Authorization-code replay.** A captured facade code is exchanged twice; or the upstream code is replayed. | Facade codes are **single-use** (atomic consume); a replay returns 400 `invalid_grant` **and revokes the broker record that code minted**. The upstream `state`/code is consumed single-use, so a replayed upstream code is never re-exchanged. The code record is retained after consume so replay is distinguishable from an unknown code. | `facade-journey` step `token-replay-code` (400 `invalid_grant`, and a following `refresh` with the revoked handle fails `invalid_grant`); store contract fixtures for consume-once. |
| T3 | **PKCE downgrade.** A client omits PKCE, or requests `plain`, or a verifier is reused, weakening the code-binding. | `code_challenge` is **required**; `code_challenge_method` must be exactly `S256`; an absent or `plain` request is refused rather than silently treated as S256. The verifier is bound to the code and re-checked at exchange. | `facade-journey` steps `authorize-missing-challenge` and `authorize-plain-challenge` (error redirect, no code) and `token-wrong-verifier` (400 `invalid_grant`). |
| T4 | **Mix-up / confused deputy.** The client is tricked into sending its code to the wrong AS, or an attacker's AS response is accepted; or the facade is confused about which upstream/client it is talking to. | The facade uses its **own upstream client**, a **fresh upstream `state` distinct from the client's `state`**, and its **own PKCE verifier**; the callback verifies the upstream RFC 9207 **`iss`** against the configured upstream issuer and rejects a mismatch; per-route issuer (`IssuerMode: route`) keeps the client-facing `iss` unambiguous; the upstream state is single-use so a confused response cannot be replayed. | `facade-journey` step `callback-iss-mismatch` (rejected, no client redirect) and `callback-replayed-state` (terminal "already completed", no re-exchange). |
| T5 | **DCR abuse.** An attacker mass-registers clients to exhaust resources, register a malicious redirect URI, or obtain a client bound to another route. | Public clients only (`token_endpoint_auth_method=none`); redirect URIs restricted to **https or loopback**; server-assigned ids ≥128 bits, hash-stored; registration **bound to the advertising route**; **per-route rate limit** before work. Unknown JSON members are ignored (RFC 7591). | `facade-journey` steps `register-disallowed-redirect` (400), `register-bind-route`, and `register-rate-limited` (429 `temporarily_unavailable` + `Retry-After`); rate-limit store contract fixture. |
| T6 | **Refresh-material leakage.** The upstream refresh token (or `id_token`) leaks to the client, in a response, a log, or an error body. *(Counterpart: deliberate access-token passthrough, which must be preserved.)* | Upstream refresh material is stored **encrypted** in the broker record only; the client receives a framework-minted **opaque handle**; the token response **drops `id_token`** and never forwards raw upstream error bodies (they may echo hidden material); the access token is returned **byte-for-byte unmodified** (the deliberate passthrough, asserted as a positive). | `facade-journey` step `token-response-shape` asserts the presence of `refresh_token` **handle** and the **absence** of `id_token` and any upstream-token shape; a **negative-assertion** fixture mirrors SAN-110-1 (upstream codes/refresh/`id_token` absent from token and callback responses). |
| T7 | **Audience / resource confusion.** A token minted for one route is accepted at another; `resource` is spoofed; the audience check is loose. | **RFC 8707**: `resource` accepted at authorize and token, canonicalized, and required to equal the route resource; the resulting `aud` must **exactly** equal the route URL (single-entry exact match, no substring/wildcard); audience is validated before any broker mutation and at bearer time. | `facade-journey` steps `authorize-wrong-resource` (`invalid_target`) and `bearer-wrong-audience` (403); `oauth`-style bearer fixture already pins audience exact-match. |
| T8 | **SSRF in OIDC discovery / JWKS bootstrap.** The facade is induced to fetch attacker-controlled metadata or keys (open redirect on discovery, hostile `jwks_uri`, non-HTTPS, internal host). | Bootstrap requires **HTTPS**, verifies the discovery document's **`issuer` equals the configured upstream issuer** (canonicalized) before trusting any endpoint, and rejects a discovery/JWKS fetch that redirects to a different origin or resolves to a non-public host; endpoints are pinned to the verified issuer. Fail closed on mismatch. | A discovery-bootstrap contract fixture (issuer mismatch → rejected; non-HTTPS → rejected; cross-origin redirect → rejected). |
| T9 | **JWKS alg-confusion / cache poisoning.** A key or token using a non-RSA algorithm, `alg: none`, or a poisoned/expired key entry is accepted; a stale key survives rotation. | RS256 **only**; `alg: none` and HMAC algorithms rejected; key type must match an RSA signing key; keys cached by `kid`; unknown `kid` triggers a **bounded** refresh with a **cooldown**; cache entries expire; issuer is checked before and after signature verification. | JWKS validator fixtures: `alg-none rejected`, `HS256 rejected`, `unknown-kid triggers one refresh`, `expired-key refresh`, `issuer-mismatch rejected`. |

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
- It does not claim that repeated denied requests are rate-limited by the facade itself beyond the DCR bucket;
  that is DD-1/DD-5.
