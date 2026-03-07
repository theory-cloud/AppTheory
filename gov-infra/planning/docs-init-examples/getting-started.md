# Getting Started with AppTheory

This guide walks a new contributor or integrator through the first successful use of AppTheory at the repo level.

## Prerequisites

**Required:**
- Go toolchain **1.26.0** (`go.mod` uses `toolchain go1.26.0`)
- Node.js **24** for the TypeScript package and jsii/CDK package builds (`ts/package.json`, `cdk/package.json`)
- Python **3.14** for the Python package (`py/pyproject.toml`)
- A checkout of this repository if you want to run the full verification flow

**Recommended:**
- Familiarity with AWS Lambda adapters such as API Gateway v2 and Lambda Function URL
- Access to GitHub Releases, because AppTheory is distributed via release assets rather than npm or PyPI registries

## Installation

### Step 1: Prepare the environment

AppTheory is a multi-language monorepo. Confirm the toolchains first:

```bash
go version
node --version
python --version
```

**What this does:**
- Verifies the runtime/toolchain versions that matter to AppTheory users and contributors
- Reduces avoidable failures before running repo commands or package install steps

### Step 2: Install the package form you need

AppTheory is distributed via **GitHub Releases only**.

```bash
# Go module example
go get github.com/theory-cloud/apptheory@v0.16.0

# TypeScript package example (release asset tarball)
npm i ./theory-cloud-apptheory-0.16.0.tgz

# Python package example (release asset wheel)
python -m pip install ./apptheory-0.16.0-py3-none-any.whl
```

**Notes:**
- The repo README explicitly states that the project is not published to npm or PyPI.
- TODO: confirm the exact release asset filenames used for every platform package before publishing end-user install text.

### Step 3: Run the first successful workflow

Use the deterministic Go testkit example already shown in the repo docs as the clearest first success path:

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

This example is grounded in `docs/getting-started.md` and shows the lowest-friction entry into the runtime contract.

## Verification

Confirm the repository passes its fast verification path:

```bash
make test-unit
```

For a broader gate before publishing or merging docs and code changes, use:

```bash
make rubric
```

**Expected result:**
- `make test-unit` completes successfully with `go test ./...`
- `make rubric` runs the repo's broader governance and verification bundle
- If versions drift, `./scripts/verify-version-alignment.sh` will fail and must be fixed before release

## Next Steps
- Read [API Reference](./api-reference.md) for the confirmed public module, package, and adapter surfaces.
- Read [Core Patterns](./core-patterns.md) for canonical `CORRECT` and `INCORRECT` usage.
- Read [Testing Guide](./testing-guide.md) for contract tests, snapshots, and packaging verification.
- Read [Troubleshooting](./troubleshooting.md) if toolchain, version alignment, or generated artifacts drift.
- Read [Migration Guide](./migration-guide.md) if you are moving from Lift or raw AWS Lambda handlers.
