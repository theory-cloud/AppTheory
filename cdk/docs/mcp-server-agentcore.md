# MCP Server for Bedrock AgentCore

This guide shows how to deploy an **MCP (Model Context Protocol)** endpoint for **Bedrock AgentCore** using **AppTheory CDK**.

The construct you want is:

- `AppTheoryMcpServer` — provisions an API Gateway v2 **HTTP API** with `POST /mcp` routed to your Lambda handler.

It also supports:

- Optional DynamoDB session table (TTL + permissions + env vars)
- Optional custom domain + Route53 CNAME
- Optional stage options (name, access logs, throttling)

If you’re looking for the Go runtime implementation (tools + handler), see `docs/agentcore-mcp.md`.

---

## Minimal TypeScript stack

```ts
import * as cdk from "aws-cdk-lib";
import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import { AppTheoryMcpServer } from "@theory-cloud/apptheory-cdk";

export class AgentCoreMcpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const handler = new lambda.Function(this, "McpHandler", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: lambda.Code.fromAsset("dist/mcp-handler"), // your Go build output
      memorySize: 1024,
      timeout: Duration.seconds(30),
    });

    const mcp = new AppTheoryMcpServer(this, "McpServer", {
      handler,
    });

    new cdk.CfnOutput(this, "McpEndpoint", { value: mcp.endpoint });
  }
}
```

This deploys:

- HTTP API Gateway v2
- `POST /mcp` route → your Lambda
- Output `mcp.endpoint` (this is the URL you configure in AgentCore)

---

## Minimal Python stack

```py
from aws_cdk import (
    CfnOutput,
    Duration,
    Stack,
)
from aws_cdk import aws_lambda as _lambda
from constructs import Construct

from apptheory_cdk import AppTheoryMcpServer


class AgentCoreMcpStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        handler = _lambda.Function(
            self,
            "McpHandler",
            runtime=_lambda.Runtime.PROVIDED_AL2023,
            handler="bootstrap",
            code=_lambda.Code.from_asset("dist/mcp-handler"),
            memory_size=1024,
            timeout=Duration.seconds(30),
        )

        mcp = AppTheoryMcpServer(self, "McpServer", handler=handler)
        CfnOutput(self, "McpEndpoint", value=mcp.endpoint)
```

---

## Sessions (optional DynamoDB table)

To enable a DynamoDB session table:

```ts
const mcp = new AppTheoryMcpServer(this, "McpServer", {
  handler,
  enableSessionTable: true,
  sessionTtlMinutes: 60,
});
```

What you get:

- A DynamoDB table with:
  - Partition key: `sessionId` (string)
  - TTL attribute: `expiresAt`
- Read/write permissions granted to your Lambda
- Lambda env vars:
  - `MCP_SESSION_TABLE` (table name)
  - `MCP_SESSION_TTL_MINUTES` (TTL minutes)

Important:

- The **CDK construct does not automatically switch your runtime to DynamoDB-backed sessions**.
- In Go, choose the Dynamo session store explicitly (see `docs/agentcore-mcp.md`).

---

## Custom domain (optional)

AppTheory is a framework — your platform can (and often should) apply a custom domain.

```ts
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";

const zone = route53.HostedZone.fromLookup(this, "Zone", { domainName: "example.com" });
const cert = acm.Certificate.fromCertificateArn(this, "Cert", "arn:aws:acm:...");

const mcp = new AppTheoryMcpServer(this, "McpServer", {
  handler,
  domain: {
    domainName: "mcp.example.com",
    certificate: cert,
    hostedZone: zone, // creates a CNAME automatically
  },
});

// With a custom domain, the endpoint is always:
// https://mcp.example.com/mcp
```

Notes:

- Provide either `certificate` or `certificateArn`.
- If you omit `hostedZone`, the domain is created but DNS is not (bring your own record management).

---

## Stage options (logging + throttling)

`AppTheoryMcpServer` defaults to the `$default` stage.

To create an explicit stage and enable access logs / throttling:

```ts
const mcp = new AppTheoryMcpServer(this, "McpServer", {
  handler,
  stage: {
    stageName: "prod",
    accessLogging: true,
    throttlingRateLimit: 50,
    throttlingBurstLimit: 100,
  },
});
```

When you’re using the execute-api hostname (no custom domain), non-`$default` stages include the stage path:

- `https://{apiId}.execute-api.{region}.amazonaws.com/prod/mcp`

When you’re using a custom domain, the construct maps the stage to the domain root:

- `https://mcp.example.com/mcp`

---

## Security note

This construct wires a public HTTP endpoint by default. Secure it intentionally:

- Enforce auth in your Lambda (shared secret header, JWT verification, etc.), and/or
- Extend the API configuration in your own construct if you require authorizers/WAF/private networking.
