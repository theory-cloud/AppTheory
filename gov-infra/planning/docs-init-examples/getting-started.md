# Getting Started with AppTheory (Example)

This file is an example for `docs/getting-started.md`.

## Prerequisites

**Required**
- Go `1.26.x` (see `go.mod` toolchain `go1.26.0`)
- Node.js `24+` (see `ts/package.json` and `cdk/package.json` engines)
- Python `3.14+` (see `py/pyproject.toml`)

**Recommended**
- AWS account and Lambda familiarity
- AWS CDK v2 for infrastructure flows

## Installation

AppTheory is distributed through GitHub Releases (not npm/PyPI registries).

### Go module
```bash
go get github.com/theory-cloud/apptheory@v0.16.0
```

### TypeScript package (release tarball)
```bash
npm i ./theory-cloud-apptheory-0.16.0.tgz
```

### Python package (release wheel)
```bash
python -m pip install ./apptheory-0.16.0-py3-none-any.whl
```

## First Local Run (Go)

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

## Verification

```bash
make test-unit
./scripts/verify-contract-tests.sh
```

Expected success signals:
- Go tests pass without runtime or adapter errors
- Contract test script exits zero

## Next Steps
- [API Reference](./api-reference.md)
- [Core Patterns](./core-patterns.md)
- [Troubleshooting](./troubleshooting.md)
