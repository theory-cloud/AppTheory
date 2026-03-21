# MCP Protected Resource Metadata (OAuth) - RFC9728

Claude Remote MCP requires an OAuth protected-resource metadata endpoint for discovery.

This guide covers `AppTheoryMcpProtectedResource`, which adds:

- `GET /.well-known/oauth-protected-resource/...resource path...`

## What Claude expects

When calling your MCP server without a token, Claude expects:

- `401 Unauthorized`
- `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"`

Claude then fetches the metadata endpoint and expects JSON like:

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
  resource: mcp.endpoint,
  authorizationServers: ["https://auth.example.com"],
});
```

## Important notes

- this construct only adds the metadata endpoint
- your MCP Lambda still needs to enforce `Authorization: Bearer ...` and emit the `WWW-Authenticate` challenge on
  `401`
- the construct derives the metadata route from `resource` per RFC9728, so a resource of
  `https://mcp.example.com/mcp` becomes `GET /.well-known/oauth-protected-resource/mcp`
- the `resource` value should match the actual `/mcp` URL the client uses, including any custom domain or base path
- for API Gateway REST APIs, `/.well-known/...` sits under the same stage or base path as your `/mcp` route
- for per-actor bundles (`/mcp/{actor}`), prefer `AppTheoryRemoteMcpServer({ actorPath: true })`, which co-registers
  the matching discovery route automatically
