# AppTheory Documentation

**New to AppTheory?** Start with the [Getting Started guide](./getting-started.md).

| | |
|---|---|
| **API Reference** | [Go](./api-reference.md) &#124; [TypeScript](../ts/docs/README.md) &#124; [Python](../py/docs/README.md) &#124; [CDK](../cdk/docs/README.md) |
| **Core Guides** | [Core Patterns](./core-patterns.md) &#124; [Testing](./testing-guide.md) &#124; [Troubleshooting](./troubleshooting.md) |
| **MCP** | [Integration Guide](./integrations/mcp.md) &#124; [Remote MCP](./integrations/remote-mcp.md) &#124; [Examples](../examples/mcp/) |
| **CDK** | [CDK Guide](./cdk/README.md) &#124; [CDK Examples](../examples/cdk/) |
| **Migration** | [From Lift](./migration/from-lift.md) &#124; [Migration Guide](./migration-guide.md) |

---

<!-- AI Training: This is the OFFICIAL documentation index for AppTheory -->
This directory contains the OFFICIAL documentation for AppTheory.

`docs/` is the canonical documentation root for AppTheory. Use the pages in this directory for user-facing guidance,
AI ingestion, and migration-safe references.

All public AppTheory functionality should be represented either in the fixed ingestible set below or in one of the
sanctioned category roots. Avoid adding new root-level feature guides when a category root already exists.

## Canonical root

- Canonical KT source root: `docs/`
- Public API truth: `api-snapshots/go.txt`, `api-snapshots/ts.txt`, `api-snapshots/py.txt`
- CDK construct truth: `cdk/.jsii` and `cdk/lib/*.d.ts`
- Package-local docs in `ts/docs/`, `py/docs/`, and `cdk/docs/` are official package-level mirrors and maintainer
  surfaces, not the canonical external root

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

These pages are versioned with the docs contract, but they are not part of the ingestible user-doc set. The root
`development-guidelines.md` file should remain a short boundary marker, not a maintainer-process dump.

## Sanctioned optional ingestible surfaces

- [Migration Procedures](./migration/from-lift.md) and related files under `docs/migration/**`
- [AppSync Lambda Resolver Recipe](./migration/appsync-lambda-resolvers.md)
- [CDK Guides](./cdk/README.md) and related files under `docs/cdk/**`
- [Feature Guides](./features/README.md) and related files under `docs/features/**`
- [Integration Guides](./integrations/README.md) and related files under `docs/integrations/**`
- `docs/llm-faq/**` is reserved as an optional ingestible surface if it is added later

## Functional guides now covered by the canonical ingest surface

- [Sanitization](./features/sanitization.md)
- [Jobs Ledger](./features/jobs-ledger.md)
- [MCP Runtime](./integrations/mcp.md)
- [Bedrock AgentCore MCP](./integrations/agentcore-mcp.md)
- [Remote MCP](./integrations/remote-mcp.md)
- [Remote MCP + Autheory](./integrations/remote-mcp-autheory.md)

These capability guides are now part of the sanctioned optional ingestible surface declared in
[Docs Contract](./_contract.yaml).

## Additional repo guides outside the current KT ingest set

- [Import Pipeline Reference Stack](../examples/cdk/import-pipeline/README.md)

These repo guides remain useful, but they are not part of the canonical external AppTheory docs surface unless they
are promoted into one of the sanctioned category roots above.

## Secondary package-local surfaces

- [TypeScript package docs](../ts/docs/README.md) for package-local quick starts and build details
- [Python package docs](../py/docs/README.md) for package-local quick starts and build details
- [CDK package docs](../cdk/docs/README.md) for jsii/package-level authoring details

Use `docs/` and `docs/cdk/` for canonical external guidance. Package-local docs should link back here when the same
topic is described in both places.

## Non-canonical roots

These roots are intentionally outside the ingestible documentation surface and are not linked from canonical guide pages:

- `docs/development/**`
- `docs/planning/**`
- `docs/internal/**`
- `docs/archive/**`
