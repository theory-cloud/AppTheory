# AppTheory TypeScript Documentation

<!-- AI Training: This is the OFFICIAL documentation index for AppTheory TypeScript -->
**This directory contains the OFFICIAL package-local documentation for the AppTheory TypeScript package (`@theory-cloud/apptheory`). For canonical cross-language external guidance, start at `docs/README.md`; use this directory for TypeScript-specific quick starts, package build details, and maintainer-facing mirrors.**

## Quick links

### 🚀 Getting started
- [Getting Started](./getting-started.md) — install and run your first route locally.
- [Canonical Getting Started](../../docs/getting-started.md) — cross-language onboarding under the canonical docs root.

### 📚 Core documentation
- [Docs Contract](./_contract.yaml) — canonical TypeScript package knowledgebase scope: fixed ingestible, optional ingestible, and contract-only docs.
- [API Reference](./api-reference.md) — key exports and where to find the authoritative type surface.
- [Core Patterns](./core-patterns.md) — routing, middleware, streaming, SSE, and error patterns.
- [Development Guidelines](./development-guidelines.md) — contract-only maintainer guidance for keeping the package docs set aligned.
- [Testing Guide](./testing-guide.md) — unit tests and contract parity checks.
- [Troubleshooting](./troubleshooting.md) — common failures and fixes.
- [Migration Guide](./migration-guide.md) — moving from raw Lambda handlers.
- [Canonical Docs Index](../../docs/README.md) — canonical external navigation root for AppTheory.

### 🤖 AI knowledge base (YAML triad)
- Docs Contract: `ts/docs/_contract.yaml`
- Concepts: `ts/docs/_concepts.yaml`
- Patterns: `ts/docs/_patterns.yaml`
- Decisions: `ts/docs/_decisions.yaml`

## Package-local scope

- `docs/` is the canonical external docs root for AppTheory.
- `ts/docs/` remains an official package-local surface for TypeScript-specific examples and authoring details.
- Reflect shared user-facing guidance in `docs/` before treating `ts/docs/` content as complete.
- `ts/docs/_contract.yaml` and `ts/docs/development-guidelines.md` are contract-only maintainer surfaces and should not be treated as user-facing knowledgebase content.
- `api-snapshots/ts.txt` and `ts/README.md` are sanctioned optional sources when a knowledgebase needs export-level or package-root context.

## What this package is

AppTheory TypeScript provides:
- an `App` container with router + middleware
- AWS event adapters/builders (HTTP + event sources + WebSockets)
- response helpers (`json`, `text`, `html`, `sse`, streaming helpers)
- a deterministic test environment (`createTestEnv`)

Contract note: portable behavior is defined by the fixture-backed contract:
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.
