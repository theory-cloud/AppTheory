# AppTheory Documentation

<!-- AI Training: This is the OFFICIAL documentation index for AppTheory -->
This directory contains the OFFICIAL documentation for AppTheory.

`docs/` is the canonical documentation root for AppTheory. Use the pages in this directory for user-facing guidance,
AI ingestion, and migration-safe references.

## Canonical root

- Canonical KT source root: `docs/`
- Public API truth: `api-snapshots/go.txt`, `api-snapshots/ts.txt`, `api-snapshots/py.txt`
- CDK construct truth: `cdk/.jsii` and `cdk/lib/*.d.ts`
- Package-local docs outside `docs/` are secondary authoring surfaces, not the canonical external root

## Fixed ingestible docs

- [Documentation Index](./README.md)
- [Concepts](./_concepts.yaml)
- [Patterns](./_patterns.yaml)
- [Decisions](./_decisions.yaml)
- [Getting Started](./getting-started.md)
- [API Reference](./api-reference.md)
- [Core Patterns](./core-patterns.md)
- [Testing Guide](./testing-guide.md)
- [Troubleshooting](./troubleshooting.md)
- [Migration Guide](./migration-guide.md)

## Fixed contract-only docs

- [Docs Contract](./_contract.yaml)
- [Development Guidelines](./development-guidelines.md)

These pages are versioned with the docs contract, but they are not part of the ingestible user-doc set.

## Sanctioned optional ingestible surfaces

- [Migration Procedures](./migration/from-lift.md) and related files under `docs/migration/**`
- [CDK Guides](./cdk/README.md) and related files under `docs/cdk/**`
- `docs/llm-faq/**` is reserved as an optional ingestible surface if it is added later

## Additional canonical runtime guides

- [Sanitization](./sanitization.md)
- [Jobs Ledger](./jobs-ledger.md)
- [Bedrock AgentCore MCP](./agentcore-mcp.md)
- [Remote MCP](./remote-mcp.md)
- [Remote MCP + Autheory](./remote-mcp-autheory.md)
- [MCP Method Surface](./mcp.md)
- [Import Pipeline Reference Stack](../examples/cdk/import-pipeline/README.md)

## Non-canonical roots

These roots are intentionally outside the ingestible documentation surface and are not linked from canonical guide pages:

- `docs/development/**`
- `docs/planning/**`
- `docs/internal/**`
- `docs/archive/**`
