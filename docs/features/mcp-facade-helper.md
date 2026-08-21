---
title: Go MCP Facade Helper
description: Golden-path Go runtime composition for parameterized MCP endpoints and their OAuth metadata facade.
---

# Go MCP facade helper

`runtime/mcpfacade` is the Go runtime composition half of `m17.mcp-route-algebra/v1`. One
`RegisterMCPFacade` call installs the complete per-pattern MCP OAuth facade for the `namespace`, `partner_namespace`,
`agent`, and `partner_agent` endpoint kinds without copying route strings into the application.

For every `mcproutes.SupportedEndpointTemplates()` entry, the helper installs:

- `POST`, `GET`, and `DELETE` at the MCP pattern, all served by the application's `MCPHandler`;
- public `GET` RFC 9728 protected-resource metadata at the derived path;
- public `GET` RFC 8414 authorization-server metadata at both the canonical prefix path and suffix-compatible path;
- the derived authorize `GET` and token `POST` routes only when the application supplies both handler factories.

The helper wraps MCP and metadata handlers with the contract parsers. It derives endpoint kind from the normalized
request path, reconstructs discovery identity from `client_namespace`, `partner_id`, and `agent_id` path parameters,
and fails closed when the identity or route shape is invalid. The returned `RouteInventory` references
`mcproutes.ContractVersion` and exposes every derived pattern for inspection.

When `RootAuthorizationServer` is non-`nil`, the same call also installs exactly one static `GET` at
`mcproutes.AuthorizationServerPathForResourcePath("/")`. Root discovery is deliberately not a fifth endpoint kind:
root canonical and suffix discovery collapse to the same path, and the document describes the upstream authorization
server rather than a routed MCP identity.

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
`TokenHandler` are an all-or-none pair. When both are absent, the helper does not register authorize or token paths.
When either factory is missing or returns `nil`, registration fails before any route is added. This avoids exposing a
silent public authorization path.

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
Every reconstructed authority must exact-match an allowlist entry, case-insensitively and after trailing-dot/default-
port normalization. Missing, unsafe, or non-allowlisted request hosts return HTTP 400. `OriginURL` deliberately gives
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
`X-Forwarded-Proto`. The shared routing fixture pins routed document bytes per endpoint kind and URL mode.

## Authorization plug-point contract

AppTheory derives and mounts paths; it does **not** implement authorize or token behavior. `HandlerFactory` receives the
endpoint kind at installation so the application can attach its tenant-admission bridge, proxy, token validator,
refresh coordination, telemetry, and other policy. The helper never validates credentials, issues grants, proxies an
authorization server, or chooses scopes.

The MCP handler is likewise application-owned. Applications that authenticate MCP inside middleware keep that
middleware around the supplied handler. This composition helper does not create a second authentication chain.

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

## Non-goals

- no authorization, token issuance, proxying, admission, refresh, or scope-selection logic;
- no fifth/root endpoint kind or routed root authorization facade;
- no CDK wiring or jsii/CDK-Go regeneration in this change;
- no TypeScript or Python runtime helper in docs/061 change 4;
- no alternative route registration or private route strings outside `runtime/mcproutes`.
