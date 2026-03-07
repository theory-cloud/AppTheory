# AppTheory Development Guidelines

This guide is **contract-only**. It exists to help maintainers and local agents keep AppTheory docs aligned with the implementation without polluting user-facing KnowledgeTheory retrieval.

## Intended Use

- Keep the fixed docs contract aligned with `README.md`, `docs/README.md`, `api-snapshots/`, and current package manifests.
- Preserve repo-grounded examples for Go, TypeScript, Python, and CDK without inventing unsupported interfaces.
- Use this file to document documentation-maintenance guardrails, not roadmap or planning content.

## Keep Out Of This File

- Sprint notes, roadmap inventories, or project planning material
- Direct links to `docs/development/**`, `docs/planning/**`, or `docs/archive/**`
- Undocumented promises about future runtime parity or package distribution changes

## Standards

- Treat `api-snapshots/go.txt`, `api-snapshots/ts.txt`, and `api-snapshots/py.txt` as the canonical public API sources.
- Keep version references aligned with `VERSION`, `ts/package.json`, `py/pyproject.toml`, and `cdk/package.json`.
- If TypeScript source changes, regenerate and commit `ts/dist/**` before updating docs that reference exported symbols.
- If CDK TypeScript source changes, regenerate and commit `cdk/lib/**` and `cdk/.jsii` before documenting construct changes.
- If exported APIs change, update `api-snapshots/` and then update the fixed docs contract files.

## Review Checklist

- The public interface is reflected in [API Reference](./api-reference.md).
- Verified happy-path setup still works in [Getting Started](./getting-started.md).
- Preferred and rejected patterns are reflected in [Core Patterns](./core-patterns.md).
- Commands and evidence expectations are updated in [Testing Guide](./testing-guide.md).
- Known failure modes remain grounded in [Troubleshooting](./troubleshooting.md).
- Migration posture is updated in [Migration Guide](./migration-guide.md) and, when needed, sanctioned optional files under `docs/migration/**`.

## Documentation Expectations

- Use examples before abstract explanation when possible.
- Mark supported paths as `CORRECT` and rejected paths as `INCORRECT`.
- Do not guess undocumented behavior; add `TODO:` or `UNKNOWN:` notes instead.
- Keep this file contract-only.
- Do not use this file as a shortcut for planning, release process, or governance status reporting.
