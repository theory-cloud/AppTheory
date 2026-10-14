# MCP auth facade — design (M0, item 1)

Status: design for review (M0). Not implemented.
Last updated: 2026-10-12
Owner: AppTheory

This is the component model for the **full MCP auth facade**: the AppTheory capability that lets any
implementing system front an upstream auth provider on **one domain**, in Go, TypeScript, and Python, with
jsii CDK bindings, proven by shared fixtures.

It implements the operator rulings of 2026-10-12 (Factory docs/110): the framework must fully support
applications like `theory-mcp-server` (TMS); the facade is provider-neutral with Autheory as the first
provider adapter; v6.0.0 has no consumers, so this is designed as the correct default directly with no
back-compat shims; parity is atomic across Go/TS/Py/CDK.

## 1. Contracts owned by this design

| Contract id | Owns | Supersedes / extends |
| --- | --- | --- |
| `m17.mcp-route-algebra/v2` | Route derivations: MCP patterns, protected-resource, canonical + suffix RFC 8414 discovery, authorize, token, **`/register`**, and the **stage-global upstream callback**; per-route issuer/resource derivation. | `m17.mcp-route-algebra/v1` (v2 is a superset; v1's four patterns and five derivations are unchanged) |
| `m17.mcp-transport-posture/v1` | The transport-route authorization posture vocabulary, the CDK↔runtime posture pairing, and the fail-closed default resolution. | New |
| `m17.mcp-auth-facade/v1` | Facade behavior: front channel termination, upstream callback, facade codes, DCR, brokered refresh, provider SPI, store SPI, validator/challenge model. | New |

Version support for `m17.mcp-route-algebra/v1` is retained as a **read contract**: v2 document/route
inventories are generated from the same algebra and the v1 names remain valid for the additive derivations.
No dual-mode runtime switch is introduced (no shim); v2 is simply the shape the framework emits.

## 2. Component model

```
                     MCP client (Codex / Claude class) — one domain
        discover ─► DCR ─► authorize ─► callback ─► token ─► tool call ─► refresh
             │        │         │            │          │                  │
   ┌─────────▼────────▼─────────▼────────────▼──────────▼──────────────────▼───────────┐
   │  CDK (jsii: TS/Py/Java/C#/Go) — AppTheoryMcpServer + facade route inventory        │
   │  • transportPosture  • derived /register + callback  • throttling  • edge restore   │
   └──────────────────────────────────────────────┬─────────────────────────────────────┘
                                                  │ synth
   ┌──────────────────────────────────────────────▼─────────────────────────────────────┐
   │  Runtime facade (Go / TypeScript / Python) — RegisterMCPFacade / register_mcp_facade │
   │                                                                                     │
   │  Route model (algebra v2)   ── per-route issuer/resource derivation                 │
   │  Transport posture          ── RUNTIME_BEARER pairing, fails registration when broken│
   │  Validator + challenge      ── route-aware context, JWKS/RS256, RFC 9728, RFC 8707  │
   │  Facade mechanics           ── authorize · callback · codes · DCR · brokered refresh │
   │  Provider SPI               ── provider-neutral upstream IdP adapter (Autheory #1)   │
   │  Store SPI                  ── transactions · codes · clients · refresh broker · RL  │
   └──────────────────────────────────────────────┬─────────────────────────────────────┘
                                                  │ SPI calls (HTTPS, deterministic in tests)
   ┌──────────────────────────────────────────────▼─────────────────────────────────────┐
   │  Upstream authorization provider — Autheory (sole AS / token authority for TMS)     │
   └─────────────────────────────────────────────────────────────────────────────────────┘
```

The framework owns **composition and mechanics**; the application owns **policy** (scope vocabulary,
namespace/route policy, tenant admission, legacy-client migration). See `FRAMEWORK_VS_POLICY.md`.

## 3. Route model (`m17.mcp-route-algebra/v2`)

### 3.1 Today

`runtime/mcproutes` (Go) and `cdk/lib/mcp-route-algebra.ts` implement the four canonical patterns and derive
protected-resource, canonical + suffix discovery, authorize, and token paths. There is **no `/register` and no
callback derivation**, and `FacadeConfig.IssuerURL` is a single family-wide value
(`runtime/mcpfacade/facade.go:73`). TMS therefore hand-wires four `/register` routes plus one callback route
and keeps its own copy of the algebra (`contract-tests` gap G2; TMS `cdk/lib/mcp-server-surface.ts:25-42`,
`internal/routing/oauth_discovery_paths.go`).

### 3.2 v2 additions

For each of the four endpoint kinds, v2 derives two more paths, using the same prefix rules as v1:

- `register_path` = canonical discovery path + `/register` → e.g.
  `/.well-known/oauth-authorization-server/{client_namespace}/mcp/register`.
  In `route` issuer mode this is what the routed RFC 8414 document advertises as `registration_endpoint`, so the
  advertised URL and the mounted route cannot drift. In `family` issuer mode the routed document advertises
  `FacadeConfig.RegistrationEndpointURL` re-serialized canonically — https scheme, lowercased authority, default
  port dropped, no userinfo — not byte-for-byte as configured (or omits `registration_endpoint` when it is unset),
  because that document is family-wide and not route-specific; the per-kind derived `/register` routes are still
  mounted, so in `family` mode an advertised `registration_endpoint` can differ from the mounted derived route.
  That difference is deliberate and inert today (registration handlers are application-owned until M3); an app that
  wants the advertised URL to be the derived one selects `IssuerMode: route`, where both are derived from the same
  route algebra and cannot drift. `family` mode's advertised-vs-mounted reconciliation is revisited when DCR lands
  (M3).
- `callback_path` = a **single stage-global** path (default `/_oauth/mcp/callback`), not per kind. The
  callback is correlated by the upstream `state` the facade minted, so one route is sufficient and it keeps the
  API's route/permission surface flat. It is a `FacadeConfig` value (`UpstreamCallbackPath`) so an app can
  choose its own; the default matches the TMS golden path.

### 3.3 Per-route issuer/resource derivation (mandatory in the route model)

`FacadeConfig` gains `IssuerMode`:

| `IssuerMode` | Behavior |
| --- | --- |
| `family` (default) | One `IssuerURL` for the whole facade; routed metadata advertises it. This is the current behavior and stays for single-tenant/root-only deployments. |
| `route` | Each route derives its own issuer = the **absolute route URL**. Routed PRM sets `resource` = route URL and `authorization_servers` = `[route URL]`; routed RFC 8414 sets `issuer` = route URL; `authorization_endpoint`/`token_endpoint`/`registration_endpoint` are the route-derived URLs; `jwks_uri` remains the **upstream** JWKS, because the upstream signs the tokens the route hands to clients. Client-facing authorization responses carry RFC 9207 `iss` = the route URL. |

`route` mode is what makes "each MCP route is its own authorization server" expressible without app-side
algebra. It is required by the THE-2843 client behavior (an RFC 9207-aware client rejects an `iss` that does
not match the issuer it discovered) and by the single-domain requirement.

The absolute route URL is reconstructed from `URLMode` exactly as today (`URLModePublicBaseURL` /
`URLModeRequestHost` with the hostname allowlist), so the derivation has one authority.

## 4. Transport posture (`m17.mcp-transport-posture/v1`)

### 4.1 Vocabulary

The CDK construct's closed two-member enum (`cdk/lib/mcp-server.ts:20-25`, `IAM | JWT`) becomes a
three-member posture selection plus one explicitly-public posture:

| Posture | Gateway | Runtime | Use |
| --- | --- | --- | --- |
| `iam` | AWS_IAM | app | AWS-native callers (SigV4). Unchanged. |
| `jwt` | JWT authorizer (static issuer + audience list) | app | Fixed-issuer/fixed-audience deployments. Unchanged. |
| `runtime-bearer` | `NONE` | **mandatory** RFC 9728 bearer validation | OAuth-bearer MCP servers fronting an auth provider on one domain (TMS class). New. |
| `none-public` | `NONE` | none | Deliberately public MCP servers. Explicit, never a default. |

See `DEFAULT_SEMANTICS.md` (item 3) for the default-resolution recommendation and
`DEFENSE_IN_DEPTH.md` (item 4) for the mandatory floor on `runtime-bearer` / `none-public`.

### 4.2 CDK↔runtime pairing, fail closed

`runtime-bearer` is only sound if the runtime actually validates. The pairing is enforced on both ends:

- **Runtime (registration-time):** `mcpfacade.FacadeConfig` gains `TransportPosture`. When it is
  `RuntimeBearer`, `RequireBearerToken` (or an equivalent explicit posture assertion) must be set; otherwise
  `RegisterMCPFacade` returns an error **before any route is added**. This mirrors the existing all-or-none
  authorize/token gate (`runtime/mcpfacade/facade.go:206-226`, `448-466`).
- **CDK (synth-time):** selecting `runtime-bearer` without the runtime-posture declaration prop throws at
  construct time, and emits a synthesized **conformance marker** the conformance kit reads (see
  `CONFORMANCE_KIT.md`). The existing incompatibilities (`unauthenticatedMcp` with `jwksUri`/legacy auth
  config, `mcp-server.ts:359-371`) are subsumed by the posture selection.
- **TS/Py:** the CDK construct currently assumes the Go helper (`cdk/lib/mcp-server.ts` doc). TS/Py gain their
  own facade **registrar skeletons in M1** — the posture field plus this registration-time fail-closed pairing
  — so the pairing is enforceable in every runtime, not only Go; the facade handler bodies are filled in M3
  (§8).

## 5. Validator + challenge model

### 5.1 Route-aware validator context (parity fix)

Go's validator receives `context.Context`, not the request (`runtime/oauth/bearer.go:23,27`), while TS
(`ts/src/oauth/index.ts:96,101`) and Python (`py/src/apptheory/oauth/__init__.py:163,164`) already receive the
route-aware AppTheory context. Parity requires Go to match:

- Go validator types become `func(ctx *apptheory.Context, token string) error` and
  `func(ctx *apptheory.Context, token string) (*BearerTokenClaims, error)`.
- All three runtimes additionally accept **route-derived** validator inputs:
  `RequiredAudience func(*Context) (string, error)` and `RequiredScopes func(*Context) ([]string, error)`,
  so per-route audience (audience = the exact route URL) is expressible in every language.

### 5.2 JWKS/RS256 validator with OIDC discovery bootstrap

No JWT/JWKS validator ships today (gap G4). The facade adds one, in all three runtimes:

- **Discovery bootstrap:** fetch the upstream OIDC discovery document once, verify its `issuer` equals the
  configured upstream issuer (canonicalized), and take `jwks_uri` + endpoints from it. Fail closed on
  mismatch, non-HTTPS, redirect to a different host (see `THREAT_MODEL.md` §SSRF), or missing fields.
- **JWKS cache:** keys cached by `kid`; unknown `kid` triggers a bounded refresh with a cooldown; cache
  entries expire.
- **Alg pinning:** accept `RS256` only. Reject `alg: none`, HMAC algorithms, and any key whose type does not
  match an RSA signing key (alg-confusion / key-confusion defense).
- **Claim checks:** issuer pinned (checked before and after signature verification), audience exact-match
  against the route-derived audience, `azp`/`client_id` allow-list with **no wildcards**, scope checks,
  bounded clock-skew leeway. Access tokens issued by the upstream are returned to clients **byte-for-byte
  unmodified**.
- Autheory adapter facts: RS256, `azp`/`client_id` from one client-id variable, `iss` is the stage marker,
  audience exact-match, `id_token` not issued for the relying-party contract.

### 5.3 Challenge model (RFC 9728 / RFC 6750 / RFC 8707)

- **401** for missing / malformed / invalid / expired bearer, with
  `WWW-Authenticate: Bearer resource_metadata="<route metadata URL>"` where the metadata URL is derived from
  the **matched route** (not from an environment variable as today for Go, `bearer.go:194-222`).
- **403** `insufficient_scope` for a scope failure the server actually observed, carrying the scope set that
  remediates it. Any other forbidden denial advertises neither an error code nor a scope set.
- **RFC 8707 resources:** `resource` is accepted at authorize and token, canonicalized, and must equal the
  route resource; the resulting `aud` must exactly equal the route URL. Unsupported resources are refused
  before any upstream call.
- **Multi-spelling bridge:** the framework emits the canonical `www-authenticate` challenge and can bridge
  compatible aliases for edges/proxies that remap headers (TMS emits three spellings:
  `www-authenticate`, `mcp-www-authenticate`, `x-theory-www-authenticate`). The framework's bridge is
  **configurable and off by default**; see `FRAMEWORK_VS_POLICY.md`. Separately from the bridge, the §9
  front-door restoration **always** reads AWS's REST v1 remap artifact
  (`x-amzn-remapped-www-authenticate`), which AWS produces whether or not the alias bridge is enabled.

## 6. Provider SPI (provider-neutral upstream IdP adapter)

One interface per runtime, implemented once per provider. Autheory is the first and only adapter in this
program; the SPI is deliberately the minimum needed to derive the facade from requirements.

```
Discovery(ctx) (*ProviderMetadata, error)
AuthorizationURL(req AuthorizationRequest) (url string, error)
ExchangeCode(ctx, req CodeExchangeRequest) (*TokenSet, error)
Refresh(ctx, req RefreshRequest) (*TokenSet, error)
ValidateAccessToken(ctx, token string, expected TokenExpectations) (*TokenClaims, error)
```

- `ProviderMetadata`: issuer, authorize/token/jwks endpoints, `code_challenge_methods_supported`,
  `authorization_response_iss_parameter_supported` (RFC 9207), `resource_parameter_supported` (RFC 8707).
- `AuthorizationRequest`: upstream client id, callback URL, PKCE challenge (S256), fresh upstream `state`,
  `resource`, clamped scope set, and an opaque `Hints map[string]string` (the `account_id` hint is a hint —
  the provider must derive authentication account context from its own validated binding, not the hint).
- `RefreshRequest`: upstream refresh material and **the OAuth client that owns it** (the facade's own client
  for facade-opened records; the client's own id for pre-facade records).
- `ValidateAccessToken` returns claims; it never mutates the token.
- The SPI returns provider errors mapped to a closed client-facing vocabulary; raw upstream error bodies are
  never forwarded (they may echo hidden material).
- Within that vocabulary an upstream OAuth `invalid_request` maps onto the terminal `invalid_grant` (a
  client-facing 400, not a 502): a facade request bug that reaches the upstream surfaces as a request-class
  error, and only an explicit upstream stale/replaced signal produces `reauth_required`.

Autheory adapter mapping (first adapter): issuer per stage (`https://auth.lab.autheory.app` /
`https://auth.autheory.app`), authorize/token/jwks from RFC 8414 discovery, RFC 9207 `iss` supported, RFC 8707
`resource` supported, no `id_token`, DCR issues `mcp_`-class dynamic clients, refresh is bound to the issuing
client, and an internal client-verify surface (`GET /internal/oauth/clients/{client_id}`) backs legacy adoption.

## 7. Store SPI (durable, pluggable) + in-memory reference stores

Today only Go ships in-memory authorization-code and refresh-token stores (`runtime/oauth/tokens.go:35-167`);
TS/Py ship none, and there is no Persistence SPI. The facade defines five stores, each with a reference
in-memory implementation and a documented durability contract:

| Store | Key | Required atomic operations | TTL |
| --- | --- | --- | --- |
| `TransactionStore` | hash(upstream state) | Put, Consume (single-use) | ≤10 min |
| `AuthorizationCodeStore` | hash(facade code) | Put, Consume (single-use, retained after consume so replay is distinguishable) | ≤600 s (recommend 60 s) |
| `ClientStore` | hash(client id) | Put, Get, Update | none (age-out, not TTL) |
| `RouteRefreshBrokerStore` | hash(route handle) | Get, AcquireLock(version), CompareAndSwap(version), Revoke | ≤ min(upstream refresh lifetime, route/session lifetime, local policy) |
| `RateLimitStore` | (identifier, resource, operation) | CheckAndIncrement | window |

Consume-once and compare-and-swap are **required** operations, not conventions: replay handling (a replayed
facade code revokes the broker record) and single-flight refresh depend on them. A successful `AcquireLock` sets the
broker record's status to **`refreshing`**, the status the shared store-conformance row
`store.route_refresh_broker.acquire_lock_sets_refreshing_status` pins in all three runtimes.

**Encryption of upstream material is a store obligation, not a framework seam.** The durable upstream refresh
token lives in the broker record's `encrypted_upstream_refresh_token` field and the code record carries the
upstream token response in its `encrypted_token_response` field, which embeds the upstream-minted access token (and
any upstream refresh/`id_token` from the exchange) — deliberately, so the code exchange can return the access
token **byte-for-byte unmodified**. The facade performs **no** sealing and the framework adds **no** encryption
surface or key management: it hands the store the upstream material exactly as the provider returned it. A store
implementation **MUST** encrypt every `Encrypted*` field at rest (for example TMS/Autheory persistence-layer
TableTheory `theorydb:"encrypted"` tags on a TableTheory-backed store), so nothing upstream is persisted in the
clear by a conforming implementation. The framework's in-memory reference stores are **NON-DURABLE and do not
encrypt** — they exist for deterministic tests and local development only, and a deployment replaces them with the
application-owned durable stores, which are where the encryption obligation is discharged.

## 8. Facade mechanics (`m17.mcp-auth-facade/v1`)

`RegisterMCPFacade` (Go) / `registerMcpFacade` (TS) / `register_mcp_facade` (Py) mount, per the v2 inventory.
**M1 lands these three signatures as skeleton registrars** — the posture field plus the fail-closed
registration-time pairing of §4.2 — and **M3 fills them with the numbered mechanics below:**

1. `/authorize` (GET) — **front-channel termination.** Validate registered client, exact redirect URI
   (loopback port flexibility only), `response_type=code`, S256 PKCE (mandatory; `plain`/absent refused),
   `state`, `resource`, and scope; record a single-use transaction; redirect the browser upstream with the
   facade's own client/callback/PKCE/fresh state/`resource`/hints/scopes. **Errors raised before the redirect
   URI is validated never redirect** (open-redirect defense).
2. `/callback` (GET) — **upstream callback.** Verify upstream RFC 9207 `iss` **before consuming the state or
   exchanging the code**, consume the upstream `state` single-use, exchange the upstream code server-side,
   validate the upstream token fail-closed, open the broker record, mint a facade code, and redirect the
   client with `code`, the client's own `state`, and `iss` = route URL. An **absent** upstream `iss` is rejected
   in the same `(400, no Location)` class as an `iss` mismatch: verification is decisive before the transaction
   is consumed or the code exchanged, so a callback that omits `iss` fails closed rather than leaving the issuer
   unpinned. The facade never sends the client's `client_id`/`redirect_uri` upstream. An upstream code-exchange
   **failure**, like an upstream **token-validation** failure after a successful exchange, is never returned in
   the same `(400, no Location)` shape as the facade's own callback rejections (`iss` mismatch, unminted `state`,
   an absent code parameter — a *replayed* upstream code arrives with its already-consumed state and takes the
   consumed-state terminal path (fixture step 6.2, `callback-replayed-state`), not a `400`): it is a provider-call
   failure in the gateway class, so it maps to a distinct **502** carrying the fixed error code `upstream_error`
   (error page, no client redirect), while `400` stays the facade's own request-class vocabulary
   (`invalid_client`/`invalid_request`/`invalid_target` at authorize), and keeping the two distinguishable is what
   makes the callback `iss` and `state` pins hold — an implementation that skips either check reaches the exchange
   and changes the fixture's expected result instead of coincidentally reproducing `400`.
3. `/register` (POST) — **RFC 7591 DCR.** Public clients (`token_endpoint_auth_method=none`), https or
   loopback redirect URIs, server-assigned ids ≥128 bits, bound to the advertising route, per-route rate
   limited, hash-stored.
4. `/token` (POST) — **code exchange + brokered refresh.** Facade codes are single-use and bound to
   client/redirect/S256/route; a replay returns `invalid_grant` **and revokes the broker record the code
   minted**. Refresh presents an opaque route handle; the broker record binds issuer/client/subject/resource/
   scope fingerprint and holds the **encrypted** upstream refresh material. Concurrent refresh is
   single-flighted with a lock, coalescing, and a bounded grace response; rotation is atomic. The access token
   is returned byte-for-byte unmodified; `id_token` and upstream refresh material never reach the client.

See `THREAT_MODEL.md` for the control and the pinning test of each mechanic, and `MINIMAL_CONSUMER.md` for the
end-to-end walkthrough that proves scenario (a) by construction.

## 9. CDK model

- `AppTheoryMcpServer` gains `transportPosture` (replacing the `IAM|JWT` enum plus `unauthenticatedMcp`
  semantics) and the runtime-posture declaration prop used for pairing.
- `buildRouteInventory` gains the derived `registerPattern` per MCP pattern and one callback route
  (`cdk/lib/mcp-server.ts:649-675`).
- Session-state, logging, and owning-mode behavior are unchanged. Throttling is **required** under
  `runtime-bearer`/`none-public` (see `DEFENSE_IN_DEPTH.md`); in attach mode the construct cannot create a
  stage, so it fails synth unless the app records the owning API's throttling/lock decision.
- The CloudFront `WWW-Authenticate` restoration edge function (today app-owned in TMS,
  `cdk/lib/public-api-frontdoor.ts:56-82`) becomes a framework front-door concern: a framework construct for
  REST v1 origins that restores the canonical `www-authenticate` header, and is a documented no-op on HTTP API
  v2. The restore **source set** is, in priority order:
  1. **`x-amzn-remapped-www-authenticate`** — the artifact **AWS itself** produces when REST v1 remaps the
     origin's header. This source is **always** consulted and does **not** depend on the optional alias bridge,
     so the construct restores the challenge even for a canonical-only app on REST v1.
  2. the bridge aliases (`x-theory-www-authenticate`, `mcp-www-authenticate`) **only when the optional alias
     bridge** is enabled (`FRAMEWORK_VS_POLICY.md` row 11).
  After restoring, the construct removes the consumed alias/remap headers from the response. TMS restores from
  all three sources today (`cdk/lib/public-api-frontdoor.ts:56-82`, at `origin/staging`); the design keeps AWS's
  own remap artifact in the mandatory set and makes the alias spellings the optional part.

## 10. What this design deliberately does not own

- No authorization-server behavior beyond the client-facing facade: the upstream remains the sole token
  minting authority; the facade never mints, signs, or re-signs end-user access tokens.
- No application policy: scope vocabulary, namespace/route policy, tenant admission, staff entitlements,
  legacy-client adoption, and challenge alias spellings are app/provider policy (`FRAMEWORK_VS_POLICY.md`).
- No durable store implementation: stores are an SPI with reference in-memory implementations.
- No Autheory change: any Autheory-side requirement found here is an open decision for the Autheory steward.
