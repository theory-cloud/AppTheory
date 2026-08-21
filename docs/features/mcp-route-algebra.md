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

Inputs are trimmed over exactly the ASCII code points U+0009 (tab), U+000A (line feed), U+000B (vertical tab),
U+000C (form feed), U+000D (carriage return), and U+0020 (space). No other Unicode whitespace is trimmed. The same
six-code-point definition determines whether an identifier is an empty path segment. Paths are then forced to an
absolute form, duplicate slashes are collapsed, RFC 3986 dot segments are removed, and a trailing slash is removed
except at root. Root derivations return the bare well-known prefix.

Identifier validation rejects `.` and `..` after applying that ASCII-only trim. This deliberately hardens the
contract beyond `theory-mcp-server`'s original reference implementation: distinct endpoint identifiers must not
collapse onto one OAuth protected-resource identity. `theory-mcp-server` adopts this rule when it consumes the
AppTheory contract in docs/061 change 7.

Dot-segment rejection applies to identifier positions within a structurally matched pattern. A path whose scaffolding
literals do not match a pattern is not parsed as that pattern at all, even if normalization later yields the same path.

## Go runtime

Import `github.com/theory-cloud/apptheory/v3/runtime/mcproutes`. Route constants and `Supported*Templates` cover
pattern-level registration. `ParseMCPPath` returns a validated `EndpointPath`, whose builder methods derive every
concrete MCP and OAuth path.

```go
endpoint, err := mcproutes.ParseMCPPath("/acme/partners/pay/agents/bot/mcp")
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

`ParseMCPPath` is intentionally stricter than the original `theory-mcp-server` reference parser. It validates every
recognized identifier segment and rejects whitespace-only and dot-segment identifiers instead of accepting a path
that later normalization could reinterpret as another endpoint kind. This is fail-closed parser behavior, not an
alternate normalization mode.
