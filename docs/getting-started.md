# Getting Started with AppTheory

This guide gets a local AppTheory workspace running, shows the smallest deterministic app path, and points you at the
canonical API and deployment docs.

## Prerequisites

- Go `1.26.x` (`go.mod` / `toolchain go1.26.1`)
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

## First deterministic local invocation (Go)

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

Equivalent deterministic local entrypoints exist in the other runtimes:

- TypeScript: `createTestEnv()`, `env.app()`, `env.invoke(...)`
- Python: `create_test_env()`, `env.app()`, `env.invoke(...)`

## Verification

Run the fast local check first:

```bash
make test-unit
```

Run the contract and full repo gates before opening a PR:

```bash
./scripts/verify-contract-tests.sh
make rubric
```

If you changed exported APIs, also refresh and commit the public API snapshots:

```bash
./scripts/update-api-snapshots.sh
```

## AWS entrypoints

Use the runtime entrypoint that matches your deployment shape:

- Mixed-trigger Lambda: `app.HandleLambda(...)`, `app.handleLambda(...)`, or `app.handle_lambda(...)`
- HTTP API v2: `ServeAPIGatewayV2`, `serveAPIGatewayV2`, `serve_apigw_v2`
- Lambda Function URL: `ServeLambdaFunctionURL`, `serveLambdaFunctionURL`, `serve_lambda_function_url`
- REST API v1: `ServeAPIGatewayProxy`, `serveAPIGatewayProxy`, `serve_apigw_proxy`
- TypeScript Lambda Function URL streaming: `createLambdaFunctionURLStreamingHandler(app)`

## Next reads

- [API Reference](./api-reference.md)
- [Core Patterns](./core-patterns.md)
- [Testing Guide](./testing-guide.md)
- [CDK Guides](./cdk/README.md)
- [Bedrock AgentCore MCP](./agentcore-mcp.md)
- [Lift Migration Guide](./migration/from-lift.md)
