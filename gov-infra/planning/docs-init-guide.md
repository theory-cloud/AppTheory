# AppTheory Docs Init Guide

Generated: 2026-03-07

This artifact is **guide-only**. Do not modify docs/ directly from this action.
A local agent must apply or adapt the example outputs under `gov-infra/planning/docs-init-examples/`.

## Purpose

- Scope summary: `UNKNOWN: no scope_summary was provided in the action input; use full repo-level docs contract alignment for AppTheory.`
- Relevant languages and runtimes for docs init:
  - Go `1.26.0` via `go.mod` and `README.md`
  - Node.js `24` for the TypeScript package and jsii/CDK package via `ts/package.json` and `cdk/package.json`
  - Python `3.14` via `py/pyproject.toml`
  - `make` is a user-facing verification command surface via `Makefile`
  - GitHub Actions is present but out-of-scope for public docs init except where existing docs already reference CI behavior
- Selected documentation domains:
  1. Repo-level runtime and docs contract domain under `docs/`
  2. Machine-readable concept/pattern/decision domain under `docs/_concepts.yaml`, `docs/_patterns.yaml`, and `docs/_decisions.yaml`
  3. Public API and compatibility domain backed by `api-snapshots/` and repo API docs
  4. Package-specific docs domains under `ts/docs/`, `py/docs/`, and `cdk/docs/`
  5. Migration and compatibility domain under `docs/migration-guide.md` and `docs/migration/**`
- Public/external surface summary:
  - Go module: `github.com/theory-cloud/apptheory`
  - Go runtime package: `github.com/theory-cloud/apptheory/runtime`
  - TypeScript package: `@theory-cloud/apptheory`
  - Python package: `apptheory`
  - CDK package: `@theory-cloud/apptheory-cdk` with jsii targets including Python and Go bindings
  - Repo-level verification commands: `make test-unit`, `make test`, `make rubric`, `make build`
  - Canonical API surfaces: `api-snapshots/go.txt`, `api-snapshots/ts.txt`, `api-snapshots/py.txt`
  - Confirmed external runtime patterns: app container, routing, middleware, universal Lambda dispatch, AWS adapter entrypoints, jobs ledger primitives, migration from Lift
- Canonical sources consulted by domain:
  - Project identity, supported runtimes, and distribution posture:
    - `README.md`
    - `go.mod`
    - `Makefile`
    - `VERSION`
    - `ts/package.json`
    - `py/pyproject.toml`
    - `cdk/package.json`
  - Existing repo docs contract material:
    - `docs/README.md`
    - `docs/getting-started.md`
    - `docs/api-reference.md`
    - `docs/core-patterns.md`
    - `docs/testing-guide.md`
    - `docs/troubleshooting.md`
    - `docs/migration-guide.md`
    - `docs/development-guidelines.md`
    - `docs/_concepts.yaml`
    - `docs/_patterns.yaml`
    - `docs/_decisions.yaml`
  - Public API source-of-truth assets:
    - `api-snapshots/go.txt`
    - `api-snapshots/ts.txt`
    - `api-snapshots/py.txt`
  - Package-specific official docs routers:
    - `ts/docs/README.md`
    - `py/docs/README.md`
    - `cdk/docs/README.md`
  - Migration and compatibility sources:
    - `docs/migration/from-lift.md`
    - `docs/migration-guide.md`
  - Normative contract source explicitly named by official package docs:
    - `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`
- Goal: adapt or expand the repository docs to match the fixed KnowledgeTheory-ready contract without inventing undocumented behavior, while preserving grounded repo material that already exists.

## Example Outputs

These examples show the target contract shape. They are not applied automatically.

| Target docs path | Example path | Suggested local action | Notes |
|------------------|--------------|------------------------|-------|
| `docs/README.md` | `gov-infra/planning/docs-init-examples/README.md` | adapt | Keep current repo-specific links and package-domain pointers, but normalize the fixed contract summary and link set. |
| `docs/_contract.yaml` | `gov-infra/planning/docs-init-examples/_contract.yaml` | create | Missing today; create using the exact contract shape required by this action. |
| `docs/_concepts.yaml` | `gov-infra/planning/docs-init-examples/_concepts.yaml` | adapt | Existing file is rich and repo-grounded; adapt it to align with the fixed contract and canonical sources. |
| `docs/_patterns.yaml` | `gov-infra/planning/docs-init-examples/_patterns.yaml` | adapt | Existing file already contains strong repo-grounded patterns; preserve and normalize. |
| `docs/_decisions.yaml` | `gov-infra/planning/docs-init-examples/_decisions.yaml` | expand | Existing file is useful but narrow; expand it to cover adoption, entrypoint choice, and migration guidance. |
| `docs/getting-started.md` | `gov-infra/planning/docs-init-examples/getting-started.md` | adapt | Keep the grounded multi-runtime prerequisites and first deterministic workflow. |
| `docs/api-reference.md` | `gov-infra/planning/docs-init-examples/api-reference.md` | adapt | Keep snapshot-backed source references and confirmed interface summaries. |
| `docs/core-patterns.md` | `gov-infra/planning/docs-init-examples/core-patterns.md` | adapt | Preserve current parity, header, dispatch, and generated-artifact patterns with explicit `CORRECT` and `INCORRECT` framing. |
| `docs/development-guidelines.md` | `gov-infra/planning/docs-init-examples/development-guidelines.md` | adapt | Existing file is close; make the contract-only posture explicit and keep maintainer guidance narrow. |
| `docs/testing-guide.md` | `gov-infra/planning/docs-init-examples/testing-guide.md` | adapt | Keep Makefile-backed verification commands and clarify TODO gaps where Python-specific test commands remain unconfirmed. |
| `docs/troubleshooting.md` | `gov-infra/planning/docs-init-examples/troubleshooting.md` | adapt | Preserve current version-alignment, TypeScript build, and header-normalization fixes. |
| `docs/migration-guide.md` | `gov-infra/planning/docs-init-examples/migration-guide.md` | adapt | Keep it as the overview and point detailed migration work into sanctioned optional `docs/migration/**`. |

Sanctioned optional surfaces:
- `docs/migration/**`: keep and expand; existing `docs/migration/from-lift.md` is grounded and should remain the detailed migration source.
- `docs/llm-faq/**`: create only if repeated assistant-facing or user-facing questions require stable, user-safe answers backed by current docs.
- `docs/cdk/**`: `UNKNOWN:` the sanctioned root optional surface is absent today, while official CDK package docs live under `cdk/docs/README.md`; only create a repo-level `docs/cdk/**` bridge if repo owners need root-doc operator guidance beyond the package docs domain.

## Local Agent Apply Steps

1. Treat this package as **guide-only**. Do not modify docs/ directly from this action. Use the examples under `gov-infra/planning/docs-init-examples/` as the target shape for local application.
2. Start with the fixed files already present in `docs/` and preserve grounded material wherever possible:
   - adapt `docs/README.md`
   - adapt `docs/_concepts.yaml`
   - adapt `docs/_patterns.yaml`
   - expand `docs/_decisions.yaml`
   - adapt `docs/getting-started.md`
   - adapt `docs/api-reference.md`
   - adapt `docs/core-patterns.md`
   - adapt `docs/development-guidelines.md`
   - adapt `docs/testing-guide.md`
   - adapt `docs/troubleshooting.md`
   - adapt `docs/migration-guide.md`
3. Create `docs/_contract.yaml` from the example and keep its shape exactly aligned with the server-required contract.
4. Use these canonical sources while applying changes:
   - runtime/toolchains and distribution posture: `README.md`, `go.mod`, `VERSION`, `Makefile`, `ts/package.json`, `py/pyproject.toml`, `cdk/package.json`
   - public API confirmation: `api-snapshots/go.txt`, `api-snapshots/ts.txt`, `api-snapshots/py.txt`
   - package-domain context: `ts/docs/README.md`, `py/docs/README.md`, `cdk/docs/README.md`
   - migration source: `docs/migration/from-lift.md`
   - normative contract note explicitly referenced by package docs: `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`
5. Keep examples first. Where the current repo already has a runnable example or real command, prefer that over abstraction.
6. Keep explicit context. Mark preferred paths as `CORRECT` and rejected paths as `INCORRECT`, especially for:
   - snapshot-backed API documentation
   - universal Lambda dispatch vs hand-rolled event branching
   - lowercase output header expectations
   - generated-artifact and version-alignment workflows
7. Use `TODO:` or `UNKNOWN:` for gaps instead of guessing. Current bounded-discovery gaps that should remain explicit until confirmed:
   - `TODO:` exact release asset filenames for every TypeScript and Python install command
   - `TODO:` complete environment-variable inventory across the public surfaces
   - `TODO:` preferred Python unit/integration test command beyond the confirmed manifest/build metadata
   - `UNKNOWN:` whether repo owners want a root sanctioned optional `docs/cdk/**` bridge in addition to the existing `cdk/docs/` package domain
8. Keep specialized user-facing material grounded. Existing top-level docs like MCP, sanitization, and jobs-ledger content may remain if repo owners want them, but they must not replace the fixed contract files. If a fixed file becomes overloaded, split detailed migration material into `docs/migration/**` and consider a sanctioned `docs/cdk/**` bridge only when clearly needed.
9. Move or strip maintainer-only planning/process material out of ingestible docs if encountered during local apply. Do not route readers from ingestible docs into `docs/development/**`, `docs/planning/**`, or `docs/archive/**`.
10. After local apply, verify the fixed docs index links every required file and that machine-readable YAML roots remain stable for AI parsing.

## Review Checklist

- The guide remains guide-only and includes the literal phrase `Do not modify docs/ directly`.
- The selected documentation domains are named explicitly.
- The canonical sources consulted for each domain are listed explicitly.
- Every target docs path is mapped to an example path under `gov-infra/planning/docs-init-examples/`.
- `docs/README.md` example links to every generated example file.
- `docs/getting-started.md` example includes prerequisites, installation, and verification.
- `docs/core-patterns.md` example contains both `CORRECT` and `INCORRECT`.
- `docs/development-guidelines.md` example explicitly states that it is contract-only.
- `docs/troubleshooting.md` example includes a quick diagnosis section and concrete issue/fix guidance.
- `docs/migration-guide.md` example does not point readers to `docs/development/**`, `docs/planning/**`, or `docs/archive/**`.
- Machine-readable examples use the required top-level roots:
  - `_contract.yaml` -> `contract:`
  - `_concepts.yaml` -> `concepts:`
  - `_patterns.yaml` -> `patterns:`
  - `_decisions.yaml` -> `decisions:`
- No example file contains unresolved template markers such as `{{...}}`.
- Ingestible examples avoid links to out-of-scope paths.

## Publish Notes

- AppTheory is a multi-language monorepo. The repo-level docs contract should acknowledge Go, TypeScript, Python, and CDK package domains without collapsing them into a single language-specific story.
- The safest public API documentation source is `api-snapshots/`; treat snapshot drift as a docs update trigger, not just a release-engineering detail.
- Existing docs already contain strong repo-grounded material. Prefer adapt/expand over wholesale replacement so business context, migration posture, and troubleshooting knowledge are preserved.
- Keep `docs/migration/from-lift.md` as the detailed migration source under the sanctioned optional migration surface.
- If repo owners later add assistant-focused FAQ content, keep it under `docs/llm-faq/**` and ground every answer in currently supported behavior.
- If repo owners later decide that root-level operator-facing CDK guidance is needed, create a narrow `docs/cdk/**` bridge from current package docs rather than duplicating the full `cdk/docs/` package manual.
