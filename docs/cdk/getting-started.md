# CDK Getting Started

Use this guide when you want to deploy an AppTheory application with the jsii CDK package.

## Install

AppTheory CDK is distributed via GitHub Releases.

Examples:

```bash
npm i ./theory-cloud-apptheory-cdk-X.Y.Z.tgz
python -m pip install ./apptheory_cdk-X.Y.Z-py3-none-any.whl
```

## Minimal TypeScript stack

```ts
import { Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { AppTheoryHttpApi } from "@theory-cloud/apptheory-cdk";

const stack = new Stack();
const fn = new lambda.Function(stack, "Handler", {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: "index.handler",
  code: lambda.Code.fromAsset("dist"),
});

new AppTheoryHttpApi(stack, "Api", { handler: fn, apiName: "my-api" });
```

## Next checks

Run the canonical CDK verification gates from the repo root:

```bash
./scripts/verify-cdk-synth.sh
make rubric
```

## Next reads

- [CDK API Reference](./api-reference.md)
- [AppSync Lambda Resolvers](./appsync-lambda-resolvers.md)
- [REST API Router + Streaming](./rest-api-router-streaming.md)
- [MCP Server for Bedrock AgentCore](./mcp-server-agentcore.md)
- [Claude Remote MCP + Streaming](./mcp-server-remote-mcp.md)
- [Import Pipeline Constructs](./import-pipeline.md)
