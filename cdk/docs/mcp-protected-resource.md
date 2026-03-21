# MCP Protected Resource Metadata (OAuth) — RFC9728

Claude Remote MCP (MCP auth `2025-06-18`) requires an OAuth **Protected Resource** metadata endpoint for discovery.

This guide covers `AppTheoryMcpProtectedResource`, which adds:

- `GET /.well-known/oauth-protected-resource/...resource path...`

## What Claude expects

When calling your MCP server without a token, Claude expects:

- `401 Unauthorized`
- `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"`

Then Claude fetches this endpoint and expects JSON like:

```json
{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"]
}
```

## TypeScript example

```ts
import { Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  AppTheoryMcpProtectedResource,
  AppTheoryRemoteMcpServer,
} from "@theory-cloud/apptheory-cdk";

const stack = new Stack();

const handler = new lambda.Function(stack, "McpHandler", {
  runtime: lambda.Runtime.PROVIDED_AL2023,
  handler: "bootstrap",
  code: lambda.Code.fromAsset("dist"),
});

const mcp = new AppTheoryRemoteMcpServer(stack, "RemoteMcp", {
  handler,
  apiName: "remote-mcp",
});

new AppTheoryMcpProtectedResource(stack, "ProtectedResource", {
  router: mcp.router,
  // For MCP this should be the `/mcp` URL the client uses as the resource indicator.
  resource: mcp.endpoint,
  // Point this at your Autheory issuer/base URL.
  authorizationServers: ["https://auth.example.com"],
});
```

## Important notes

- This construct only adds the **metadata endpoint**. Your MCP Lambda still needs to enforce
  `Authorization: Bearer ...` and emit the `WWW-Authenticate` challenge on 401.
- The route is derived from `resource` per RFC9728, so a resource of
  `https://mcp.example.com/mcp` becomes `GET /.well-known/oauth-protected-resource/mcp`.
- For AWS API Gateway REST APIs, `/.well-known/...` will be under the same stage/base-path
  as your `/mcp` route (matching what the client can reach).
- For per-actor bundles (`/mcp/{actor}`), prefer `AppTheoryRemoteMcpServer({ actorPath: true })`,
  which co-registers the matching discovery route automatically.
