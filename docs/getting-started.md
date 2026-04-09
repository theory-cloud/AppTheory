# Getting Started with AppTheory

This guide gets a local AppTheory workspace running, shows the smallest deterministic app path in each runtime, and
points you at the canonical API and deployment docs.

## Prerequisites

- Go `1.26.2` (`go.mod`)
- Node.js `>=24` (`ts/package.json` and `cdk/package.json`)
- Python `>=3.14` (`py/pyproject.toml`)
- `make` and `git`

## Install from repo

```bash
git clone https://github.com/theory-cloud/AppTheory.git
cd AppTheory

go mod download
(cd ts && npm ci)
(cd py && python -m pip install -e .)
(cd cdk && npm ci)
```

AppTheory release artifacts are also published via GitHub Releases:

- Go module: `go get github.com/theory-cloud/apptheory@vX.Y.Z`
- TypeScript tarball: `npm i ./theory-cloud-apptheory-X.Y.Z.tgz`
- Python wheel: `python -m pip install ./apptheory-X.Y.Z-py3-none-any.whl`

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

## Next reads

- [Documentation Index](./README.md)
- [API Reference](./api-reference.md)
- [Core Patterns](./core-patterns.md)
- [Testing Guide](./testing-guide.md)
- [CDK Guides](./cdk/README.md)
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
