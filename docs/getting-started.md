---
title: Getting Started
---

# Getting Started with AppTheory

This guide gets a local AppTheory workspace running, shows the smallest deterministic app path in each runtime, and
then carries one canonical CDK path through bootstrap, deploy, curl verification, and teardown.

## Prerequisites

- Go `1.26.4` (`go.mod`)
- Node.js `>=24` (`ts/package.json` and `cdk/package.json`)
- Python `>=3.14` (`py/pyproject.toml`)
- `make` and `git`
- AWS credentials plus permission to run `cdk bootstrap`, `cdk deploy`, and `cdk destroy` when you are ready to create
  cloud resources

## Install from repo

```bash
git clone https://github.com/theory-cloud/AppTheory.git
cd AppTheory

go mod download
(cd ts && npm ci)
(cd py && python -m pip install -e .)
(cd cdk && npm ci)
```

AppTheory release artifacts are also published via GitHub Releases. Pin and verify the release you consume:

```bash
VERSION=1.14.0
TAG="v${VERSION}"
REPO="theory-cloud/AppTheory"

go get "github.com/theory-cloud/apptheory@${TAG}"
gh release download "${TAG}" --repo "${REPO}" \
  --pattern "theory-cloud-apptheory-${VERSION}.tgz" \
  --pattern "apptheory-${VERSION}-py3-none-any.whl" \
  --pattern "SHA256SUMS.txt" \
  --clobber
grep -E " (theory-cloud-apptheory-${VERSION}\.tgz|apptheory-${VERSION}-py3-none-any\.whl)$" SHA256SUMS.txt | sha256sum -c -
npm install "./theory-cloud-apptheory-${VERSION}.tgz"
python -m pip install "./apptheory-${VERSION}-py3-none-any.whl"
```

## First deterministic local invocation

Each runtime exposes the same basic deterministic flow: create a test environment, register a route, invoke the app,
and assert on the response.

### Go

```go
package mysvc

import (
	"context"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/testkit"
)

func Example() {
	env := testkit.New()
	app := env.App()

	app.Get("/ping", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(200, "pong"), nil
	})

	_ = env.Invoke(context.Background(), app, apptheory.Request{Method: "GET", Path: "/ping"})
}
```

### TypeScript

```ts
import { createTestEnv, text } from "@theory-cloud/apptheory";

export async function example() {
  const env = createTestEnv();
  const app = env.app();

  app.get("/ping", () => text(200, "pong"));

  const resp = await env.invoke(app, { method: "GET", path: "/ping" });
  console.log(resp.status);
}
```

### Python

```py
from apptheory import Request, create_test_env, text

env = create_test_env()
app = env.app()

app.get("/ping", lambda ctx: text(200, "pong"))

resp = env.invoke(app, Request(method="GET", path="/ping"))
assert resp.status == 200
```

Equivalent deterministic test environments exist in all three runtimes:

- Go: `testkit.New()`
- TypeScript: `createTestEnv()`
- Python: `create_test_env()`

## Deploy the hello-world service

The deployable on-ramp is [`examples/cdk/hello-world`](../examples/cdk/hello-world/README.md). It uses one
`AppTheoryHttpApi` and one Lambda function per language variant, with deterministic testkit tests for Go, TypeScript,
and Python.

Install the example dependencies from a clean clone:

```bash
cd examples/cdk/hello-world
npm ci
```

Synthesize first. Synth proves the CDK graph can render locally, but it is not the finish line:

```bash
npx cdk synth -c lang=ts AppTheoryHelloWorldTs
```

Bootstrap the target account/region once before the first deploy:

```bash
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=${AWS_REGION:-us-east-1}
npx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}"
```

Deploy exactly one variant:

```bash
npx cdk deploy -c lang=ts AppTheoryHelloWorldTs
```

CDK prints the `ApiUrl` output. Verify the deployed service with `curl`:

```bash
API_URL="https://replace-with-the-ApiUrl-output"
curl "${API_URL}/hello/AppTheory"
```

Expected response shape:

```json
{"message":"hello AppTheory","runtime":"ts","request_id":"...","tenant_id":""}
```

Destroy the stack when you are done:

```bash
npx cdk destroy -c lang=ts AppTheoryHelloWorldTs
```

Use `-c lang=go AppTheoryHelloWorldGo` or `-c lang=py AppTheoryHelloWorldPy` for the Go and Python variants.

## Verification

Run the fast local check first:

```bash
make test-unit
```

Run the parity and release gates before opening a PR:

```bash
./scripts/verify-ts-tests.sh
./scripts/verify-python-tests.sh
./scripts/verify-contract-tests.sh
./scripts/verify-api-snapshots.sh
./scripts/verify-docs-standard.sh
make rubric
```

`make rubric` now covers Go unit tests, TypeScript unit tests, Python unit tests, shared contract fixtures, snapshots,
docs checks, and release-packaging verifiers.

If you changed exported APIs, refresh and re-verify the public API snapshots:

```bash
./scripts/update-api-snapshots.sh
./scripts/verify-api-snapshots.sh
```

## AWS entrypoints

Use the runtime entrypoint that matches your deployment shape:

- Mixed-trigger Lambda: `app.HandleLambda(...)`, `app.handleLambda(...)`, or `app.handle_lambda(...)`
- AppSync resolver Lambda: `ServeAppSync`, `serveAppSync`, `serve_appsync`
- HTTP API v2: `ServeAPIGatewayV2`, `serveAPIGatewayV2`, `serve_apigw_v2`
- Lambda Function URL: `ServeLambdaFunctionURL`, `serveLambdaFunctionURL`, `serve_lambda_function_url`
- REST API v1: `ServeAPIGatewayProxy`, `serveAPIGatewayProxy`, `serve_apigw_proxy`
- TypeScript Lambda Function URL streaming: `createLambdaFunctionURLStreamingHandler(app)`

Standard AppSync direct Lambda resolver events also route through the mixed-trigger dispatcher, so a Lift-style
single-Lambda entrypoint can continue to use `HandleLambda`, `handleLambda`, or `handle_lambda`.

For the GraphQL front door itself, use native AppSync infrastructure such as `aws-cdk-lib/aws-appsync`; AppTheory owns
the Lambda resolver adapter, not the GraphQL API construct.

## Safe HTTP source IP access

Use AppTheory source provenance when a handler or middleware needs the provider-observed client IP. Do not derive
security decisions from `Forwarded` or `X-Forwarded-For`; those are viewer-controlled headers unless a product has its
own separate trusted-proxy model.

```go
app.Get("/source", func(ctx *apptheory.Context) (*apptheory.Response, error) {
	return apptheory.JSON(200, map[string]string{"source_ip": ctx.SourceIP()})
})

event := testkit.APIGatewayV2Request("GET", "/source", testkit.HTTPEventOptions{
	SourceIP: "2001:DB8::1",
})
```

```ts
app.get("/source", (ctx) => json(200, { source_ip: ctx.sourceIP() }));

const event = buildAPIGatewayV2Request("GET", "/source", {
  sourceIp: "2001:DB8::1",
});
```

```py
app.get("/source", lambda ctx: json(200, {"source_ip": ctx.source_ip()}))

event = build_apigw_v2_request("GET", "/source", source_ip="2001:DB8::1")
```

The runtime canonicalizes valid provider IPs, so each example exposes `2001:db8::1`. Missing or malformed provider
values return unknown/invalid provenance instead of falling back to forwarding headers.

## Next reads

- [Documentation Index]({{ "/" | relative_url }})
- [API Reference](./api-reference.md)
- [Core Patterns](./core-patterns.md)
- [Testing Guide](./testing-guide.md)
- [CDK Guides](./cdk/README.md)
- [CDK Getting Started](./cdk/getting-started.md)
- [Hello-world CDK example](../examples/cdk/hello-world/README.md)
- [Lift Migration Guide](./migration/from-lift.md)
- [AppSync Lambda Resolver Recipe](./migration/appsync-lambda-resolvers.md)
- [CDK AppSync Lambda Resolvers](./cdk/appsync-lambda-resolvers.md)

Additional canonical capability guides:

- [Feature Guides](./features/README.md)
- [Integration Guides](./integrations/README.md)
- [Bedrock AgentCore MCP](./integrations/agentcore-mcp.md)
- [Claude Remote MCP](./integrations/remote-mcp.md)
- [MCP Method Surface](./integrations/mcp.md)

Package-local quick starts still exist under `ts/docs/` and `py/docs/`, but the canonical cross-language guidance
starts in `docs/`.
