# REST API Router + Streaming

`AppTheoryRestApiRouter` is the canonical AppTheory CDK pattern for API Gateway REST API v1 when you need multi-Lambda
routing or true response streaming.

## Use this when

- different routes should invoke different Lambda functions
- you need SSE or response streaming
- you want stage controls such as access logging, detailed metrics, throttling, or a custom domain

## Minimal example

```ts
import { AppTheoryRestApiRouter } from "@theory-cloud/apptheory-cdk";

const router = new AppTheoryRestApiRouter(this, "Router", {
  apiName: "streaming-api",
});

router.addLambdaIntegration("/sse", ["GET"], sseFn, { streaming: true });
router.addLambdaIntegration("/api/graphql", ["POST"], graphqlFn);
router.addLambdaIntegration("/{proxy+}", ["ANY"], apiFn);
```

## Streaming behavior

When `streaming: true` is enabled on a route, the construct configures:

- `ResponseTransferMode: STREAM`
- a Lambda invocation URI ending in `/response-streaming-invocations`
- `TimeoutInMillis: 900000`

These settings are what make API Gateway REST API v1 response streaming work on AWS.

## Related guides

- [MCP Server for Bedrock AgentCore](./mcp-server-agentcore.md)
- [Claude Remote MCP + Streaming](./mcp-server-remote-mcp.md)
