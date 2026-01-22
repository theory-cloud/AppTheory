# Getting Started with AppTheory

This guide gets you from zero to a working AppTheory handler with a deterministic local test, then points you at the AWS entrypoints.

## Prerequisites

**Required:**
- Go **1.25.x** (for the Go runtime)
- Node.js **24** (for the TypeScript runtime and jsii CDK constructs)
- Python **3.14** (for the Python runtime and Python CDK bindings)

**Recommended:**
- AWS CDK v2 (for infrastructure examples)

## Install

AppTheory is distributed via **GitHub Releases** (no npm/PyPI registry publishing).

- **Go:** add the module normally (example): `go get github.com/theory-cloud/apptheory@vX.Y.Z`
- **TypeScript:** download the release tarball and install it (example): `npm i ./theory-cloud-apptheory-X.Y.Z.tgz`
- **Python:** download the wheel and install it (example): `python -m pip install ./apptheory-X.Y.Z-py3-none-any.whl`

## First local run (Go)

```go
// CORRECT: Use testkit for deterministic unit tests (time + IDs + event builders).
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

## Deploy to AWS (choose an adapter)

AppTheory’s contract currently covers these HTTP adapters:
- API Gateway v2 (HTTP API)
- Lambda Function URL

Use the adapter entrypoints on `*apptheory.App`:
- Go: `app.ServeAPIGatewayV2(...)`, `app.ServeLambdaFunctionURL(...)`
- TypeScript: `createLambdaFunctionURLStreamingHandler(...)` and event adapters under `build*Request(...)`
- Python: `invoke_apigw_v2(...)` / `invoke_lambda_function_url(...)` in the test env, and adapter helpers under `build_*_request(...)`

Next:
- See package-specific docs for full examples: `ts/docs/README.md`, `py/docs/README.md`, `cdk/docs/README.md`.
- If you’re migrating from Lift, start at `docs/migration/from-lift.md`.

