# Repository Guidelines

## Project Structure & Module Organization
AppTheory is a multi-language monorepo (Go/TypeScript/Python) with a shared runtime contract.

- Go (root module): `runtime/` (runtime + AWS adapters), `testkit/` (deterministic test env), `pkg/` (shared helpers), `cmd/` (CLIs).
- TypeScript SDK/runtime: `ts/src/` (source) → `ts/dist/` (checked-in build output).
- Python SDK/runtime: `py/src/` (source), `py/tests/` (unit tests).
- CDK constructs: `cdk/` (jsii; outputs `cdk/lib/` and `cdk/.jsii`), generated Go bindings in `cdk-go/`.
- Cross-language gates: `contract-tests/` (fixtures + runners) and `api-snapshots/` (public API parity snapshots).
- Release artifacts are generated into `dist/` (not committed).

## Build, Test, and Development Commands
Toolchains: Go `1.25.6` (see `go.mod`), Node `>=24`, Python `>=3.14`.

- `make fmt`: format Go code (`gofmt`).
- `make lint`: run Go/TS/Python linters.
- `make test-unit`: `go test ./...`.
- `make test`: unit tests + `./scripts/verify-version-alignment.sh`.
- `make build`: produce release artifacts into `dist/`.
- `make rubric`: run all repo gates (lint, build, API snapshots, contract tests, examples).

Version bumps must keep `VERSION`, `ts/package.json`, `cdk/package.json`, and `py/pyproject.toml` aligned (lockfiles too); `make test` enforces this.

## Coding Style & Naming Conventions
- Go: `gofmt` + `golangci-lint` (`.golangci-v2.yml`); tests are `*_test.go`.
- TypeScript: ESM, 2-space indent; run `cd ts && npm run check`; commit regenerated `ts/dist/` when `ts/src/` changes.
- Python: Ruff format/lint (120 cols); tests are `py/tests/test_*.py` (stdlib `unittest`).

## Testing Guidelines
- Contract behavior is validated across languages: `./scripts/verify-contract-tests.sh`.
- If you change exported APIs, update snapshots: `./scripts/update-api-snapshots.sh` and commit `api-snapshots/*.txt`.

## Commit & Pull Request Guidelines
- Prefer a short prefix and imperative subject (examples from history: `feat(cdk): ...`, `docs: ...`, `M1: ...`, `m14(scope): ...`).
- PRs should describe intent, list commands run (at least `make test`), and include any contract/snapshot/version updates.
