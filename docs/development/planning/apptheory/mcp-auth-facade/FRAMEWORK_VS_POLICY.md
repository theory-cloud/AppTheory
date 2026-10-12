# Framework vs policy: per-TMS-mechanic verdict (M0, item 2)

Status: design verdict for review (M0).
Last updated: 2026-10-12
Owner: AppTheory

ADV-P110-3 requires an explicit verdict for every TMS facade mechanic: is it a **framework** requirement (the
framework owns it so the app stops hand-wiring), a **policy** choice the app/provider owns, or **both** (a
framework mechanism with policy inputs)? The target is the **minimal proxy derived from the requirements**,
never a port of TMS code. Requirements are read at TMS `origin/staging` (`6537a053`) and Autheory
`origin/staging` (`2390dd00`).

## Derived requirements (what "single domain, provider sole authority" actually forces)

1. MCP clients see **one domain**: discovery, DCR, authorize, callback, token on the app's origin.
2. The upstream provider is the **sole authorization server and token authority**: the facade never mints,
   signs, or re-signs end-user access tokens.
3. Upstream **authorization codes, refresh tokens, and `id_token` never reach the client**; the upstream
   **access token is returned byte-for-byte unmodified**.
4. The client-facing **issuer is the route URL** and authorization responses carry RFC 9207 `iss` = route
   URL (RFC 9207 §2.4-aware clients reject a mismatched `iss`; THE-2843).
5. Each MCP route owns an **independent OAuth lifecycle**: upstream refresh state is not shared across
   distinct MCP resources.
6. A credential-free request never reaches an application handler; the posture is explicit and fail-closed.

Every mechanic below is judged against those six. A mechanic that only exists because of a TMS product choice,
a TMS migration history, or an AWS deployment scar is **policy**, not framework.

## Verdict table

| # | TMS mechanic (evidence) | Verdict | Framework control | Notes / recommendation |
| --- | --- | --- | --- | --- |
| 1 | Per-route issuer with RFC 9207 `iss` = route URL on the client redirect (`SPEC.md:173-185,251-257`; `facadeClientErrorRedirect` sets `iss`) | **Framework** | `IssuerMode: route` in the route model (§3.3 of `DESIGN.md`); the facade sets `iss` on every client redirect including error redirects | THE-2843 is client-generic, not TMS-specific. This is a requirement, not a choice. |
| 2 | Single-use front-channel transaction; single-use facade codes; **code replay revokes the broker record** (`SPEC.md:222-227`; `oauth_facade_code_exchange.go:52-54,140-182`) | **Both** — invariant is framework, coupling is framework | `TransactionStore` / `AuthorizationCodeStore` consume-once atomic ops; replay path revokes the broker record via the store SPI | Distinct from a plain "invalid_grant on second use". The revocation coupling is part of the contract (contract R8). |
| 3 | Brokered refresh: opaque route handle, encrypted upstream material, lock + coalesce + grace + rotation (`oauth_facade_refresh*.go`, `oauth_route_refresh_broker_store*.go`) | **Mechanism: framework. Tuning: policy.** | `RouteRefreshBrokerStore` (Get/ AcquireLock/ CompareAndSwap/ Revoke); single-flight with coalescing and a bounded grace response; atomic rotation | Lock/coalesce/grace is the **minimal correct** way to serve concurrent refresh without a second upstream call and without leaking the upstream token. The **numbers** (TMS: 3 s wait, 30 s lock, 10 s grace) are design choices — recommend framework defaults plus per-app override, not a TMS-number port. |
| 4 | Upstream refresh material hidden; client presents an opaque handle (`SPEC.md:258-271`) | **Framework** | Broker record holds encrypted upstream material; the token response `refresh_token` is the framework-minted handle; upstream material is never serialized to the client | Requirement 3. The encryption key/store is app infra (store SPI). |
| 5 | Refresh presents "the OAuth client that owns the recorded upstream material" (facade's own client for facade-opened records; else the client's id) (`SPEC.md:272-281`; `oauth_facade_client_identity.go`) | **Both** — framework mechanism, app discriminator | `RefreshRequest` carries the owning client id; the **client store is the discriminator** | Autheory binds refresh material to the issuing client. The facade must not guess; the store tells it. |
| 6 | Route-scope clamp (requested scopes clamped to the route set; `applyScopePolicy(..., true)`) (`oauth_facade_front_channel.go:211-227`) | **Policy** | Framework accepts a per-route allowed-scope function (`Scopes func(*Context) ([]string, error)`) and applies the clamp | The **vocabulary** (`mcp:tools`, `ai.kb.query`, `memory.append`) is TMS product policy; the framework never invents scopes (already the rule for `FacadeConfig.Scopes`). Recommend framework implements the clamp given app scopes. |
| 7 | `offline_access` injection (`applyScopePolicy` injects it) | **Policy** | Framework supports an injectable "lifecycle scope" per facade | `offline_access` is lifecycle-not-entitlement (`autheory-theorymcp-contract.md:130-146`). Recommend framework exposes it as config; do not hard-code the literal. |
| 8 | `account_id` hint forwarded upstream (`oauth_facade_front_channel.go:286-301`) | **Policy (provider hint)** | Provider SPI `AuthorizationRequest.Hints` (opaque map) | Autheory's "tenantless sign-in finish requires exactly one active membership" is an Autheory contract detail. Framework carries an opaque hint; the provider derives account context from its own binding, never from the hint. |
| 9 | DCR rules: public clients only, https/loopback redirects, server-assigned ids ≥128 bits, per-route rate limit, hash-stored (`SPEC.md:214-218`; `oauth_facade_registration.go`) | **Both** — framework endpoint, policy allowlist | Framework implements RFC 7591 + route binding + per-route rate limiting + hash storage; redirect allowlist is a policy input (`DynamicClientRegistrationPolicy`) | The 192-bit id and "per-route anonymous bucket" are TMS choices; the framework requires ≥128 bits and a per-route bucket, and lets the app set the entropy/budget. |
| 10 | Legacy `mcp_` Autheory-direct client adoption: verify-then-commit, loopback-only, age-out (`oauth_facade_legacy_client.go`; `autheory_oauth_client_verifier.go`) | **Policy (migration)** | Framework exposes the seam: an optional `LegacyClientResolver` hook on resolution, called read-only, committed only after all non-mutating checks pass | Pure migration history for pre-facade clients. **Not** a framework requirement; recommend the framework provide the seam and TMS/Autheory own the policy. Named in the design for completeness only. |
| 11 | Challenge three-spelling bridge (`www-authenticate` + `mcp-www-authenticate` + `x-theory-www-authenticate`) (`internal/auth/middleware.go:39,298-314`) | **Policy (compat shim)** | Framework emits the canonical `www-authenticate` challenge; optional alias-emitting bridge is config, **off by default** | Three spellings exist for historical proxy/edge reasons. Recommend framework emit the canonical single header and offer the alias bridge as opt-in for edges that remap; do not make three headers the default. |
| 12 | Edge `WWW-Authenticate` restoration for REST v1 origins (CloudFront origin-response function) (`cdk/lib/public-api-frontdoor.ts:56-82`) | **Framework** (front-door concern) | A framework CDK construct restores the canonical challenge header on origin response for REST v1; documented no-op on HTTP API v2 | Real AWS behavior (REST v1 remaps the header). Belongs to the framework's front-door surface, not each app. |
| 13 | Fail-closed upstream token validation (issuer/audience/azp/subject/scope/fingerprint) + `id_token` stripping (`oauth_facade_token_validation.go`; `oauth_facade_broker.go:19-37`) | **Framework** | JWKS/RS256 validator (§5.2) + facade token-response builder that drops `id_token` and returns `access_token` unmodified | Requirement 3. This is the framework's first real JWT validator (gap G4). |
| 14 | Route-aware RFC 9728 challenge with per-route `resource_metadata` and 403 `insufficient_scope` + scope set (`internal/auth/bearer_verify.go:66-339`) | **Framework** | Validator/challenge model (§5.3); route-derived metadata URL; single canonical challenge | The route-derived metadata is requirement-level; TMS's extra spellings are policy (row 11). |
| 15 | `<none>` root discovery so the origin answers 404 (not API GW 403) (`SPEC.md:183-185`) | **Framework** | Keep the root discovery route public/NONE, as today; the origin decides 404 vs document | Already the framework's behavior; the construct must keep it. |
| 16 | Harness keys, staff entitlements, namespace capabilities, principal/route authorization, telemetry vocabulary (`harness_keys.go`, `staff_entitlements.go`, `secure_resolver.go`, …) | **Policy** | None | TMS/Autheory platform policy. The framework's secure gate is the extension point. |
| 17 | OAuth state tables (clients no-TTL, transactions/codes TTL) on TableTheory (`cdk/lib/oauth-facade-tables.ts`) | **Policy (infra)** | Store SPI with a documented durability contract | The framework requires single-use/CAS semantics; the durable backend is app infra. |
| 18 | SEP-2352 issuer binding: handles are never rebound to a new issuer/client registration; broker issuer stays the stage upstream issuer while the client-facing route issuer is the route URL (`SPEC.md:313-322`) | **Framework** | Broker record persists the upstream issuer; the client-facing issuer is route-derived; a handle never re-binds | The two issuers differing by design is a framework invariant worth pinning. |
| 19 | Concurrency/retry classification: `invalid_grant` reserved for terminal cases; transient contention → retryable 503 + `Retry-After`; only explicit upstream stale/replaced → `reauth_required` (`SPEC.md:293-312`) | **Mechanism: framework. Vocabulary: policy.** | Framework classifies and maps errors; default class map provided, app may extend | Worth owning: it is the difference between "retry" and "re-auth", and a naive mapping strands clients. |

## The minimal proxy derived from requirements

The requirements (six, above) force exactly this minimum, and nothing more:

- a **route model** that can express route-as-issuer (§3.3) and the derived `/register` + callback routes;
- **front-channel termination** with mandatory S256 and a single-use transaction;
- an **upstream callback** with RFC 9207 `iss` verification and server-side code exchange;
- **single-use facade codes** with replay → broker revocation;
- **DCR** bound to the route, rate limited, hash-stored;
- a **brokered refresh** with hidden upstream material, single-flight, and atomic rotation;
- a **fail-closed validator** + **route-derived challenge**;
- a **provider SPI** + **store SPI** so none of the above is hard-wired to Autheory or to one store.

Everything TMS carries beyond this list is policy: scope vocabulary and clamp inputs, `offline_access`,
`account_id` hint semantics, DCR entropy/rate numbers, legacy `mcp_` adoption, challenge spelling aliases,
telemetry vocabulary, durable store choice, and the retry-vs-reauth vocabulary. Those stay with the app and
migrate as **inputs to framework seams**, not as framework code.

## Open decisions surfaced in this document

1. Framework defaults vs app override for refresh lock/coalesce/grace numbers (recommend: framework defaults,
   app override).
2. Whether the framework should ship the challenge alias bridge at all, or only the canonical header plus a
   documented edge-restoration construct (recommend: canonical + edge construct; alias bridge opt-in).
3. Whether legacy-client adoption gets a named framework seam (`LegacyClientResolver`) or stays entirely
   app-side (recommend: seam only; no policy).
