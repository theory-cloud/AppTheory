# Getting Started with AppTheory

This is an example target for `docs/getting-started.md`.

## Prerequisites

- Go `1.26.x` (`go.mod` + `toolchain go1.26.1`)
- Node.js `>=24` for TypeScript and CDK workflows
- Python `>=3.14` for Python workflows
- `make`, `git`, and a Unix-like shell

## Installation

### 1) Clone and install workspace dependencies

```bash
git clone https://github.com/theory-cloud/AppTheory.git
cd AppTheory

go mod download
(cd ts && npm ci)
(cd py && python -m pip install -e .)
(cd cdk && npm ci)
```

### 2) Run a first deterministic local invocation

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

Equivalent deterministic test environments are available in TypeScript (`createTestEnv`) and Python (`create_test_env`).

## Verification

Run fast checks first:

```bash
make test-unit
```

Run parity and release gates before publishing docs/API changes:

```bash
./scripts/verify-contract-tests.sh
./scripts/update-api-snapshots.sh
make rubric
```

Expected result:

- Unit tests pass
- Contract tests pass
- Snapshot verification is clean after updates
- Rubric gate succeeds

## Next Steps

- [API Reference](./api-reference.md)
- [Core Patterns](./core-patterns.md)
- [Testing Guide](./testing-guide.md)
- [Troubleshooting](./troubleshooting.md)
- [Migration Guide](./migration-guide.md)
