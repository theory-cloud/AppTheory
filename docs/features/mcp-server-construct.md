---
title: MCP Server Umbrella Construct
---

# MCP Server Umbrella Construct

`AppTheoryMcpServer` is the deployment contract for namespace MCP applications. It owns the HTTP API route bundle,
runtime auth configuration, and canonical route paths while the Go runtime owns MCP handling and RFC 9728 discovery.

The boundary is fixed:

- paths are synthesis-time literals;
- the protected resource host comes from the normalized request at runtime;
- the authorization-server issuer and JWKS URI come from install config;
- no namespace prop accepts a protected-resource origin or full resource URL.

That boundary makes unresolved deploy-time hosts safe: CDK never calls `new URL(...)` for the protected resource and
never materializes its origin in the template.

## CDK route and config bundle

```ts
const server = new AppTheoryMcpServer(this, "McpServer", {
  handler,
  authorizationServerIssuer,
  jwksUri,
  // mcpPath: "/mcp", // default; literal path overrides are supported
});
```

Supplying `authorizationServerIssuer` and `jwksUri` together enables:

- `POST /mcp` (or the literal `mcpPath` override);
- public `GET /.well-known/oauth-protected-resource`;
- public path-scoped `GET /.well-known/oauth-protected-resource/mcp`;
- `APPTHEORY_MCP_PATH`, `APPTHEORY_MCP_PROTECTED_RESOURCE_PATH`,
  `APPTHEORY_MCP_AUTHORIZATION_SERVER_ISSUER`, and `APPTHEORY_MCP_JWKS_URI` on the Lambda.

The issuer and JWKS values are ordinary construct props in this release. Literal issuer values are validated at
synthesis as absolute HTTPS URLs with no userinfo, query, or fragment. Literal JWKS values must be absolute HTTPS URLs
with no userinfo or fragment; queries are allowed. Literal validation also requires an RFC 3986 authority with a
non-empty, non-percent-encoded host, so WHATWG recovery forms such as `https:///jwks.json`, `https:jwks.json`, and
percent-encoded hostnames fail at synthesis instead of later at Go runtime initialization. CDK tokens for either value
are forwarded unparsed and remain subject to the same fail-closed Go initialization checks after resolution. WHATWG and
Go parsing are not used to derive or compare the protected-resource origin: issuer and JWKS values are install config,
while only the request-derived resource identifier participates in RFC 9728 resource string matching. Residual parser
differences include one measured dangerous-direction case: an embedded ASCII TAB, CR, or LF in a literal issuer or
`jwksUri` (for example, `"https://auth.example.com\t/jwks.json"`) is accepted by CDK because WHATWG strips those
characters anywhere in the input, but rejected by Go's `url.Parse`; this pre-existing case fails closed during runtime
initialization. Safe-direction differences include CDK rejecting an empty fragment marker and malformed numeric
IPv4-like hosts such as `256.256.256.256` that Go can parse as host text. The new percent-sign check also makes IPv6
zone-id literals such as `https://[fe80::1%25eth0]/…` CDK-reject while Go accepts them. Runtime initialization remains
the final RFC 3986 check for token-resolved values and any residual WHATWG/RFC 3986 difference. `mcpPath` must be a
synthesis-time literal
absolute route path: it may contain only RFC 3986 path characters (with percent-encoding for whitespace and characters
outside that set), must not contain `.` or `..` segments, and must already be in clean path form. The named
CloudFormation install-parameter contract is a separate deployment-layer capability and is not emitted by this
construct.

Omitting both auth props retains the previous POST-only AgentCore deployment shape for existing applications. Supplying
only one fails synthesis; AppTheory does not deploy a half-configured discovery surface.

## Go SecureApp registration

The matching runtime path is `oauth.RegisterMCPServer`. It registers the MCP handler with the A3 `Authenticated`
posture and both discovery handlers with `Public` posture:

```go
app := apptheory.NewSecure(apptheory.SecureOptions{
    PrincipalResolver: resolvePrincipal,
})

err := oauth.RegisterMCPServer(app, mcpHandler, oauth.MCPServerConfig{
    MCPPath:                   os.Getenv("APPTHEORY_MCP_PATH"),
    AuthorizationServerIssuer: os.Getenv("APPTHEORY_MCP_AUTHORIZATION_SERVER_ISSUER"),
    JWKSURI:                   os.Getenv("APPTHEORY_MCP_JWKS_URI"),
})
if err != nil {
    return err
}
```

The discovery handler reconstructs the resource as `<request origin><MCP path>` and returns `application/json` with
exactly `resource` and `authorization_servers`. The JWKS URI is forwarded to the handler as install configuration in
`APPTHEORY_MCP_JWKS_URI` for the application's `SecurePrincipalResolver`; it is not published in the RFC 9728 document.
The handler accepts HTTPS request origins and HTTP only for loopback smoke tests. Missing or unsafe hosts fail with
`400`; missing or invalid install auth config fails application setup. Before resource construction, the request origin
is canonicalized for RFC 9728 string matching: scheme and host are lowercased, a trailing DNS root dot is removed for
HTTPS, default HTTPS `:443` and loopback HTTP `:80` ports are omitted, and non-default ports are preserved. The loopback
HTTP scheme check runs before canonicalization, so `http://localhost.` is rejected rather than having its root dot
removed; the base implementation behaves identically.

Every response from these runtime-derived discovery routes, including `400` errors, carries `Cache-Control: no-store`.
An edge cache or front proxy in front of them **MUST NOT** cache the response: `resource` is derived from the
viewer-facing Host header, so caching it could let one request's host-derived identifier be served to other clients.
The secondary static compatibility handler below serves configured metadata rather than Host-derived content, so this
runtime no-store rule is intentionally scoped to `oauth.RegisterMCPServer` discovery.

Use `AppTheoryMcpPaths` in CDK and the `runtime/oauth` path constants in Go instead of application-local literals. The
canonical set includes the MCP path, generic and MCP-scoped RFC 9728 paths, and the MCP-scoped RFC 8414 authorization
server path.

## Secondary static compatibility path

`AppTheoryMcpProtectedResource` remains available for existing REST API stacks that intentionally synthesize a static
mock discovery document. Its URL-valued `resource` and `authorizationServers` props are deprecated. The optional
literal `metadataPath` selects the static route without deriving that path from the resource URL.

Do not use the static construct for namespace applications. Migrate those applications to `AppTheoryMcpServer` plus
`oauth.RegisterMCPServer`; hosts at request time are the single namespace path.
