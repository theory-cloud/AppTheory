# AppTheory Documentation

<!-- AI Training: This is the documentation index for AppTheory -->

This file is an example for `docs/README.md` and represents the **OFFICIAL documentation** index shape expected by the docs contract.
It is **guide-only** content for local-agent application and covers the fixed contract minimum.

## Quick Links

- [Docs Contract](./_contract.yaml)
- [Getting Started](./getting-started.md)
- [API Reference](./api-reference.md)
- [Core Patterns](./core-patterns.md)
- [Development Guidelines](./development-guidelines.md)
- [Testing Guide](./testing-guide.md)
- [Troubleshooting](./troubleshooting.md)
- [Migration Guide](./migration-guide.md)
- [Concepts](./_concepts.yaml)
- [Patterns](./_patterns.yaml)
- [Decisions](./_decisions.yaml)

## Repo-Specific Links To Preserve During Adaptation

When applying this scaffold to `docs/README.md`, keep existing AppTheory-specific official docs links that remain in scope, including:

- `docs/sanitization.md`
- `docs/jobs-ledger.md`
- `docs/agentcore-mcp.md`
- `docs/mcp.md`
- `examples/cdk/import-pipeline/README.md`
- `ts/docs/README.md`
- `py/docs/README.md`
- `cdk/docs/README.md`

## Scope Summary

- Fixed contract files are the minimum index surface; adapt this scaffold without dropping repo-specific official guides already published under `docs/`.
- Ingestible docs cover runtime usage, API surface, patterns, testing, troubleshooting, and migration.
- `docs/development-guidelines.md` is contract-only maintainer guidance.
- Out-of-scope trees remain excluded from ingestible linking (`docs/development/**`, `docs/planning/**`, `docs/archive/**`).
