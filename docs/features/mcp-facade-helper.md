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

## Absolute URL modes

Metadata documents need absolute resource, authorization, and token URLs. `URLMode` is mandatory so deployment intent
cannot be guessed.

| Mode | Source | Appropriate deployments |
| --- | --- | --- |
| `URLModePublicBaseURL` | Operator-supplied `PublicBaseURL`, fixed at registration | CloudFront, CDN, front-door, mapped-stage, or split-origin deployments where the Lambda-facing host is not the public authority |
| `URLModeRequestHost` | Scheme and host reconstructed for every request with AppTheory's canonical forwarded/original-host rules | Direct API Gateway custom domains, Lambda URL tests, and deployments intentionally serving several request hosts |

Public-base mode accepts HTTPS and loopback HTTP URLs and preserves a configured base path. Request-host mode rejects a
simultaneous `PublicBaseURL`; it accepts HTTPS origins and loopback HTTP only. Missing or unsafe request hosts fail the
metadata request closed. A front door or CDN should not use request-host mode: install-time `PublicBaseURL` is what
prevents an internal API Gateway authority from leaking into documents.

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
| Routed discovery rebuilds `EndpointPath` from path params | The helper rebuilds, validates, re-parses, and exact-matches the concrete discovery path before producing metadata |
| `absoluteResourceURL(cfg.PublicBaseURL, path)` builds document URLs | `URLModePublicBaseURL` is the direct replacement; `URLModeRequestHost` is the deliberate direct-host/test alternative |
| `supportedScopesForEndpointKind` supplies app policy | Required `FacadeConfig.Scopes` owns all four per-kind sets |
| Fixed RFC 8414 capability slices | `DefaultCapabilities`, with validated per-field overrides |
| `oauth_facade_routes.go` creates kind-specific authorize/token proxy handlers | `AuthorizeHandler` and `TokenHandler` factories attach application-owned handlers to algebra-derived paths |

**Fitness gap outside the accepted per-pattern scope:** current `theory-mcp-server` also registers the unscoped root
`GET /.well-known/oauth-authorization-server` document. That path is explicitly outside the
`m17.mcp-route-algebra/v1` route-family contract and is not composed by this helper. The docs/061 change-7 migration
must retain or separately resolve root issuer discovery; it cannot claim deletion of every root-discovery registration
through `RegisterMCPFacade` alone.

## Non-goals

- no authorization, token issuance, proxying, admission, refresh, or scope-selection logic;
- no root-level route algebra or root authorization-server discovery;
- no CDK wiring or jsii/CDK-Go regeneration in this change;
- no TypeScript or Python runtime helper in docs/061 change 4;
- no alternative route registration or private route strings outside `runtime/mcproutes`.
