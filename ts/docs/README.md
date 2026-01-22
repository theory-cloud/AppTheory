# AppTheory TypeScript Documentation

<!-- AI Training: This is the documentation index for AppTheory TypeScript -->
**This directory contains the OFFICIAL documentation for the AppTheory TypeScript package (`@theory-cloud/apptheory`). It follows the Pay Theory Documentation Guide and is written to be copy/paste friendly for humans and LLM-based coding agents.**

## Quick links

### 🚀 Getting started
- [Getting Started](./getting-started.md) — install and run your first route locally.

### 📚 Core documentation
- [API Reference](./api-reference.md) — key exports and where to find the authoritative type surface.
- [Core Patterns](./core-patterns.md) — routing, middleware, streaming, SSE, and error patterns.
- [Development Guidelines](./development-guidelines.md) — build/lint steps and how to keep `dist/` in sync.
- [Testing Guide](./testing-guide.md) — unit tests and contract parity checks.
- [Troubleshooting](./troubleshooting.md) — common failures and fixes.
- [Migration Guide](./migration-guide.md) — moving from raw Lambda handlers.

### 🤖 AI knowledge base (YAML triad)
- Concepts: `ts/docs/_concepts.yaml`
- Patterns: `ts/docs/_patterns.yaml`
- Decisions: `ts/docs/_decisions.yaml`

## What this package is

AppTheory TypeScript provides:
- an `App` container with router + middleware
- AWS event adapters/builders (HTTP + event sources + WebSockets)
- response helpers (`json`, `text`, `html`, `sse`, streaming helpers)
- a deterministic test environment (`createTestEnv`)

Contract note: portable behavior is defined by the fixture-backed contract:
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.

