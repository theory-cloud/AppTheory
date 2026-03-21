# AppTheory Integration Guides

These pages cover public integration surfaces and deployment shapes built on top of the core AppTheory runtime.

Use this section when you need canonical guidance for MCP, OAuth-adjacent flows, or platform-specific external
integration patterns.

## Current integration guides

- [MCP Runtime](./mcp.md)
- [Bedrock AgentCore MCP](./agentcore-mcp.md)
- [Claude Remote MCP](./remote-mcp.md)
- [Remote MCP + Autheory](./remote-mcp-autheory.md)
- [CDK MCP Constructs](../cdk/README.md)

## Boundary

Keep public integration-specific guides under `docs/integrations/**` or `docs/cdk/**` so KnowledgeTheory can ingest
them as stable category roots. Example apps may live elsewhere, but these directories are the canonical external
integration-doc surfaces.
