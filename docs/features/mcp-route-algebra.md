---
title: MCP Route Algebra
description: Versioned route patterns, derivations, templates, parsers, and builders shared by the Go runtime and CDK.
---

# MCP route algebra

AppTheory contract `m17.mcp-route-algebra/v1` defines one route algebra for namespace, partner-namespace, agent, and
partner-agent MCP endpoints. The independent Go and CDK implementations expose the same ordered endpoint quartet,
normalization rules, OAuth derivations, template enumerations, parser, validation rules, and concrete-path builders.

This is a route contract, not a deployment construct. It lets applications such as `theory-mcp-server` consume
AppTheory-owned patterns instead of maintaining private copies.

## Canonical endpoint patterns

The contract order is significant:

| Kind | MCP pattern |
| --- | --- |
| `namespace` | `/{client_namespace}/mcp` |
| `partner_namespace` | `/{client_namespace}/partners/{partner_id}/mcp` |
| `agent` | `/{client_namespace}/agents/{agent_id}/mcp` |
| `partner_agent` | `/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp` |

OAuth protected-resource paths use `/.well-known/oauth-protected-resource` as a prefix. Canonical RFC 8414 discovery,
authorization, and token paths use `/.well-known/oauth-authorization-server` before the normalized MCP resource path.
The algebra also derives the suffix-compatible discovery form after the resource path.

Inputs are trimmed, forced to an absolute path, duplicate slashes are collapsed, RFC 3986 dot segments are removed,
and a trailing slash is removed except at root. Root derivations return the bare well-known prefix.

## Go runtime

Import `github.com/theory-cloud/apptheory/v3/runtime/routing`. Route constants and `Supported*Templates` cover
pattern-level registration. `ParseMCPPath` returns a validated `EndpointPath`, whose builder methods derive every
concrete MCP and OAuth path.

```go
endpoint, err := routing.ParseMCPPath("/acme/partners/pay/agents/bot/mcp")
if err != nil {
    return err
}
tokenPath, err := endpoint.OAuthTokenPath()
```

## CDK and jsii

Use the static `AppTheoryMcpRouteAlgebra` surface. `AppTheoryMcpEndpointPath` and the three template interfaces are
jsii-compatible data values, so the generated Go CDK binding exposes the same contract.

```ts
const endpoint = AppTheoryMcpRouteAlgebra.parseMcpPath(
  "/acme/partners/pay/agents/bot/mcp",
);
const tokenPath = AppTheoryMcpRouteAlgebra.oauthTokenPath(endpoint);
```

## Non-goals

This additive contract does not define HTTP methods, streaming or gateway-auth flags, authorization scopes or logic,
download/GitHub/grant application routes, or root-level route registrations. It does not add runtime SDK surfaces in
`ts/src` or `py/src`. It does not rewire or alter `AppTheoryMcpServer`, `AppTheoryMcpPaths`, or the existing
`runtime/oauth` constants; integration of those existing surfaces is a separate contract change.
