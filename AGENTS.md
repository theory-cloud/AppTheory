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
Toolchains: Go `1.26.4` (see `go.mod`), Node `>=24`, Python `>=3.14`.

- `make fmt`: format Go code (`gofmt`).
- `make lint`: run Go/TS/Python linters.
- `make test-unit`: `go test ./...`.
- `make test`: unit tests + `./scripts/verify-version-alignment.sh`.
- `make build`: produce release artifacts into `dist/`.
- `make rubric`: run all repo gates (lint, build, API snapshots, contract tests, examples).

Version bumps must keep `VERSION`, `ts/package.json`, `cdk/package.json`, `py/pyproject.toml`, `.release-please-manifest.json`, and `.release-please-manifest.premain.json` aligned (lockfiles too); `make test` enforces this.

## Coding Style & Naming Conventions
- Go: `gofmt` + `golangci-lint` (`.golangci-v2.yml`); tests are `*_test.go`.
- TypeScript: ESM, 2-space indent; run `cd ts && npm run check`; commit regenerated `ts/dist/` when `ts/src/` changes.
- Python: Ruff format/lint (120 cols); tests are `py/tests/test_*.py` (stdlib `unittest`).

## Testing Guidelines
- Contract behavior is validated across languages: `./scripts/verify-contract-tests.sh`.
- If you change exported APIs, update snapshots: `./scripts/update-api-snapshots.sh` and commit `api-snapshots/*.txt`.

## Commit & Pull Request Guidelines
- Prefer a short prefix and imperative subject (examples: `feat(cdk): ...`, `docs: ...`, `feat(M1): ...`, `m14(scope): ...`).
- Release automation is driven by Conventional Commits; if a change must ship, use `feat:` / `fix:` (avoid milestone-only prefixes like `M1:`).
- Branch management is a strict release train: `staging` → `premain` (release candidate) → `main` (stable release) → `staging` (back-merge). Do not skip a leg, merge around a leg, or leave `staging` behind `main`; this order is critical to avoid release and generated-artifact conflicts.
- Work lands in `staging` first. `premain` only receives promoted `staging` changes for RCs, `main` only receives promoted `premain` changes for stable releases, and every stable `main` release must be brought back into `staging` before the next staging PR or promotion.
- Full rubric belongs only on PRs targeting `staging` and optional manual `workflow_dispatch`; `premain`/`main` lanes run release hygiene, release-branch, build/package, and publish postcondition checks instead.
- Every PR merged to `premain` is release-candidate intent and must lead to an open generated `release-please--branches--premain` RC PR; every PR merged to `main` is stable release intent and must lead to an open generated `release-please--branches--main` stable PR.
- Do not create manual tags, reset protected branches, push directly to `staging`/`premain`/`main`, or add post-release CI sync/backmerge automation. After a stable `main` release, the next operator step is a human PR from `main` back to `staging`.
- Staging PRs must *ALWAYS* contain current `main`. Before opening or merging any PR whose base is `staging`, verify `origin/main` is an ancestor of the PR head (for example, `git merge-base --is-ancestor origin/main HEAD`); if not, merge `origin/main` into the PR branch first.
- PRs to `staging` must verify version alignment across both release and release-candidate manifests: `.release-please-manifest.json` and `.release-please-manifest.premain.json`. The premain Release Please state must stay in sync with the stable manifest whenever `main` advances.
- After any stable release on `main`, the next `staging` PR must reset `.release-please-manifest.premain.json` to the latest stable version from `.release-please-manifest.json` before promoting `staging` to `premain`; stale prerelease tracks fail the release lane.
- Do not merge a stale premain Release Please PR after `main` has advanced. Sync or regenerate the premain Release Please state first so the next RC starts from the current stable release baseline.
- Broken or superseded release/promotion PRs must not remain mergeable. Once explicitly authorized for the incident, close them promptly instead of relying on humans to avoid a stale merge path.
- Release Please PRs must not be merged until generated CDK artifact sync has completed and all required checks are green; merging before sync leaves `main` with stale release artifacts.
- PRs should describe intent, list commands run (at least `make test`), and include any contract/snapshot/version updates.
