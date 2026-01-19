# AppTheory Repo Layout (TableTheory Pattern)

This document defines the intended structure of the AppTheory monorepo. It is written early so automation (builds,
contract tests, and releases) can assume stable paths.

Status: frozen for milestone `M0`.

## Top-level layout

```text
/                       # Go SDK/runtime (Go toolchain 1.25.6)
  docs/                    # documentation + planning (stable)
  contract-tests/          # shared fixtures + runners (stable)
  examples/                # deployable demos (CDK, templates)
  scripts/                 # repo verifiers (build/lint/test/release checks)

  ts/                      # TypeScript SDK/runtime (Node.js 24)
  py/                      # Python SDK/runtime (Python 3.14)

  internal/                # Go internal implementation (not part of public API)
  pkg/                     # Go public packages (stable API surface)
  cmd/                     # Go CLIs (optional)
```

Conventions:

- Go “user entrypoint” re-exports live at repo root (example: `apptheory.go`) and delegate to `internal/...`.
- TypeScript is ESM-first. Python uses `src/` layout with `pyproject.toml`.
- Contract fixtures are language-neutral and owned by `contract-tests/`.

## Contract tests layout (seed)

```text
contract-tests/
  fixtures/
    p0/*.yml
    p1/*.yml
    p2/*.yml
  runners/
    go/
    ts/
    py/
```

The exact fixture schema is defined in:

- `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`

## Examples layout (seed)

```text
examples/
  cdk-multilang/           # one CDK stack that deploys Go/Node/Py handlers
```

## Governance artifacts (`hgm-infra/`)

Hypergenium’s applied outputs often live under `hgm-infra/` in existing repos. AppTheory should treat `docs/` as stable
and treat governance outputs as movable.

See:

- `docs/development/planning/apptheory/supporting/apptheory-governance-note.md`
