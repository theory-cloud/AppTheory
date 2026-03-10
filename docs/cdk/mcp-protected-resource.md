# MCP Protected Resource Metadata

Use `AppTheoryMcpProtectedResource` to add the OAuth protected-resource metadata endpoint required for Claude Remote
MCP discovery.

## What it adds

- `GET /.well-known/oauth-protected-resource`

Clients expect this after a `401 Unauthorized` response that includes a `WWW-Authenticate: Bearer` challenge with
`resource_metadata=...`.

## Minimal example

```ts
import {
  AppTheoryMcpProtectedResource,
  AppTheoryRemoteMcpServer,
} from "@theory-cloud/apptheory-cdk";

const mcp = new AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
  handler,
});

new AppTheoryMcpProtectedResource(stack, "ProtectedResource", {
  router: mcp.router,
  resource: mcp.endpoint,
  authorizationServers: ["https://auth.example.com"],
});
```

This construct only adds the metadata endpoint. Your MCP Lambda still needs to enforce bearer auth and emit the
challenge on unauthorized requests.
