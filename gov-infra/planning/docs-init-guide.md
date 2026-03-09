# AppTheory Docs Init Guide

Generated: 2026-03-09

## Purpose

This is a **guide-only** docs initialization package for AppTheory.

**Do not modify docs/ directly** in this action. A local agent should apply/adapt the example files under `gov-infra/planning/docs-init-examples/`.

Selected documentation domains:
1. Runtime/user docs (`docs/*.md` + YAML triad)
2. Public API snapshots (`api-snapshots/*`)
3. Toolchain + verification surface (`go.mod`, `Makefile`, package manifests, `VERSION`, `scripts/*`)
4. Migration/compatibility docs (`docs/migration-guide.md`, `docs/migration/**`)
5. Package docs routers (`ts/docs/README.md`, `py/docs/README.md`, `cdk/docs/README.md`)

Canonical sources consulted by domain:
- Runtime docs: `README.md`, `docs/README.md`, `docs/getting-started.md`, `docs/api-reference.md`, `docs/core-patterns.md`, `docs/testing-guide.md`, `docs/troubleshooting.md`, `docs/migration-guide.md`, `docs/development-guidelines.md`, `docs/sanitization.md`, `docs/jobs-ledger.md`, `docs/agentcore-mcp.md`, `docs/mcp.md`, `docs/remote-mcp.md`, `docs/remote-mcp-autheory.md`
- API contracts: `docs/api-reference.md`, `api-snapshots/go.txt`, `api-snapshots/ts.txt`, `api-snapshots/py.txt`
- Toolchains/verification: `go.mod`, `Makefile`, `VERSION`, `ts/package.json`, `py/pyproject.toml`, `cdk/package.json`, `scripts/verify-version-alignment.sh`, `scripts/update-api-snapshots.sh`, `scripts/verify-contract-tests.sh`
- Migration sources: `docs/migration-guide.md`, `docs/migration/from-lift.md`
- Language docs routers: `ts/docs/README.md`, `py/docs/README.md`, `cdk/docs/README.md`

External/public surfaces identified:
- App container + routing/middleware APIs across Go/TypeScript/Python
- AWS adapter entrypoints (APIGW v2, Lambda Function URL, and documented event-shape dispatch)
- Universal Lambda dispatcher (`HandleLambda` / `handleLambda` / `handle_lambda`)
- Drift gates via `api-snapshots/*`
- Version alignment and build/test gates via manifests, `Makefile`, and `scripts/*`

## Example Outputs

| Target docs path | Example path | Suggested local action | Notes |
|---|---|---|---|
| `docs/README.md` | `gov-infra/planning/docs-init-examples/README.md` | adapt | Keep current index strengths; ensure full contract summary + required links, and preserve repo-specific guides already linked from the AppTheory docs index. |
| `docs/_contract.yaml` | `gov-infra/planning/docs-init-examples/_contract.yaml` | create | Missing in repo; create using the fixed contract shape exactly. |
| `docs/_concepts.yaml` | `gov-infra/planning/docs-init-examples/_concepts.yaml` | adapt | Preserve repo-specific concepts, align with canonical sources. |
| `docs/_patterns.yaml` | `gov-infra/planning/docs-init-examples/_patterns.yaml` | adapt | Keep concrete CORRECT/INCORRECT guidance tied to real commands. |
| `docs/_decisions.yaml` | `gov-infra/planning/docs-init-examples/_decisions.yaml` | adapt | Keep decision trees grounded in snapshots/manifests/scripts. |
| `docs/getting-started.md` | `gov-infra/planning/docs-init-examples/getting-started.md` | adapt | Must include prerequisites, installation, and verification. |
| `docs/api-reference.md` | `gov-infra/planning/docs-init-examples/api-reference.md` | adapt | Keep snapshot-first source-of-truth policy. |
| `docs/core-patterns.md` | `gov-infra/planning/docs-init-examples/core-patterns.md` | adapt | Preserve explicit `CORRECT` and `INCORRECT` sections. |
| `docs/development-guidelines.md` | `gov-infra/planning/docs-init-examples/development-guidelines.md` | adapt | Must remain contract-only maintainer guidance. |
| `docs/testing-guide.md` | `gov-infra/planning/docs-init-examples/testing-guide.md` | expand | Add deterministic verification and evidence expectations. |
| `docs/troubleshooting.md` | `gov-infra/planning/docs-init-examples/troubleshooting.md` | expand | Keep quick diagnosis + concrete symptom/cause/fix/verification entries. |
| `docs/migration-guide.md` | `gov-infra/planning/docs-init-examples/migration-guide.md` | adapt | Keep user-facing migration path; avoid out-of-scope links. |

Optional surfaces:
- `docs/migration/**`: keep/expand existing migration leaf docs (`docs/migration/from-lift.md`, `docs/migration/g4-representative-migration.md`, `docs/migration/lift-deprecation.md`).
- `docs/llm-faq/**`: do not create in this cycle unless an evidence-backed FAQ set is identified.
- `docs/cdk/**`: do not materialize a root `docs/cdk/**` tree in this cycle; keep CDK operator docs in `cdk/docs/**` and repo-level operator guides in `docs/*.md`.

## Local Agent Apply Steps

1. Copy/adapt each example file into its mapped `docs/` target.
2. Apply action intent per file: keep, adapt, expand, create, and for optional surfaces split/move when needed.
3. Keep every claim grounded in canonical sources (`api-snapshots/*`, manifests, `Makefile`, scripts, existing docs).
4. Preserve required conventions:
   - examples first
   - explicit `CORRECT` / `INCORRECT`
   - machine-readable YAML roots: `contract`, `concepts`, `patterns`, `decisions`
   - troubleshooting and migration content in problem → solution framing
5. If detail is unconfirmed, keep explicit `TODO:` / `UNKNOWN:` text (do not invent behavior).
6. Ensure ingestible docs do not link to `docs/development/**`, `docs/planning/**`, or `docs/archive/**`.

## Review Checklist

- All required target docs paths are mapped and applied.
- `docs/_contract.yaml` matches the fixed required shape exactly.
- `docs/README.md` links to every fixed docs file.
- `docs/README.md` preserves current AppTheory-specific official docs links that remain in scope.
- `docs/getting-started.md` includes prerequisites, installation, and verification.
- `docs/core-patterns.md` includes both `CORRECT` and `INCORRECT`.
- `docs/development-guidelines.md` explicitly states contract-only scope.
- `docs/troubleshooting.md` has quick diagnosis and concrete issue/fix entries.
- `docs/migration-guide.md` stays user-facing and avoids forbidden link targets.
- Unknowns are marked as `TODO:` / `UNKNOWN:` and not guessed.

## Publish Notes

- This action only prepares planning-side examples under `gov-infra/planning/`.
- Prefer adapting strong existing AppTheory docs over wholesale replacement.
- The current docs index already carries AppTheory-specific official guides such as `docs/sanitization.md`, `docs/jobs-ledger.md`, `docs/agentcore-mcp.md`, and `docs/mcp.md`; keep them when adapting `docs/README.md` unless they are intentionally retired.
- `docs/llm-faq/**` is deferred for this cycle because no evidence-backed FAQ surface was identified in reviewed canonical docs.
- Keep CDK operator material in `cdk/docs/**`; a root `docs/cdk/**` tree is not required for this cycle.
- No explicit migration rollback runbook was found in `docs/migration-guide.md` or `docs/migration/**`; preserve that gap explicitly if migration docs are regenerated.
