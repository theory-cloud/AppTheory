# MCP Server for Bedrock AgentCore

This guide shows how to deploy an MCP endpoint for Bedrock AgentCore using AppTheory CDK.

The construct you want is:

- `AppTheoryMcpServer` - provisions an API Gateway v2 HTTP API with `POST /mcp` routed to your Lambda handler

It also supports:

- optional DynamoDB session table (TTL + permissions + env vars)
- optional custom domain + Route53 CNAME
- optional stage options (name, access logs, throttling)

If you're looking for the Go runtime implementation (tools + handler), see `docs/agentcore-mcp.md`.

Note on SSE progress streaming:

- this construct uses HTTP API v2, so many deployments will buffer responses and not deliver incremental SSE progress
- if you require true response streaming, use an API Gateway REST API v1 streaming pattern
- for Claude Remote MCP, use `AppTheoryRemoteMcpServer` instead

Related docs:

- `docs/agentcore-mcp.md`
- `docs/cdk/mcp-server-remote-mcp.md`
- `docs/cdk/rest-api-router-streaming.md`

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
      code: lambda.Code.fromAsset("dist/mcp-handler"),
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
- `POST /mcp` route -> your Lambda
- output `mcp.endpoint` (the URL you configure in AgentCore)

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

- a DynamoDB table with:
  - partition key: `sessionId` (string)
  - TTL attribute: `expiresAt`
- read/write permissions granted to your Lambda
- Lambda env vars:
  - `MCP_SESSION_TABLE`
  - `MCP_SESSION_TTL_MINUTES`

Important:

- the CDK construct does not automatically switch your runtime to DynamoDB-backed sessions
- in Go, choose the Dynamo session store explicitly (see `docs/agentcore-mcp.md`)

---

## Custom domain (optional)

AppTheory is a framework, so your platform can apply a custom domain when it makes sense.

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
    hostedZone: zone,
  },
});
```

Notes:

- provide either `certificate` or `certificateArn`
- if you omit `hostedZone`, the domain is created but DNS is not
- with a custom domain, the endpoint is always `https://mcp.example.com/mcp`

---

## Stage options (logging + throttling)

`AppTheoryMcpServer` defaults to the `$default` stage.

To create an explicit stage and enable access logs or throttling:

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

When you're using the execute-api hostname and a non-`$default` stage, the stage path is part of the URL:

- `https://{apiId}.execute-api.{region}.amazonaws.com/prod/mcp`

When you're using a custom domain, the construct maps the stage to the domain root:

- `https://mcp.example.com/mcp`

---

## Security note

This construct wires a public HTTP endpoint by default. Secure it intentionally:

- enforce auth in your Lambda (shared secret header, JWT verification, etc.)
- add surrounding platform controls if you need them (custom domains, WAF, private networking, authorizers)
