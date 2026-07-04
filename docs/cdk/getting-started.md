---
title: CDK Getting Started
---

# CDK Getting Started

Use this guide when you want to deploy an AppTheory application with the jsii CDK package. The canonical on-ramp is the
hello-world example: synth is a required check, then bootstrap, deploy, curl, and destroy complete the path.

## Install

AppTheory CDK is distributed via GitHub Releases. Pin the jsii package assets and verify their checksums before installing them:

```bash
VERSION=1.14.0
TAG="v${VERSION}"
REPO="theory-cloud/AppTheory"

gh release download "${TAG}" --repo "${REPO}" \
  --pattern "theory-cloud-apptheory-cdk-${VERSION}.tgz" \
  --pattern "apptheory_cdk-${VERSION}-py3-none-any.whl" \
  --pattern "SHA256SUMS.txt" \
  --clobber
grep -E " (theory-cloud-apptheory-cdk-${VERSION}\.tgz|apptheory_cdk-${VERSION}-py3-none-any\.whl)$" SHA256SUMS.txt | sha256sum -c -
npm install "./theory-cloud-apptheory-cdk-${VERSION}.tgz"
python -m pip install "./apptheory_cdk-${VERSION}-py3-none-any.whl"
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

## Deploy the hello-world stack

The smallest deployable CDK example lives at [`examples/cdk/hello-world`](../../examples/cdk/hello-world/README.md).
From a clean clone:

```bash
cd examples/cdk/hello-world
npm ci
```

Synthesize the language you plan to deploy:

```bash
npx cdk synth -c lang=ts AppTheoryHelloWorldTs
```

Bootstrap the target account/region once:

```bash
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=${AWS_REGION:-us-east-1}
npx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}"
```

Deploy:

```bash
npx cdk deploy -c lang=ts AppTheoryHelloWorldTs
```

Verify the `ApiUrl` output with curl:

```bash
API_URL="https://replace-with-the-ApiUrl-output"
curl "${API_URL}/hello/AppTheory"
```

Destroy the deployed stack:

```bash
npx cdk destroy -c lang=ts AppTheoryHelloWorldTs
```

Switch `ts`/`AppTheoryHelloWorldTs` to `go`/`AppTheoryHelloWorldGo` or `py`/`AppTheoryHelloWorldPy` for the other
runtime variants.

## Local no-AWS checks

Run the canonical CDK verification gates from the repo root:

```bash
./scripts/verify-testkit-examples.sh
./scripts/verify-cdk-synth.sh
make rubric
```

These checks do not run `cdk bootstrap`, `cdk deploy`, or `cdk destroy`; they prove the deterministic local subset.

## Next reads

- [Hello-world CDK example](../../examples/cdk/hello-world/README.md)
- [CDK API Reference](./api-reference.md)
- [FaceTheory-First SSR Site](./ssr-site.md)
- [AppSync Lambda Resolvers](./appsync-lambda-resolvers.md)
- [REST API Router + Streaming](./rest-api-router-streaming.md)
- [MCP Server for Bedrock AgentCore](./mcp-server-agentcore.md)
- [Claude Remote MCP + Streaming](./mcp-server-remote-mcp.md)
- [Import Pipeline Constructs](./import-pipeline.md)
