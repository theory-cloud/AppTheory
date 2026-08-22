# MCP Server for Bedrock AgentCore

This guide shows how to deploy an **MCP (Model Context Protocol)** endpoint for **Bedrock AgentCore** using **AppTheory CDK**.

`AppTheoryMcpServer` defaults to the canonical four-kind route family and its full OAuth facade. AgentCore's
singleton, POST-only client shape must select `routeFamily: { patterns: ["/mcp"] }` explicitly and use
application-owned runtime registration. `runtime/mcpfacade.RegisterMCPFacade` serves only the canonical four-pattern
family; it is not configurable as the singleton runtime counterpart. See the
[MCP Server Facade Construct](../../docs/features/mcp-server-construct.md).

The minimal examples below also set `unauthenticatedMcp: true` because their application registers only `POST /mcp`.
That flag removes the CDK OAuth facade; it does not authenticate the route. Authentication remains application-owned.

It also supports:

- Configurable DynamoDB session state, enabled by default (TTL + permissions + env vars)
- Optional custom domain + Route53 CNAME
- Optional stage options (name, access logs, throttling)

If you’re looking for the Go runtime implementation (tools + handler), see `docs/integrations/agentcore-mcp.md`.

Note on SSE progress streaming:

- This construct uses **HTTP API v2**. Many deployments will buffer responses, so SSE progress may not be delivered incrementally.
- If you require true response streaming, use an API Gateway **REST API v1** streaming pattern (see `cdk/docs/rest-api-router-streaming.md`).
- For Claude Custom Connectors (Remote MCP / Streamable HTTP), use `AppTheoryRemoteMcpServer` (see `cdk/docs/mcp-server-remote-mcp.md`).

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
      routeFamily: { patterns: ["/mcp"] },
      unauthenticatedMcp: true,
    });

    new cdk.CfnOutput(this, "McpEndpoint", { value: mcp.endpoints[0] });
  }
}
```

This deploys an **HTTP API v2** with the `/mcp` transport routes and no OAuth facade. AgentCore calls `POST /mcp`; the
application must register the matching runtime handler, for example `app.Post("/mcp", srv.Handler())`. The construct
writes `MCP_ENDPOINT` in owned mode, and `mcp.endpoints[0]` is the URL to configure in AgentCore.

If the singleton needs the full OAuth facade, omit `unauthenticatedMcp` and register handlers for every derived entry
in `mcp.routeInventory` in application code. Do not pair that singleton deployment with `RegisterMCPFacade`.

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

from apptheory_cdk import AppTheoryMcpRouteFamily, AppTheoryMcpServer


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

        mcp = AppTheoryMcpServer(
            self,
            "McpServer",
            handler=handler,
            route_family=AppTheoryMcpRouteFamily(patterns=["/mcp"]),
            unauthenticated_mcp=True,
        )
        CfnOutput(self, "McpEndpoint", value=mcp.endpoints[0])
```

---

## Session state (DynamoDB enabled by default)

To configure the default DynamoDB session table:

```ts
const mcp = new AppTheoryMcpServer(this, "McpServer", {
  handler,
  routeFamily: { patterns: ["/mcp"] },
  unauthenticatedMcp: true,
  sessionState: { enabled: true, ttlMinutes: 60 },
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
- In Go, choose the Dynamo session store explicitly (see `docs/integrations/agentcore-mcp.md`).

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
  routeFamily: { patterns: ["/mcp"] },
  unauthenticatedMcp: true,
  ownedApi: {
    domain: {
      domainName: "mcp.example.com",
      certificate: cert,
      hostedZone: zone, // creates a CNAME automatically
    },
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
  routeFamily: { patterns: ["/mcp"] },
  unauthenticatedMcp: true,
  ownedApi: {
    stage: {
      stageName: "prod",
      accessLogging: true,
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    },
  },
});
```

When you’re using the execute-api hostname (no custom domain), non-`$default` stages include the stage path:

- `https://{apiId}.execute-api.{region}.amazonaws.com/prod/mcp`

When you’re using a custom domain, the construct maps the stage to the domain root:

- `https://mcp.example.com/mcp`

---

## Security and migration note

`unauthenticatedMcp: true` is a deployment-facade opt-out, not an instruction to ship an open tool endpoint. Protect
the application-owned `POST /mcp` registration through the normal AppTheory middleware chain. If the application owns
a singleton OAuth facade, it must register every route in `routeInventory`; `RegisterMCPFacade` remains canonical-family
only.

The v3.1.x issuer/JWKS construct props no longer configure runtime discovery or emit environment variables. Move
those values into application-owned `mcpfacade.FacadeConfig` for the canonical family, or into the singleton's own
runtime registration. See the [redesign guide](../../docs/features/mcp-server-construct.md) and the
[UPGRADING migration note](../../UPGRADING.md#mcp-server-facade-redesign-and-a6-deprecation).
