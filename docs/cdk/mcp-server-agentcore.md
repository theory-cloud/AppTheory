# MCP Server for Bedrock AgentCore

Use `AppTheoryMcpServer` when you need a canonical AppTheory CDK deployment for Bedrock AgentCore tool calls.

## What it provisions

- API Gateway HTTP API v2
- `POST /mcp` routed to your Lambda handler
- optional DynamoDB session table
- optional custom domain and stage controls

If you need true response streaming for Remote MCP, use `AppTheoryRemoteMcpServer` instead.

## Minimal TypeScript stack

```ts
import * as cdk from "aws-cdk-lib";
import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { AppTheoryMcpServer } from "@theory-cloud/apptheory-cdk";

export class AgentCoreMcpStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string) {
    super(scope, id);

    const handler = new lambda.Function(this, "McpHandler", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: lambda.Code.fromAsset("dist/mcp-handler"),
      memorySize: 1024,
      timeout: Duration.seconds(30),
    });

    new AppTheoryMcpServer(this, "McpServer", { handler });
  }
}
```

## Session table option

```ts
new AppTheoryMcpServer(this, "McpServer", {
  handler,
  enableSessionTable: true,
  sessionTtlMinutes: 60,
});
```

This grants table access to the Lambda and sets `MCP_SESSION_TABLE` plus `MCP_SESSION_TTL_MINUTES`.
