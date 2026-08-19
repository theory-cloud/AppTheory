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

The issuer and JWKS values are ordinary construct props in this release. They may be CDK tokens because AppTheory
forwards rather than parses them. The named CloudFormation install-parameter contract is a separate deployment-layer
capability and is not emitted by this construct.

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

The discovery handler reconstructs the resource as `<request origin><MCP path>`, advertises the configured issuer and
JWKS URI, and returns `application/json`. It accepts HTTPS request origins and HTTP only for loopback smoke tests.
Missing or unsafe hosts fail with `400`; missing or invalid install auth config fails application setup.

Use `AppTheoryMcpPaths` in CDK and the `runtime/oauth` path constants in Go instead of application-local literals. The
canonical set includes the MCP path, generic and MCP-scoped RFC 9728 paths, and the MCP-scoped RFC 8414 authorization
server path.

## Secondary static compatibility path

`AppTheoryMcpProtectedResource` remains available for existing REST API stacks that intentionally synthesize a static
mock discovery document. Its URL-valued `resource` and `authorizationServers` props are deprecated. The optional
literal `metadataPath` selects the static route without deriving that path from the resource URL.

Do not use the static construct for namespace applications. Migrate those applications to `AppTheoryMcpServer` plus
`oauth.RegisterMCPServer`; hosts at request time are the single namespace path.
