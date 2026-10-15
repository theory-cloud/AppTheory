---
title: MCP Facade Helper
description: Golden-path runtime composition for parameterized MCP endpoints and their OAuth metadata facade (Go, TypeScript, Python).
---

# MCP facade helper

`runtime/mcpfacade` (Go, `RegisterMCPFacade`), `ts/src/mcpfacade.ts` (TypeScript, `registerMcpFacade`), and
`py/src/apptheory/mcpfacade.py` (Python, `register_mcp_facade`) are the runtime composition half of
`m17.mcp-route-algebra/v2`. One call installs the complete per-pattern MCP OAuth facade for the `namespace`,
`partner_namespace`, `agent`, and `partner_agent` endpoint kinds without copying route strings into the application.
All three registrars mount the same routes from the shared route algebra, resolve the same issuer/URL modes and
capabilities, pair the same transport postures, and emit byte-identical metadata documents from the same config.

For every `mcproutes.SupportedEndpointTemplates()` entry, the helper installs:

- `POST`, `GET`, and `DELETE` at the MCP pattern, all served by the application's `MCPHandler`;
- public `GET` RFC 9728 protected-resource metadata at the derived path;
- public `GET` RFC 8414 authorization-server metadata at both the canonical prefix path and suffix-compatible path;
- the derived authorize `GET` and token `POST` routes only when the application supplies both handler factories, or —
  when the front-channel field set is declared — the framework-owned front-channel handlers (see
  [Framework-owned front channel](#framework-owned-front-channel)).

The helper wraps MCP and metadata handlers with the contract parsers. It derives endpoint kind from the normalized
request path, reconstructs discovery identity from `client_namespace`, `partner_id`, and `agent_id` path parameters,
and fails closed when the identity or route shape is invalid. The returned `RouteInventory` references
`mcproutes.ContractVersion` and exposes every derived pattern for inspection.

When `RootAuthorizationServer` is non-`nil`, the same call also installs exactly one static `GET` at
`mcproutes.AuthorizationServerPathForResourcePath("/")`. Root discovery is deliberately not a fifth endpoint kind:
root canonical and suffix discovery collapse to the same path, and the document describes the upstream authorization
server rather than a routed MCP identity.

## P0 is a minimal tier, not a protected one

`TierP0` is the frozen legacy pipeline: it does **not** evaluate route-level transport postures, so mounting the
facade under P0 gets no posture enforcement from the tier. An application that explicitly selects P0 must supply
`RequireBearerToken` or own its transport authentication itself — the facade has no iam/jwt route guard to lean on
there. P0 is the documented minimal tier in all three runtimes (see [HTTP Runtime tiers](http-runtime.md)) and exists
for tightly scoped functions that do their own auth, observability, and shedding. It is **never** a shortcut past the
facade's route guard: the default tier (P2) and `SecureApp` are the paths that evaluate the transport posture and its
defense-in-depth pairing.

## Registration

```go
app := apptheory.New()

inventory, err := mcpfacade.RegisterMCPFacade(app, mcpfacade.FacadeConfig{
    IssuerURL:    "https://accounts.example.com",
    JWKSURI:      "https://accounts.example.com/.well-known/jwks.json",
    URLMode:      mcpfacade.URLModePublicBaseURL,
    PublicBaseURL: "https://mcp.example.com",
    Scopes: map[mcproutes.EndpointKind][]string{
        mcproutes.EndpointKindNamespace:        namespaceScopes,
        mcproutes.EndpointKindPartnerNamespace: partnerNamespaceScopes,
        mcproutes.EndpointKindAgent:            agentScopes,
        mcproutes.EndpointKindPartnerAgent:     partnerAgentScopes,
    },
    MCPHandler: mcpHandler,
    AuthorizeHandler: func(kind mcproutes.EndpointKind) apptheory.Handler {
        return appOwnedAuthorizeHandler(kind)
    },
    TokenHandler: func(kind mcproutes.EndpointKind) apptheory.Handler {
        return appOwnedTokenHandler(kind)
    },
    RootAuthorizationServer: &mcpfacade.RootDiscoveryConfig{
        IssuerURL:                "https://accounts.example.com",
        AuthorizationEndpointURL: "https://accounts.example.com/authorize",
        TokenEndpointURL:         "https://accounts.example.com/token",
        RegistrationEndpointURL:  "https://accounts.example.com/register",
        JWKSURI:                  "https://accounts.example.com/.well-known/jwks.json",
        Scopes:                   rootScopes,
    },
})
if err != nil {
    return err
}
_ = inventory
```

`Scopes` is required for all four kinds; AppTheory never invents application scope policy. `AuthorizeHandler` and
`TokenHandler` are an all-or-none pair. When both are absent and no front-channel field set is declared, the helper
does not register authorize or token paths. When either factory is missing or returns `nil`, registration fails before
any route is added. This avoids exposing a silent public authorization path.

`RootAuthorizationServer` is opt-in. A non-`nil` value must provide every upstream URL and at least one root scope;
otherwise configuration fails before registration. A `nil` value leaves root discovery unregistered. The root
document uses `DefaultCapabilities` and its configured static endpoints; it never derives endpoints from request
headers or from a routed endpoint kind.

AppTheory derives and validates the full internal route inventory before touching the target app. `App` does not
expose route introspection, so a collision with a route that was registered earlier is returned by the strict router
registration guard when encountered instead of escaping as a panic. Routes installed earlier in the same facade call
may remain registered after that error. Applications should register the facade before overlapping application routes
and must discard an app whose registration returned an error.

## Absolute URL modes

Metadata documents need absolute resource, authorization, and token URLs. `URLMode` is mandatory so deployment intent
cannot be guessed.

| Mode | Source | Appropriate deployments |
| --- | --- | --- |
| `URLModePublicBaseURL` | Operator-supplied `PublicBaseURL`, fixed at registration | CloudFront, CDN, front-door, mapped-stage, or split-origin deployments where the Lambda-facing host is not the public authority |
| `URLModeRequestHost` | Scheme and host reconstructed for every request, then enforced against required `AllowedHostnames` | Direct custom domains and tests whose edge-header trust boundary is explicitly controlled |

Public-base mode accepts HTTPS and loopback HTTP URLs but rejects every non-empty path component: the well-known routes
are root-relative, so a pathful base would advertise URLs this facade does not serve. Install-time public-base mode is
the recommended mode for CloudFront, CDN, and other front-door deployments, including the golden consumer.

Request-host mode rejects a simultaneous `PublicBaseURL` and fails configuration when `AllowedHostnames` is empty.
Configuration entries normalize case, trailing dots, and default ports scheme-agnostically. Request authorities
normalize case and trailing dots too, but strip only the request scheme's own default port. Every reconstructed
authority must exact-match a normalized allowlist entry. Missing, unsafe, or non-allowlisted request hosts return HTTP
400. `OriginURL` deliberately gives
`x-apptheory-original-host`, `x-facetheory-original-host`, `x-forwarded-host`, and `Forwarded: host=` precedence over
`Host`. Those forwarding headers are attacker-controlled unless the edge removes viewer-supplied copies and writes
trusted values. **The edge must strip spoofed forwarding/original-host headers.** The allowlist is the enforcement
layer if that boundary is misconfigured: a spoofed higher-precedence header cannot fall back to an otherwise
allowlisted `Host`.

## Metadata defaults and overrides

`DefaultCapabilities` returns the fixed golden-path advertisement inherited from `theory-mcp-server`:

| RFC 8414 field | Default |
| --- | --- |
| `response_types_supported` | `["code"]` |
| `grant_types_supported` | `["authorization_code", "refresh_token"]` |
| `token_endpoint_auth_methods_supported` | `["none"]` |
| `code_challenge_methods_supported` | `["S256"]` |

Non-`nil` `Capabilities` fields replace their corresponding default. Empty lists and blank values fail registration.
The registration endpoint defaults to `IssuerURL + /register` and can be replaced with
`RegistrationEndpointURL`.

Protected-resource documents advertise the absolute concrete MCP resource, `authorization_servers=[IssuerURL]`, the
kind's configured scopes, and `JWKSURI`. Routed authorization-server documents advertise the configured issuer,
registration endpoint and JWKS URI plus public-origin authorize/token URLs derived from the route algebra.
Every protected-resource, routed canonical/suffix, and opt-in root metadata response sets `Cache-Control: no-store`.
It also sets `Vary` over every header consulted by request-origin reconstruction: `Host`, `X-Forwarded-Host`,
`X-AppTheory-Original-Host`, `X-FaceTheory-Original-Host`, `Forwarded`, `CloudFront-Forwarded-Proto`, and
`X-Forwarded-Proto`. The shared routing fixture pins routed document bytes per endpoint kind and URL mode, including
golden rows that exercise HTML-escaping of `&`, `<`, and `>`.

## Authorization plug-point contract

For the application-owned handler factories, AppTheory derives and mounts paths; it does **not** implement authorize
or token behavior. (The framework-owned front channel, below, is the alternative when the application wants the
framework to own those mechanics.) `HandlerFactory` receives the endpoint kind at installation so the application can
attach its tenant-admission bridge, proxy, token validator, refresh coordination, telemetry, and other policy. With an
application-owned surface the helper never issues grants, proxies an authorization server, or chooses scopes.

The helper mounts the MCP transport routes with an authenticated posture by default: a request without a verified
principal is rejected with HTTP 401 and the MCP handler never runs. `FacadeConfig.TransportPosture` selects that posture
explicitly (`TransportPostureIAM`, `TransportPostureJWT`, `TransportPostureRuntimeBearer`, or
`TransportPostureNonePublic`), and registration fails closed when the posture and its required runtime assertion
disagree. Applications that authenticate MCP themselves either configure `FacadeConfig.RequireBearerToken`, which
performs RFC 9728 bearer validation with the correct `WWW-Authenticate` challenge and is valid only with
`TransportPostureRuntimeBearer`, or select `TransportPostureNonePublic` and keep their own middleware around the
supplied handler.

## Framework-owned front channel

The registrars can own the client-facing OAuth mechanics instead of only mounting app-owned routes. Declaring the
**front-channel field set** — `Provider`, `Stores`, `UpstreamClientID`, `UpstreamIssuer`, and optionally
`LifecycleScopes` and `ProviderHints` — makes the framework mount and drive the front channel. The set is all-or-none
and anchored by `Provider`: setting any other front-channel field without a `Provider` is a registration error, and an
incomplete set fails closed. `Provider` is mutually exclusive with the application-owned `AuthorizeHandler`/`TokenHandler`
pair and `CallbackHandler`, because it claims the same routes. The field-by-field table and the fail-closed rules are in
`docs/features/mcp-auth-facade-spi.md` (see its "Front-channel configuration" section).

When the set is declared, each registrar mounts:

- the per-endpoint-kind `GET` authorize terminator at the derived authorize pattern;
- the per-endpoint-kind `POST` token endpoint at the derived token pattern;
- the one **stage-global** callback at the configured `UpstreamCallbackPath` (default `/_oauth/mcp/callback`).

The client journey steps that now work:

1. The client is sent to `GET …/authorize` with its `client_id`, its exact registered `redirect_uri`,
   `response_type=code`, an S256 `code_challenge`, `state`, and `resource`. The facade validates these and redirects the
   browser upstream with its own client, callback, PKCE challenge, fresh state, and clamped scope set.
2. The upstream returns the browser to the stage-global callback; the facade pins the upstream RFC 9207 `iss`, consumes
   the single-use transaction, exchanges the upstream code server-side, validates the upstream token, and redirects the
   client back to its registered redirect URI with a facade code, the client's own `state`, and `iss`.
3. The client redeems the code with `POST …/token` (`grant_type=authorization_code`) and receives the upstream access
   token **byte-for-byte unmodified** plus a framework-minted **opaque refresh handle**.

**Dynamic client registration is mounted.** The registrars mount the per-endpoint-kind `POST …/register` route, so a
request can create a public client (RFC 7591, https-or-loopback redirects, server-assigned ids bound to the
advertising route). The application must still **seed** clients it wants to exist before any request, into the
`ClientStore`, keyed by the store hash helper (`oauthstore.HashKey` in Go, `hashKey` in TypeScript, `hash_key` in
Python) so the facade derives the same key when it looks the client up. A client record carries its registered
redirect URIs and `token_endpoint_auth_method=none` (public clients only).

**Also shipped:** the **`refresh_token` grant** at `POST …/token` — the code-exchange response carries the
framework-minted opaque refresh handle and that handle can be redeemed (single-flight brokered refresh, rotating,
with the framework's 30-second grace replay), as documented in `docs/features/mcp-auth-facade-spi.md`. The **CDK
`facade` attachment is presence-only by design**: its presence selects the `runtime-bearer` posture default and
enables the route derivation and defense-in-depth floor checks, while the provider and the five store SPIs are
runtime `FacadeConfig` wiring (`FRAMEWORK_VS_POLICY.md`), not a construct item. The stage-global callback path
override is wired separately, through the construct's
`upstreamCallbackPath` prop. Transport-route bearer enforcement is unchanged.

## `theory-mcp-server` migration fitness

| Current golden-path behavior | Helper replacement |
| --- | --- |
| `NewApp` loops over four endpoint templates and mounts MCP `POST`/`GET`/`DELETE` | `RegisterMCPFacade` consumes `SupportedEndpointTemplates` and mounts `MCPHandler` for all three methods |
| `NewApp` mounts one path-scoped protected-resource handler per kind | The helper derives the request MCP identity with `ResourcePathFromProtectedResourcePath` plus `ParseMCPPath` and serves RFC 9728 metadata |
| `registerOAuthDiscoveryRoutes` mounts each routed handler at canonical and suffix forms | One generated handler per kind is mounted at both `SupportedOAuthDiscoveryTemplates` paths |
| `registerOAuthDiscoveryRoutes` mounts unscoped root discovery | Optional `RootAuthorizationServer` mounts one static document at the algebra-derived root path |
| Routed discovery rebuilds `EndpointPath` from path params | The helper rebuilds, validates, re-parses, and exact-matches the concrete discovery path before producing metadata |
| `absoluteResourceURL(cfg.PublicBaseURL, path)` builds document URLs | `URLModePublicBaseURL` is the direct replacement; `URLModeRequestHost` is the deliberate direct-host/test alternative |
| `supportedScopesForEndpointKind` supplies app policy | Required `FacadeConfig.Scopes` owns all four per-kind sets |
| Fixed RFC 8414 capability slices | `DefaultCapabilities`, with validated per-field overrides |
| `oauth_facade_routes.go` creates kind-specific authorize/token proxy handlers | `AuthorizeHandler` and `TokenHandler` factories attach application-owned handlers to algebra-derived paths |

## TypeScript and Python registrars

`registerMcpFacade(app, config)` and `register_mcp_facade(app, config)` take the same configuration shape as the Go
`FacadeConfig` (issuer, JWKS URI, optional registration-endpoint override, `issuerMode`, URL mode + public base URL or
allowed hostnames, per-kind scopes, capability overrides, the MCP handler, the all-or-none authorize/token handler
factories, the optional register factory, the optional callback handler, the optional root discovery config, the
transport posture, and the runtime bearer assertion). The derived route tables come from the shared route algebra
(`mcproutes`), so there is no per-language route list to drift.

They mount the MCP transport routes; the RFC 9728 protected-resource metadata route; both canonical and
suffix-compatible RFC 8414 authorization-server metadata routes; the derived authorize/token route shapes (when both
handler factories are supplied, or the framework-owned front-channel handlers when the front-channel field set is
declared); the derived registration route shape (only when a register factory is supplied); the opt-in static root
discovery route; and the single stage-global callback route. Nothing beyond what Go mounts becomes reachable.
Registration fails closed before any route is added: a malformed config or a posture/handler pairing violation raises,
and the `none-public` posture registers no OAuth surface and rejects any OAuth-surface configuration.

Authorize, token, register, and callback behavior stays entirely app-owned under the handler factories: the registrars
own the routes; the application owns the bodies. (Declaring the front-channel field set is the opt-in alternative where
the framework owns the authorize/callback/token bodies.) The metadata documents (protected resource, routed discovery,
root discovery) carry the same field order and the same `Cache-Control: no-store` and `Vary` headers as Go. The shared
contract fixtures pin the routed document bytes per endpoint kind and URL mode for all three runtimes, so those
metadata documents are byte-identical across Go, TypeScript, and Python, including HTML-escaping of `&`, `<`, and `>`
matching Go's `encoding/json`; golden rows that exercise those characters back the claim. `facade-route-model.v1.json`,
`facade-transport-posture.v1.json`, and the route-inventory fixture are consumed by the Go, TypeScript, and Python
suites alike. The framework-owned front channel (authorize/callback/token mechanics, code-store single-use and
replay→revoke, and wiring the provider and store SPIs into the facade config) is now implemented in all three runtimes
and mounts when the front-channel field set is declared — see [Framework-owned front channel](#framework-owned-front-channel).
Still scheduled for a follow-up milestone: dynamic client registration, the brokered refresh grant, and the CDK facade
wiring.

## Non-goals

- no authorize/token behavior, grant issuance, upstream proxying, admission, or scope-selection logic **except the
  framework-owned front channel described above**: with the front-channel field set declared, the framework owns the
  authorize/callback/token mechanics; otherwise the registrars mount the routes and applications own the bodies;
- no DCR handler (`/register` is app-owned until the framework DCR handler lands) and no brokered `refresh_token`
  grant — the code-exchange response carries the opaque refresh handle, but the grant answers `unsupported_grant_type`
  until the follow-on milestone;
- no fifth/root endpoint kind or routed root authorization facade;
- no CDK wiring or jsii/CDK-Go regeneration in this change;
- no alternative route registration or private route strings outside `runtime/mcproutes`.
